const { app, BrowserWindow, ipcMain, net, shell, dialog, nativeImage, safeStorage, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const crypto = require('crypto')
const https = require('https') // 阶段0修复⑧：nodeFetchJson 使用 https.request 但此前未声明，Node 回退栈一旦被触发即 ReferenceError

/* 1.2.1 跨平台：Windows / macOS 的差异集中在这几个常量与 helper，
   其它地方不再出现平台判断，避免路径/可执行文件散落在业务代码里 */
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const EXE = IS_WIN ? '.exe' : ''
/* file:// URL → 本地绝对路径：必须交给 Node 处理（Windows 盘符、macOS 前导 /、
   百分号编码都由它兜）。旧实现手写 slice(8) 再 replace(/\//g,'\\')，在 mac 上会把
   /Users/... 变成相对路径 \Users\...，导致资产复制/缩略图整条链失效。 */
const { fileURLToPath: nodeFileUrlToPath } = require('url')
const toLocalPath = (u) => {
  const s = String(u || '')
  try {
    return nodeFileUrlToPath(s)
  } catch {
    // 极少数历史数据里的不完全合法 URL：退化为手工解码，Windows 还原盘符冒号
    const raw = decodeURIComponent(s.replace(/^file:\/\//, ''))
    return IS_WIN ? raw.replace(/^\//, '').replace(/\//g, '\\') : raw
  }
}


// 强制 Chromium 直连：APIMart 备用镜像均为大陆直连地址，
// 走系统代理（Clash 等）反而可能被规则路由到不可用节点导致 ERR_CONNECTION_CLOSED
app.commandLine.appendSwitch('no-proxy-server')
app.commandLine.appendSwitch('disable-features', 'AsyncDns')

/* ---------- E-1 单实例锁 ----------
   同一份数据目录只允许一个进程：重复启动（双击两次 / 安装后自动运行叠加手动启动 /
   快捷方式连点）会各开一个独立窗口，关掉其中一个时另一个仍在，表现就是
   「关掉了它又自己冒出来」。拿到锁失败 → 立即退出，并把已有窗口唤到前台。
   锁跟随 userData 目录，不同数据目录的测试实例互不影响。 */
const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) app.exit(0)
if (singleInstanceLock) {
  app.on('second-instance', () => {
    try { debugLog('APP second-instance → focus existing window') } catch (_) {}
    const wins = BrowserWindow.getAllWindows()
    if (!wins.length) { try { createWindow() } catch (_) { /* 尚未就绪时忽略 */ } return }
    const w = wins[wins.length - 1]
    if (w.isMinimized()) w.restore()
    if (!w.isVisible()) w.show()
    w.focus()
  })
}

/* ---------- 数据家目录（Data Home）：程序与用户数据彻底解耦 ----------
   解析优先级见 electron/dataHome.cjs：命令行 --user-data-dir > 指针文件 >
   ISLE_USER_DATA > 安装目录同级 IsleStudio-data > %APPDATA%\Isle Studio Release。
   安装目录里只有程序文件，项目/生成物/资产/模板/API Key 全在 Data Home，
   因此「升级覆盖安装同一目录」不会碰到任何用户数据，新版本启动即接着用。
   首次解析到位置后写入 %APPDATA%\IsleStudio\data-home.json 作为永久指针：
   之后装到任何目录、任何版本、便携版，都指向同一份数据。 */
const dataHome = require('./dataHome.cjs')

const appDataDir = app.getPath('appData')
const dataHomeResolved = dataHome.resolveDataHome({
  isPackaged: app.isPackaged,
  appData: appDataDir,
  argv: process.argv,
  env: process.env,
  installDir: app.isPackaged ? path.dirname(process.execPath) : '',
  exePath: process.execPath
})
/* 绑定指针：仅安装版、非命令行指定、且指针有效时落盘（一次性，之后永不再改） */
try {
  if (app.isPackaged && dataHomeResolved.dir && dataHomeResolved.source !== 'cli' && !dataHomeResolved.stale) {
    if (!dataHome.readPointer(appDataDir) || !dataHome.samePath(dataHome.readPointer(appDataDir)?.dir, dataHomeResolved.dir)) {
      dataHome.writePointer(appDataDir, dataHomeResolved.dir, { source: dataHomeResolved.source })
    }
  }
} catch (_) { /* 指针写入失败不阻塞启动 */ }
if (dataHomeResolved.dir) {
  try {
    app.setPath('userData', dataHomeResolved.dir)
  } catch (_) { /* 非法路径退回默认目录，不阻塞启动 */ }
}

/* 首启接入旧数据（v1.1.2 升级架构）：
   - 已有数据的老用户升级：只补/升级 .data-schema.json，绝不覆盖任何文件；
   - 全新安装：按候选源（上一版安装数据 / 开发数据 / 早期版本 / 程序目录内 data）
     从新到旧探测，命中则询问「接入旧数据 / 全新开始」，接入为复制（旧目录保留）；
   - 配置里的 API Key 依赖 safeStorage 的 os_crypt key，接入时一并移植并重启一次。 */
async function maybeMigrateUserData() {
  const testMode = process.env.ISLE_MIGRATION_TEST === '1'
  if (!app.isPackaged && !testMode) {
    /* 开发实例也维护 schema 标记：保证结构升级逻辑在开发/安装两套环境一致 */
    try {
      const home = app.getPath('userData')
      if (dataHome.hasCoreData(home) && !dataHome.readSchema(home)) {
        dataHome.writeSchema(home, app.getVersion(), { adoptedFrom: null })
      }
    } catch (_) {}
    return
  }
  try {
    /* 演练模式用独立目录，绝不碰真实数据 */
    if (testMode) app.setPath('userData', path.join(app.getPath('appData'), 'Isle Studio Release-Test'))
    const home = path.resolve(app.getPath('userData'))
    fs.mkdirSync(home, { recursive: true })

    /* ① 已有数据 → 只做 schema 版本对齐（老用户升级安装走这条） */
    if (dataHome.hasCoreData(home) || dataHome.readSchema(home)) {
      const up = dataHome.upgradeSchema(home, app.getVersion())
      debugLog(`DATA home=${home} schema=${up.schema}${up.steps.length ? ` upgraded:${up.from}->${up.schema}` : ' (existing)'}`)
      return
    }
    if (fs.existsSync(path.join(home, '.migration-done'))) return

    /* ② 全新安装 → 找可接入的旧数据 */
    const installDir = app.isPackaged ? path.dirname(app.getPath('exe')) : ''
    let candidates = []
    if (testMode) {
      const forced = (process.env.ISLE_MIGRATION_FROM || '').trim()
      if (forced && dataHome.hasCoreData(forced)) candidates = [{ label: '指定测试源', dir: path.resolve(forced) }]
    } else {
      candidates = dataHome.findCandidates({ appData: app.getPath('appData'), dataHome: home, installDir })
    }

    if (!candidates.length) {
      dataHome.writeSchema(home, app.getVersion(), { adoptedFrom: null })
      debugLog(`DATA home=${home} fresh (no adoptable data)`)
      return
    }

    const best = candidates[0]
    let choice = 0
    if (process.env.ISLE_MIGRATION_AUTO === 'migrate') choice = 0
    else if (process.env.ISLE_MIGRATION_AUTO === 'skip') choice = 1
    else {
      choice = dialog.showMessageBoxSync({
        type: 'question',
        title: '接入旧数据',
        message: `检测到可接入的旧数据：${best.label}`,
        detail: `${best.dir}\n\n「接入旧数据」会把项目、生成物、资产库、模板、模型配置与 API Key 复制到当前版本，旧目录原样保留可回退；「全新开始」不接入，直接使用空白状态。之后升级安装新版本时会自动沿用这份数据。`,
        buttons: ['接入旧数据', '全新开始'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
    }

    if (choice === 0) {
      const r = dataHome.adopt(best.dir, home, app.getVersion())
      debugLog(`DATA adopt ${best.dir} -> ${home} (${r.copied.join(', ') || 'none'}) key=${r.keyPorted}`)
      fs.writeFileSync(path.join(home, '.migration-done'), new Date().toISOString())
      if (r.keyPorted) {
        /* 加密 key 需在启动期加载，移植后重启一次才能解开旧 API Key */
        app.relaunch()
        app.exit(0)
        return
      }
    } else {
      dataHome.writeSchema(home, app.getVersion(), { adoptedFrom: null, skippedFrom: best.dir })
      fs.writeFileSync(path.join(home, '.migration-done'), new Date().toISOString())
      debugLog(`DATA skip adopt (fresh) candidate=${best.dir}`)
    }
  } catch (err) {
    debugLog(`DATA FAIL: ${String(err).slice(0, 200)}`) // 任何异常都不阻塞启动
  }
}

/* 更名迁移：旧版以 "Flow Studio" 存储，升级为 Isle Studio 后搬移项目数据。
   仅在开发版执行（ISLE_MIGRATION_TEST 演练时跳过，避免污染迁移测试目录）——
   安装版的旧数据迁移统一走 maybeMigrateUserData 询问流程。
   1.2.0：显式指定了数据目录（--user-data-dir / ISLE_USER_DATA）的开发实例跳过本迁移——
   独立实例的意义是「干净数据」，把用户全局的 Flow Studio 项目复制进去会污染验收结果
   （画布控制脚本要求「新建项目后列表只有一条」）。 */
const explicitDataDir = dataHomeResolved.source === 'cli' || dataHomeResolved.source === 'env'
if (!app.isPackaged && process.env.ISLE_MIGRATION_TEST !== '1' && !explicitDataDir) {
  try {
    const oldDir = path.join(app.getPath('appData'), 'Flow Studio')
    const newDir = app.getPath('userData') // 跟随实际数据目录
    if (fs.existsSync(path.join(oldDir, 'projects')) && !fs.existsSync(path.join(newDir, 'projects'))) {
      fs.mkdirSync(newDir, { recursive: true })
      fs.cpSync(path.join(oldDir, 'projects'), path.join(newDir, 'projects'), { recursive: true })
    }
  } catch (_) { /* 迁移失败不阻塞启动 */ }
}

/* REF-006 生成偏好默认值：新建节点与参数面板缺省值都取这里；
   单节点改参只改节点 data，不回写全局（设置页才能改全局） */
const DEFAULT_GENERATION = {
  image: { resolution: '2K', size: '1:1', n: 1 },
  video: { resolution: '720p', size: '16:9', duration: 5 },
  regenerate: 'new' // 'new' 新建节点（默认）| 'inplace' 原地覆盖
}
const DEFAULT_MODELS = { image: '', video: '', chat: '' } // REF-008 每分类默认模型

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.apib.ai', // 大陆直连镜像，官方主站 api.apimart.ai 在大陆被 DNS 污染
  outputDir: '',
  autoRunAgent: false, // REQ-006a：Isle 生成操作免审直跑开关（默认关）
  agentSlogan: '', // Isle 面板输入区上方的自定义标语（空 = 不显示）
  generation: DEFAULT_GENERATION,
  defaultModels: DEFAULT_MODELS
}

function configPath() {
  return path.join(app.getPath('userData'), 'flowstudio-config.json')
}

/* ---------- ARCH-002 API Key 加密存储（safeStorage）----------
   磁盘上所有 key（全站 apiKey、models[*].apiKey、modelKeys[*]）一律以
   `enc:v1:<base64>` 前缀存储；读设置时统一解密为明文供进程内使用，
   写设置时统一加密。safeStorage 不可用（如 Linux 无 keyring）时降级明文。 */
const ENC_PREFIX = 'enc:v1:'
const canEncrypt = () => {
  try { return safeStorage?.isEncryptionAvailable() } catch { return false }
}
function encKey(v) {
  if (typeof v !== 'string' || !v || v.startsWith(ENC_PREFIX)) return v
  if (!canEncrypt()) return v
  try { return ENC_PREFIX + safeStorage.encryptString(v).toString('base64') } catch { return v }
}
function decKey(v) {
  if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) return v
  try { return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64')) } catch { return '' }
}
function decryptSettings(s) {
  if (!s || typeof s !== 'object') return s
  const out = { ...s, apiKey: decKey(s.apiKey) || '' }
  if (s.models && typeof s.models === 'object') {
    out.models = Object.fromEntries(Object.entries(s.models).map(([k, arr]) => [
      k, Array.isArray(arr) ? arr.map((m) => ({ ...m, apiKey: decKey(m.apiKey) })) : arr
    ]))
  }
  if (s.modelKeys && typeof s.modelKeys === 'object') {
    out.modelKeys = Object.fromEntries(Object.entries(s.modelKeys).map(([k, v]) => [k, decKey(v)]))
  }
  return out
}
function encryptSettings(s) {
  if (!s || typeof s !== 'object') return s
  const out = { ...s, apiKey: encKey(s.apiKey) }
  if (s.models && typeof s.models === 'object') {
    out.models = Object.fromEntries(Object.entries(s.models).map(([k, arr]) => [
      k, Array.isArray(arr) ? arr.map((m) => ({ ...m, apiKey: encKey(m.apiKey) })) : arr
    ]))
  }
  if (s.modelKeys && typeof s.modelKeys === 'object') {
    out.modelKeys = Object.fromEntries(Object.entries(s.modelKeys).map(([k, v]) => [k, encKey(v)]))
  }
  return out
}

/* 老配置兼容：缺字段按默认补齐（新装/旧版本升级都不会读到 undefined） */
function ensureGeneration(g) {
  const src = g && typeof g === 'object' ? g : {}
  const pick = (o) => (o && typeof o === 'object' ? o : {})
  return {
    image: { ...DEFAULT_GENERATION.image, ...pick(src.image) },
    video: { ...DEFAULT_GENERATION.video, ...pick(src.video) },
    regenerate: src.regenerate === 'inplace' ? 'inplace' : 'new'
  }
}
function ensureDefaultModels(m) {
  return { ...DEFAULT_MODELS, ...(m && typeof m === 'object' ? m : {}) }
}

function readSettings() {
  try {
    const raw = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), 'utf-8')) }
    const s = decryptSettings(raw)
    return { ...s, generation: ensureGeneration(s.generation), defaultModels: ensureDefaultModels(s.defaultModels) }
  } catch {
    return { ...DEFAULTS }
  }
}
/* 导出专用：读原始密文配置（不解密）。脱敏判定依赖 enc:v1 前缀，
   若用解密后的配置导出，脱敏会整体失效 → 明文 Key 泄露（S21-2 实测发现） */
function readSettingsRaw() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), 'utf-8')) }
  } catch {
    return { ...DEFAULTS }
  }
}
// 模型配置：{ image:[{model,baseUrl,apiKey}], video:[...], chat:[...] }
// 首次运行时用全局 Key 自动迁移出默认条目
function ensureModels(s) {
  if (s.models && typeof s.models === 'object') {
    return {
      image: Array.isArray(s.models.image) ? s.models.image : [],
      video: Array.isArray(s.models.video) ? s.models.video : [],
      chat: Array.isArray(s.models.chat) ? s.models.chat : []
    }
  }
  const base = s.baseUrl || DEFAULTS.baseUrl
  const key = s.apiKey || ''
  return {
    image: key ? [{ model: 'gpt-image-2', baseUrl: base, apiKey: key }] : [],
    video: key ? [{ model: 'seedance-2.0', baseUrl: base, apiKey: key }] : [],
    chat: key ? [{ model: 'claude-fable-5.1', baseUrl: base, apiKey: key }] : []
  }
}
ipcMain.handle('settings:get', () => {
  const s = readSettings()
  return { ...s, models: ensureModels(s) }
})
ipcMain.handle('settings:set', (e, patch) => {
  const base = readSettings()
  const s = { ...base, ...patch }
  if (patch?.generation) s.generation = ensureGeneration({ ...base.generation, ...patch.generation })
  if (patch?.defaultModels) s.defaultModels = ensureDefaultModels({ ...base.defaultModels, ...patch.defaultModels })
  writeSettings(s)
  return { ...s, models: ensureModels(s) }
})
function outputDir() {
  const s = readSettings()
  return s.outputDir || path.join(app.getPath('pictures'), 'IsleStudio')
}

function createWindow(extraQuery) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f3f4f7', // 单主题（UI-031 A-4）：与浅色 --bg 一致，避免启动闪黑
    autoHideMenuBar: true,
    /* macOS 用原生红绿灯（hiddenInset）+ 顶部留白由渲染端 .is-mac 补；
       Windows/Linux 维持无边框，窗口按钮由应用顶栏自绘 */
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } } : { frame: false }),
    title: 'Isle Studio',
    ...(IS_WIN ? { icon: path.join(__dirname, '..', 'build', 'icon.png') } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const query = { ...(process.env.DEMO ? { demo: '1' } : {}), ...(extraQuery || {}) }
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), Object.keys(query).length ? { query } : undefined)
  /* 阶段0修复④：关闭前把决定权交给渲染端（未保存确认）。
     首次 close 一律拦截并询问渲染端；渲染端检查无未保存内容（或用户确认放弃）后回 confirmClose 放行 */
  win.__closeConfirmed = false
  win.on('close', (e) => {
    if (win.__closeConfirmed) return
    e.preventDefault()
    win.webContents.send('app:close-request')
  })
  return win
}

/* 渲染端确认后放行关闭 */
ipcMain.on('app:close-confirm', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  w.__closeConfirmed = true
  w.close()
})

/* 版本号统一从 package.json 取，避免界面硬编码落后于实际安装包 */
ipcMain.handle('app:version', () => app.getVersion())

/* 无边框窗口控制：最小化 / 最大化还原 / 关闭 */
ipcMain.handle('window:minimize', (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize() })
ipcMain.handle('window:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
})
ipcMain.handle('window:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close() })

/* ---------- settings ---------- */
function writeSettings(s) {
  fs.writeFileSync(configPath(), JSON.stringify(encryptSettings(s), null, 2), 'utf-8')
}
ipcMain.handle('pick-output-dir', async (e) => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('open-path', (e, p) => {
  /* 阶段0修复⑪：shell.openPath 只允许打开应用数据相关目录（旧版任意路径可打开） */
  const target = path.resolve(String(p || ''))
  const roots = [outputDir(), assetsRoot(), projectsDir(), templatesDir(), app.getPath('userData')]
  const allowed = roots.some((r) => path.resolve(r) === target || isInside(r, target))
  if (!allowed) return { ok: false, error: '路径不在应用数据目录内，已拒绝打开' }
  return shell.openPath(target)
})
/* REF-007「数据」Tab：直接打开 userData 数据目录（项目/资产都在这里） */
ipcMain.handle('open-data-dir', async () => {
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  return shell.openPath(dir)
})

/* ---------- 数据位置（Data Home）管理 ----------
   安装目录只放程序，用户数据固定在指针文件指向的目录。这三个接口让用户
   在应用内就能看到「数据到底在哪」并整体搬家（换盘 / 释放 C 盘）。 */
function dataHomeInfo() {
  const dir = app.getPath('userData')
  return {
    ok: true,
    dir,
    source: dataHomeResolved.source,
    pointer: dataHome.pointerPath(appDataDir),
    pointerDir: dataHome.readPointer(appDataDir)?.dir || '',
    installDir: app.isPackaged ? path.dirname(process.execPath) : '',
    packaged: app.isPackaged,
    stale: Boolean(dataHomeResolved.stale),
    staleFrom: dataHomeResolved.staleFrom || ''
  }
}
ipcMain.handle('datahome:info', () => dataHomeInfo())

async function pickDataHomeDir() {
  const r = await dialog.showOpenDialog({
    title: '选择数据存放位置（项目 / 生成物 / 资产库 / 模板 / API Key）',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: path.dirname(app.getPath('userData'))
  })
  return r.canceled ? '' : r.filePaths[0]
}
ipcMain.handle('datahome:pick', () => pickDataHomeDir())

/* 整体搬家：复制 → 校验 → 改指针 → 清旧目录缓存。旧核心数据保留可回退。 */
ipcMain.handle('datahome:relocate', async (e, target) => {
  const from = path.resolve(app.getPath('userData'))
  const to = path.resolve(String(target || ''))
  const pre = dataHome.checkTarget(from, to, app.isPackaged ? path.dirname(process.execPath) : '')
  if (pre) return { ok: false, error: pre }
  const ok = dialog.showMessageBoxSync({
    type: 'question',
    title: '移动数据目录',
    message: '把全部用户数据搬到新位置？',
    detail: `从：${from}\n到：${to}\n\n搬家期间请勿关闭应用。旧目录中的项目、生成物等核心数据会保留，可自行确认后删除；缓存会被清理。完成后应用会自动重启。`,
    buttons: ['开始搬家', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (ok !== 0) return { ok: false, canceled: true }
  const r = await dataHome.relocate(from, to, appDataDir, {
    installDir: app.isPackaged ? path.dirname(process.execPath) : ''
  })
  debugLog(`DATA relocate ${from} -> ${to} ok=${r.ok}${r.ok ? '' : ` err=${r.error}`}`)
  if (r.ok) {
    setTimeout(() => { app.relaunch(); app.exit(0) }, 800)
  }
  return r
})

/* 选择本地图片/视频，返回 dataURL 供画布上传节点使用 */
ipcMain.handle('pick-file', async () => {
  /* 自动化测试钩子：FLOW_TEST_FILE 指定文件时跳过对话框 */
  const testFile = process.env.FLOW_TEST_FILE
  if (testFile) {
    try {
      const ext = testFile.split('.').pop().toLowerCase()
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4' }[ext]
      if (!mime) return { error: 'unsupported test file: ' + ext }
      const buf = await fsp.readFile(testFile)
      return { kind: mime.startsWith('video') ? 'video' : 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, path: testFile }
    } catch (err) {
      return { error: String(err.message || err) }
    }
  }
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: '媒体文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm', 'mov', 'mkv'] }]
  })
  if (r.canceled || !r.filePaths.length) return null
  const p = r.filePaths[0]
  const ext = p.split('.').pop().toLowerCase()
  const mime = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm',
    mov: 'video/quicktime', mkv: 'video/x-matroska'
  }[ext]
  if (!mime) return null
  try {
    const buf = await fsp.readFile(p)
    return { kind: mime.startsWith('video') ? 'video' : 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, path: p }
  } catch (err) {
    return { error: String(err.message || err) }
  }
})
ipcMain.handle('open-outputs', () => {
  const dir = outputDir()
  fs.mkdirSync(dir, { recursive: true })
  shell.openPath(dir)
})

/* ---------- API proxy (避免渲染进程 CORS 问题) ---------- */
// 自动故障转移：主地址失败时依次尝试备用直连入口
const FALLBACKS = [
  'https://api.apib.ai',
  'https://api.aiuxu.com',
  'https://api.aishuch.com',
  'https://api.apimart.ai'
]
let stickyBase = null // 会话内记住最近一次成功的入口

function candidateBases(s) {
  const list = [stickyBase, s.baseUrl, ...FALLBACKS].filter(Boolean)
  return [...new Set(list)]
}

/* 1.2.0：请求超时分级。
   4K 图片/高分辨率视频的「同步提交」（网关直接等生成完再回响应）实测 43–54 秒，
   旧的 30 秒 socket 超时会在服务端仍在生成时断开连接——客户端拿不到响应也就拿不到
   task_id，用户看到「提交结果未知」，但服务端已扣费。提交类请求放到 240 秒，
   查询类保持 120 秒；两者都只在「连接静默」时触发，不会打断仍在传输的响应。 */
const REQ_TIMEOUT_MS = 120000
const SUBMIT_TIMEOUT_MS = 240000

async function fetchJson(base, { method = 'GET', urlPath, body, apiKey, timeoutMs }) {
  // REF-001：单次请求硬超时，避免网络挂死时节点永远停在「生成中」
  const resp = await net.fetch(base + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || REQ_TIMEOUT_MS)
  })
  const text = await resp.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: resp.status, json }
}

/* Node 原生 https 备用/主用栈：走系统解析器，与 curl 同路。
   附带 DNS 缓存：解析成功一次后，即使系统 DNS 间歇性故障也能用缓存 IP 直连 */
const dnsPromises = require('dns').promises
const dnsCache = new Map() // host -> { ip, ts }
const DNS_TTL = 15 * 60 * 1000
// 静态 IP 种子：DNS 彻底失灵时的最后兜底（2026-10-28 实测有效，随官方 DNS 变更需更新）
const STATIC_IPS = {
  'api.apib.ai': '47.242.232.205',
  'apib.ai': '47.242.232.205'
}

async function resolveHost(hostname) {
  const c = dnsCache.get(hostname)
  if (c && Date.now() - c.ts < DNS_TTL) return c.ip
  // 1) 系统解析器（getaddrinfo）
  try {
    const r = await dnsPromises.lookup(hostname)
    dnsCache.set(hostname, { ip: r.address, ts: Date.now() })
    return r.address
  } catch { /* 继续 */ }
  // 2) 直接查 DNS 服务器（c-ares，绕过系统解析链）
  try {
    const r4 = await dnsPromises.resolve4(hostname)
    if (r4?.length) {
      dnsCache.set(hostname, { ip: r4[0], ts: Date.now() })
      return r4[0]
    }
  } catch { /* 继续 */ }
  // 3) 静态种子
  if (STATIC_IPS[hostname]) {
    dnsCache.set(hostname, { ip: STATIC_IPS[hostname], ts: Date.now() })
    return STATIC_IPS[hostname]
  }
  // 4) 过期缓存兜底
  if (c) return c.ip
  throw new Error('DNS 解析失败: ' + hostname)
}

/* 定向复审 P1-3：明文 HTTP 自定义端点支持。旧实现无论 URL 协议一律 https.request，
   明文 HTTP 服务收到 TLS 握手必然失败，且错误可能被误判为「提交结果未知」 */
const httpLib = require('http')

function nodeFetchJson(base, { method = 'GET', urlPath, body, apiKey, timeoutMs }) {
  return (async () => {
    const u = new URL(base + urlPath)
    const isHttp = u.protocol === 'http:'
    if (!isHttp && u.protocol !== 'https:') {
      const err = new Error('INVALID_PROTOCOL: ' + u.protocol)
      err.unsent = true
      throw err
    }
    let ip
    try {
      ip = await resolveHost(u.hostname)
    } catch (err) {
      /* 定向复审 P1-3：DNS 失败发生在请求错误监听之前，必须显式标记「确定未发出」，
         否则 POST 会被误判为「提交结果未知」并跳过本可安全的栈切换 */
      err.unsent = true
      throw err
    }
    const data = body ? JSON.stringify(body) : null
    const lib = isHttp ? httpLib : https
    const idle = timeoutMs || REQ_TIMEOUT_MS
    const startedAt = Date.now()
    return await new Promise((resolve, reject) => {
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        if (err && err.elapsedMs === undefined) err.elapsedMs = Date.now() - startedAt
        reject(err)
      }
      const done = (v) => { if (settled) return; settled = true; resolve(v) }
      const req = lib.request({
        hostname: ip,
        port: Number(u.port) || (isHttp ? 80 : 443),
        path: u.pathname + u.search,
        method,
        ...(isHttp ? {} : { servername: u.hostname }), // TLS SNI 用真实域名（明文 HTTP 无 SNI）
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Host: u.hostname + (u.port ? ':' + u.port : ''),
          'Content-Length': data ? Buffer.byteLength(data) : 0
        },
        timeout: idle
      }, (res) => {
        let buf = ''
        res.on('data', (c) => { buf += c })
        res.on('end', () => {
          let json
          try { json = JSON.parse(buf) } catch { json = { raw: buf } }
          done({ status: res.statusCode, json })
        })
        /* 1.2.0：响应流中断。旧实现只在 error 事件里 reject，aborted 会静默挂住直到
           外层超时——现在立即失败并保留「响应已开始」标记（请求确定到达了服务端）。 */
        res.on('aborted', () => {
          const e = new Error('响应流被中断（连接提前关闭）')
          e.code = 'EABORTED'
          e.sent = true
          e.responseStarted = true
          fail(e)
        })
        res.on('error', (err) => {
          err.sent = true
          err.responseStarted = true
          fail(err)
        })
      })
      req.on('error', (err) => {
        /* 阶段0修复⑥：标记错误是否「确定请求未到达服务端」（可安全重试/切换网络栈）。
           DNS 失败/拒绝连接等发生在发送前；ECONNRESET/超时等发生在发送后，服务端可能已受理 */
        const UNSENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EACCES', 'EMFILE', 'INVALID_PROTOCOL'])
        err.unsent = UNSENT_CODES.has(err.code) || /DNS 解析失败/.test(String(err?.message || err))
        fail(err)
      })
      req.on('timeout', () => {
        const e = new Error(`请求超时：${Math.round(idle / 1000)} 秒内连接无响应`)
        e.code = 'ETIMEDOUT'
        e.sent = true
        req.destroy(e)
      })
      if (data) req.write(data)
      req.end()
    })
  })()
}

/* 网络错误自动重试（1.2s 间隔），最多 3 次 */
async function withRetry(fn, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1200))
    }
  }
  throw lastErr
}

/* 阶段0修复⑥：双栈 + 重试按幂等性分级。
   - GET/HEAD（查询类）：网络错误可安全重试（1.2s 间隔，最多 3 次），维持原行为
   - POST 等非幂等请求（会创建计费任务）：绝不自动重发——
     · Node 栈确定未发出（DNS/拒绝连接等）→ 允许切换 Chromium 栈重试一次（请求确定没到过服务端）
     · 请求已发出但响应丢失 → 返回「提交结果未知」，由用户决定是否重试，防止重复创建任务/重复扣费 */
const UNKNOWN_SUBMIT_MSG = '提交结果未知：请求可能已到达服务端但响应丢失。为避免重复创建计费任务未自动重发，请稍后手动重试或先核对是否已产生任务。'
async function fetchJsonDual(base, opts) {
  const safe = !opts.method || opts.method === 'GET' || opts.method === 'HEAD'
  const startAt = Date.now()
  const dual = async () => {
    try {
      return await nodeFetchJson(base, opts)
    } catch (err1) {
      try {
        return await fetchJson(base, opts)
      } catch (err2) {
        throw new Error(`Node栈: ${String(err1).slice(0, 90)} | Chromium栈: ${String(err2).slice(0, 90)}`)
      }
    }
  }
  if (safe) return withRetry(dual)
  try {
    return await nodeFetchJson(base, opts)
  } catch (err1) {
    /* 走到这里 = 非幂等请求最终失败：
       - Node 栈确定未发出 → 允许 fallback，但 fallback 一旦发出请求后失败即无法判断服务端是否受理
       - Node 栈已发出但响应丢失 → 同样无法判断
       两种情况都按「提交结果未知」收尾，绝不自动重发。
       1.2.0：保留底层原因/错误码/耗时——用户与运维都要能看出「是超时还是断网」，
       旧实现把它换成一句统一文案，等于丢掉唯一的排查线索。 */
    let err2 = null
    if (err1.unsent) {
      try { return await fetchJson(base, opts) } catch (e) { err2 = e }
    }
    const e = new Error(UNKNOWN_SUBMIT_MSG)
    e.unknownSubmit = true
    e.code = err1.code || ''
    e.elapsedMs = err1.elapsedMs || (Date.now() - startAt)
    e.submitStartedAt = startAt
    e.detail = `Node栈: ${String(err1).slice(0, 140)}${err2 ? ` | Chromium栈: ${String(err2).slice(0, 140)}` : ''}`
    throw e
  }
}

/* 调试日志：网络失败全量落盘，便于回溯 */
function debugLog(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

async function callApi(e, { method = 'GET', path: urlPath, body, baseUrl, apiKey }) {
  // ARCH-001：本地资产 file:// 引用在发出请求前内联回 base64（API 只认 dataURL/外链）
  if (body) body = inlineLocalAssetUrls(body)
  // 测试钩子：FLOW_CAPTURE 时拦截带 prompt 的请求，记录请求体并返回假响应（不消耗积分）
  if (process.env.FLOW_CAPTURE && body && body.prompt !== undefined) {
    try {
      fs.appendFileSync(process.env.FLOW_CAPTURE, JSON.stringify({ path: urlPath, body }) + '\n')
    } catch {}
    return { status: 200, json: { data: [{ url: 'https://example.com/fake.png' }] } }
  }
  const s = readSettings()
  const key = apiKey || s.apiKey
  if (!key) return { status: 0, json: { error: { message: '未配置 API Key' } } }
  /* 1.2.0：提交类（POST）给长超时——4K 图/高分辨率视频的同步提交实测 43–54 秒，
     查询类保持默认；只影响静默等待上限，不会打断仍在返回的响应 */
  const isSubmit = String(method).toUpperCase() === 'POST'
  const timeoutMs = isSubmit ? SUBMIT_TIMEOUT_MS : REQ_TIMEOUT_MS
  const unknownPayload = (err) => ({
    status: 0,
    json: {
      error: {
        message: UNKNOWN_SUBMIT_MSG,
        code: 'submit_unknown',
        detail: err?.detail || String(err || '').slice(0, 160),
        elapsedMs: Number(err?.elapsedMs) || 0,
        startedAt: Number(err?.submitStartedAt) || 0
      }
    }
  })
  // 显式指定了 baseUrl（自定义模型配置）：单点直连，双栈重试
  if (baseUrl) {
    try {
      const r = await fetchJsonDual(baseUrl.replace(/\/+$/, ''), { method, urlPath, body, apiKey: key, timeoutMs })
      return { ...r, via: baseUrl }
    } catch (err) {
      debugLog(`FAIL ${method} ${baseUrl}${urlPath} -> ${String(err)}${err?.detail ? ' | ' + err.detail : ''}`)
      if (err?.unknownSubmit) return unknownPayload(err)
      return { status: 0, json: { error: { message: `连接失败（${String(err).slice(0, 160)}）` } } }
    }
  }
  let lastErr = ''
  for (const base of candidateBases(s)) {
    try {
      const r = await fetchJsonDual(base, { method, urlPath, body, apiKey: key, timeoutMs })
      stickyBase = base
      return { ...r, via: base }
    } catch (err) {
      /* 阶段0修复⑥：提交结果未知时不得换下一个域名重发（同样是非幂等重放），直接返回 */
      if (err?.unknownSubmit) {
        debugLog(`UNKNOWN-SUBMIT ${method} ${base}${urlPath} elapsed=${err.elapsedMs || 0}ms detail=${err.detail || ''}`)
        return unknownPayload(err)
      }
      lastErr = String(err)
    }
  }
  return { status: 0, json: { error: { message: `所有接口均连接失败（${lastErr.slice(0, 120)}）` } } }
}
ipcMain.handle('apimart', callApi)

/* ---------- P1 参考素材公网化 ----------
   网关已不接受 base64 直传（官方文档 2026-10 起），且动作控制类模型的参考视频
   必须是公网直链。图片统一先传 /v1/uploads/images 换 URL（72 小时有效）。
   视频：网关没有上传通道 → 返回明确错误，由渲染层提示用户填公网直链。 */
async function mediaUploadOne(baseUrl, apiKey, buf, type, name) {
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type }), name)
  const resp = await net.fetch(baseUrl + '/v1/uploads/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
    signal: AbortSignal.timeout(60000)
  })
  const text = await resp.text()
  let json
  try { json = JSON.parse(text) } catch { json = {} }
  if (!resp.ok || !json.url) {
    throw new Error(json?.error?.message || `上传失败 (HTTP ${resp.status})`)
  }
  return json.url
}

ipcMain.handle('media:upload', async (_e, { src, baseUrl, apiKey } = {}) => {
  try {
    const s = String(src || '')
    if (!s) return { ok: false, error: '缺少素材' }
    let buf, type
    if (s.startsWith('data:')) {
      const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(s)
      if (!m) return { ok: false, error: '素材格式无法识别' }
      type = m[1] || 'image/png'
      buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
    } else if (s.startsWith('file://')) {
      const p = fileUrlToPath(s)
      if (!fs.existsSync(p)) return { ok: false, error: '本地素材不存在：' + p }
      buf = await fsp.readFile(p)
      type = /\.png$/i.test(p) ? 'image/png'
        : /\.webp$/i.test(p) ? 'image/webp'
          : /\.gif$/i.test(p) ? 'image/gif'
            : /\.(mp4|mov|webm|m4v)$/i.test(p) ? 'video/mp4' : 'image/jpeg'
    } else {
      return { ok: false, error: '仅支持本地素材上传' }
    }
    if (type.startsWith('video/')) {
      return { ok: false, error: '网关不提供视频托管：参考视频必须是公网直链（mp4/mov）' }
    }
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) {
      return { ok: false, error: `不支持的图片类型：${type}` }
    }
    if (buf.length > 20 * 1024 * 1024) return { ok: false, error: '图片超过 20MB 上限' }
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'image/gif' ? 'gif' : 'jpg'
    const name = `ref-${Date.now()}.${ext}`
    const bases = [...new Set([baseUrl, ...FALLBACKS].filter(Boolean))]
    let lastErr = ''
    for (const b of bases) {
      try {
        const url = await mediaUploadOne(b, apiKey, buf, type, name)
        return { ok: true, url }
      } catch (err) { lastErr = String(err?.message || err) }
    }
    return { ok: false, error: lastErr || '上传失败' }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
})

/* ---------- P2 语音合成（TTS）----------
   网关 /v1/audio/speech 走 OpenAI 兼容协议，成功时返回**二进制音频**（不是 JSON），
   失败时返回 JSON 错误。这里按 Content-Type 区分，绝不把错误 JSON 当成音频存成 mp3。
   实测（2026-11-02）：gpt-4o-mini-tts 可用；tts-1 / tts-1-hd 未部署；gpt-audio-mini 不支持该操作。 */
ipcMain.handle('audio:speech', async (_e, { model, input, voice, speed, format, baseUrl, apiKey } = {}) => {
  const s = readSettings()
  const key = String(apiKey || s.apiKey || '').trim()
  if (!key) return { ok: false, error: '未配置 API Key' }
  const text = String(input || '').trim()
  if (!text) return { ok: false, error: '台词为空' }
  if (text.length > 4000) return { ok: false, error: `台词过长（${text.length} 字），单次最多 4000 字` }
  const body = {
    model: model || 'gpt-4o-mini-tts',
    input: text,
    voice: voice || 'alloy',
    response_format: format || 'mp3'
  }
  const sp = Number(speed)
  if (Number.isFinite(sp) && sp > 0 && sp !== 1) body.speed = sp
  const bases = [...new Set([baseUrl, s.baseUrl, ...FALLBACKS].filter(Boolean))]
  let lastErr = ''
  for (const b of bases) {
    try {
      const resp = await net.fetch(String(b).replace(/\/+$/, '') + '/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000)
      })
      const type = String(resp.headers.get('content-type') || '')
      const buf = Buffer.from(await resp.arrayBuffer())
      if (!resp.ok || !type.toLowerCase().startsWith('audio/')) {
        let msg = `合成失败 (HTTP ${resp.status})`
        try { const j = JSON.parse(buf.toString('utf-8')); msg = j?.error?.message || msg } catch { /* 非 JSON */ }
        lastErr = msg
        /* Key 无效换域名也没用，直接返回 */
        if (resp.status === 401 || resp.status === 403) return { ok: false, error: msg }
        continue
      }
      const mime = type.split(';')[0].trim()
      return {
        ok: true,
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        bytes: buf.length,
        mime
      }
    } catch (err) {
      lastErr = String(err?.message || err)
    }
  }
  return { ok: false, error: lastErr || '语音合成失败' }
})

/* ---------- P3 成片合成（FFmpeg 本地管线）----------
   输入：若干段本地视频（按传入顺序拼接）+ 可选配音音频；输出 mp4 直落项目资产目录。
   设计要点：
   - 字幕用 drawtext + textfile（每行一个临时文本文件），中文渲染走微软雅黑，不依赖 libass 字体查找；
   - 段内音频缺失时补 anullsrc 静音，保证 concat 的 a=1 分支不炸；
   - 进度通过 time= 解析，按 requestId 多路复用推给渲染端。 */
const { spawn } = require('child_process')
let ffmpegBinCache = ''
function ffmpegBin() {
  if (ffmpegBinCache) return ffmpegBinCache
  const cands = [
    path.join(process.resourcesPath || '', 'bin', 'ffmpeg' + EXE), // 打包版
    path.join(__dirname, '..', 'build', 'bin', 'ffmpeg' + EXE),    // 开发版
    path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg' + EXE)
  ]
  for (const c of cands) { if (fs.existsSync(c)) { ffmpegBinCache = c; return c } }
  /* 未随包携带（macOS 安装包默认不带二进制）→ 交给 PATH：
     brew install ffmpeg 后即可用，找不到时成片合成会给出「未安装 ffmpeg」提示 */
  return 'ffmpeg' + EXE
}
/* 用 ffmpeg -i 的 stderr 探测时长/是否含音轨（避免再带一个 ffprobe 二进制） */
function probeMedia(file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegBin(), ['-hide_banner', '-i', file], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('error', () => resolve({ ok: false }))
    p.on('close', () => {
      const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err)
      if (!dm) return resolve({ ok: false })
      const seconds = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3])
      resolve({ ok: true, seconds, hasAudio: /Stream .*: Audio:/.test(err), width: Number((/Stream .*Video:.*?, (\d+)x(\d+)/.exec(err) || [])[1] || 0), height: Number((/Stream .*Video:.*?, (\d+)x(\d+)/.exec(err) || [])[2] || 0) })
    })
  })
}
const escFilterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
/* 字幕字体：各平台的中文字体路径完全不同，按平台给候选再回退到系统默认族名。
   Windows 微软雅黑 / macOS 苹方（.ttc 内含多字重，ffmpeg drawtext 取首个）/ Linux 常见开源字体。 */
let subtitleFontCache = ''
function subtitleFont() {
  if (subtitleFontCache) return subtitleFontCache
  const cands = IS_WIN
    ? ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyh.ttf', 'C:/Windows/Fonts/simsun.ttc', 'C:/Windows/Fonts/arial.ttf']
    : IS_MAC
      ? ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc', '/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/Helvetica.ttc']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']
  subtitleFontCache = cands.find((f) => fs.existsSync(f)) || (IS_WIN ? 'C:/Windows/Fonts/arial.ttf' : 'Sans')
  return subtitleFontCache
}
/* 台词 → 字幕行：按标点切分，再把超长行按 maxLen 收拢（中文以字为单位） */
function splitSubtitleLines(text, maxLen = 18) {
  const raw = String(text || '').replace(/\s+/g, ' ').split(/(?<=[。！？；!?;])|(?<=[，,、](?=[^，,、]{5,}$))/)
  const lines = []
  for (let seg of raw.map((s) => s.trim()).filter(Boolean)) {
    while (seg.length > maxLen) {
      /* 优先在句内标点处断行，其次硬切 */
      let cut = -1
      for (const pm of ['，', ',', '、', ' ']) {
        const idx = seg.lastIndexOf(pm, maxLen)
        if (idx >= Math.floor(maxLen * 0.4)) { cut = idx + 1; break }
      }
      if (cut < 0) cut = maxLen
      lines.push(seg.slice(0, cut).trim())
      seg = seg.slice(cut).trim()
    }
    if (seg) lines.push(seg)
  }
  return lines.slice(0, 60)
}

ipcMain.handle('video:compose', async (e, { id, clips, voice, opts, projectName, sessionId } = {}) => {
  const sendProg = (percent) => { try { e.sender.send('compose:progress', { id, percent }) } catch { /* 忽略 */ } }
  try {
    const bin = ffmpegBin()
    const list = (Array.isArray(clips) ? clips : []).map((u) => {
      const p = String(u || '').startsWith('file://') ? fileUrlToPath(u) : String(u || '')
      return fs.existsSync(p) ? p : ''
    }).filter(Boolean)
    if (!list.length) return { ok: false, error: '没有可用的本地视频片段，请先连线已生成的视频节点' }
    const probed = []
    for (const c of list) {
      const info = await probeMedia(c)
      if (!info.ok) return { ok: false, error: `无法读取视频：${path.basename(c)}（文件损坏或不是受支持的格式）` }
      probed.push({ file: c, ...info })
    }
    const total = probed.reduce((s, x) => s + x.seconds, 0)
    if (total <= 0) return { ok: false, error: '视频总时长为 0，无法合成' }
    const o = opts || {}
    /* 输出画幅：跟随第一段视频，或面板指定（宽高都取偶，x264 要求） */
    const SIZE = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:3': [1440, 1080] }
    const [rawW, rawH] = SIZE[o.size] || [probed[0].width || 1920, probed[0].height || Math.round((probed[0].width || 1920) * 9 / 16)]
    const outW = Math.max(2, Math.round(rawW / 2) * 2)
    const outH = Math.max(2, Math.round(rawH / 2) * 2)
    const fps = 30

    const args = ['-hide_banner', '-loglevel', 'warning', '-y']
    for (const c of list) args.push('-i', c)
    const voicePath = String(voice || '').startsWith('file://') ? fileUrlToPath(voice) : String(voice || '')
    let hasVoice = false
    if (voicePath && fs.existsSync(voicePath)) {
      if (o.loopAudio) args.push('-stream_loop', '-1')
      args.push('-i', voicePath)
      hasVoice = true
    }
    const voiceIdx = hasVoice ? list.length : -1
    /* 静音兜底输入（无原声且无配音时用） */
    const silentIdx = list.length + (hasVoice ? 1 : 0)
    if (!hasVoice && !o.keepOriginalSound) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo')

    const parts = []
    /* 原声只在「没连配音 + 面板开保留原声」时使用；否则音轨完全由配音/静音决定，
       这样 concat 的音频分支不会产出无人消费的输出（FFmpeg 会直接拒绝整图） */
    const useOrigAudio = !hasVoice && !!o.keepOriginalSound
    probed.forEach((c, i) => {
      parts.push(`[${i}:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`)
      if (useOrigAudio) {
        parts.push(c.hasAudio
          ? `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
          : `anullsrc=r=44100:cl=stereo,atrim=0:${c.seconds.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
      }
    })
    if (useOrigAudio) {
      parts.push(`${probed.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${probed.length}:v=1:a=1[vcat][acat]`)
    } else {
      parts.push(`${probed.map((_, i) => `[v${i}]`).join('')}concat=n=${probed.length}:v=1:a=0[vcat]`)
    }
    let audioOut
    if (hasVoice) {
      audioOut = `[${voiceIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS[aout]`
    } else if (useOrigAudio) {
      audioOut = '[acat]anull[aout]'
    } else {
      audioOut = `[${silentIdx}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS[aout]`
    }
    parts.push(audioOut)

    /* 字幕：把台词按比例摊到音轨时长上（有声轨用音轨时长，否则用全片时长） */
    let videoOut = '[vcat]'
    const tmpDir = path.join(app.getPath('temp'), 'isle-compose')
    fs.mkdirSync(tmpDir, { recursive: true })
    const tmpFiles = []
    try {
      if (o.subtitles) {
        const lines = splitSubtitleLines(o.script || '')
        if (lines.length) {
          const charTotal = lines.reduce((s, l) => s + l.length, 0)
          /* 配音循环时字幕应铺满全片，而不是只在第一轮配音时长内 */
          const span = hasVoice
            ? (o.loopAudio ? total : Math.min(total, (await probeMedia(voicePath)).seconds || total))
            : total
          let t2 = 0
          const chain = []
          const font = subtitleFont()
          lines.forEach((line, i) => {
            const dur = Math.max(0.6, span * (line.length / charTotal))
            const start = t2; t2 += dur
            const tf = path.join(tmpDir, `sub-${id || Date.now()}-${i}.txt`)
            fs.writeFileSync(tf, line, 'utf8')
            tmpFiles.push(tf)
            chain.push(
              `drawtext=fontfile='${escFilterPath(font)}':textfile='${escFilterPath(tf)}'` +
              `:fontsize=${Math.round(outH * 0.052)}:fontcolor=white:borderw=2:bordercolor=black@0.85` +
              `:x=(w-text_w)/2:y=h-text_h-h*0.085:enable='between(t,${start.toFixed(2)},${Math.min(span, t2).toFixed(2)})'`
            )
          })
          parts.push(`[vcat]${chain.join(',')}[vsub]`)
          videoOut = '[vsub]'
        }
      }
      /* 滤镜图可能很长（每条字幕一个 drawtext），走脚本文件而不是命令行参数：
         Windows 命令行长 32K 上限，且脚本文件不受引号/换行干扰 */
      const graphFile = path.join(tmpDir, `graph-${id || Date.now()}.txt`)
      fs.writeFileSync(graphFile, parts.join(';\n'), 'utf8')
      tmpFiles.push(graphFile)
      args.push('-filter_complex_script', graphFile)
      args.push('-map', videoOut, '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart')

      /* 输出直接落项目资产目录，渲染端把返回的 file:// 存进节点即可 */
      const dir = assetsDirFor(resolveAssetKey(projectName, sessionId))
      fs.mkdirSync(dir, { recursive: true })
      const outFile = path.join(dir, `compose-${Date.now()}.mp4`)
      args.push(outFile)

      const proc = spawn(bin, args, { windowsHide: true })
      let errBuf = ''
      let lastSent = 0
      proc.stderr.on('data', (d) => {
        errBuf += d
        const tm = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(errBuf.slice(-400))
        if (tm) {
          const sec = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3])
          const pct = Math.min(99, Math.round((sec / total) * 100))
          if (pct >= lastSent + 2) { lastSent = pct; sendProg(pct) }
        }
      })
      const code = await new Promise((res) => { proc.on('error', (er) => { errBuf += '\n' + er.message; res(-1) }); proc.on('close', res) })
      if (code !== 0) {
        /* 诊断留痕：完整 stderr 与滤镜图留在临时目录，便于排查（不写用户目录） */
        try {
          fs.writeFileSync(path.join(tmpDir, 'last-error.log'), errBuf, 'utf8')
          fs.writeFileSync(path.join(tmpDir, 'last-args.log'), args.join('\n'), 'utf8')
          fs.writeFileSync(path.join(tmpDir, 'last-graph.log'), parts.join(';\n'), 'utf8')
        } catch { /* 忽略 */ }
      }
      if (code !== 0 || !fs.existsSync(outFile)) {
        /* macOS 安装包不内置 FFmpeg 二进制，PATH 里没有时给一句能照做的提示 */
        if (/ENOENT/.test(errBuf)) {
          return { ok: false, error: IS_MAC
            ? '未找到 FFmpeg：请先在终端执行 brew install ffmpeg，然后重启 Isle Studio'
            : '未找到 FFmpeg：安装包内的 ffmpeg.exe 缺失或被拦截' }
        }
        const why = /Error|error|Invalid|No such/i.exec(errBuf)?.[0]
        return { ok: false, error: `合成失败（FFmpeg 退出码 ${code}）${why ? '：' + errBuf.split('\n').filter((l) => /error|invalid/i.test(l)).slice(-2).join(' ').slice(0, 300) : ''}` }
      }
      sendProg(100)
      return { ok: true, url: pathToFileUrl(outFile), seconds: total, width: outW, height: outH, file: outFile }
    } finally {
      for (const f of tmpFiles) { try { fs.unlinkSync(f) } catch { /* 忽略 */ } }
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
})

/* ---------- ARCH-001 项目资产本地化 ----------
   生成产物与上传图片统一落 userData/assets/<项目名>/，项目 JSON 只存 `assets:<文件名>` 相对引用。
   - 内容/URL 寻址命名（sha1 前 12 位）：同内容只落盘一次，重复保存幂等；
   - 打开旧项目时一次性迁移（dataURL/外链 → 本地文件）并回写 JSON；
     单条下载失败保留原 URL（下次打开重试）并给节点标记 sourceLost（「源已失效」）；
   - 请求体里的 file:// 资产引用在主进程内联回 base64（API 只认 dataURL/外链）。 */
const ASSET_PREFIX = 'assets:'
function assetsRoot() { return path.join(app.getPath('userData'), 'assets') }
/* 定向复审 P0-3：assets/meta 目录与文件一律以「存储 key」定位（key 由 resolveProjectEntry
   解析为新名或旧名，二者均已消毒）；不再在此处重复 sanitize，避免新旧两套规则各自定位 */
const assetsDirFor = (key) => path.join(assetsRoot(), key)
const assetsBaseUrl = (key) => 'file:///' + assetsDirFor(key).replace(/\\/g, '/') + '/'

/* ---------- REF-002 缩略图 ----------
   assets/<项目>/thumbs/<资产名>.webp（长边 ≤512，渲染端 canvas 编码）。
   命名完全由原资产文件名派生（内容哈希），因此**不写进项目 JSON**：
   画布/列表/参考栏用缩略图，放大/下载/发给模型仍用原图；文件丢了能由原图懒重建。 */
const fileUrlToPath = toLocalPath // 跨平台：统一走 Node 的 fileURLToPath（见文件顶部 helper）
const pathToFileUrl = (p) => 'file:///' + p.replace(/\\/g, '/')

/* ---------- S18 修复：生成产物即时入库 ----------
   生成完成时就把产物写进 assets/<项目>/（未命名项目先落 assets/_unnamed-<会话>/，
   保存命名时由 localizeList 并入正式项目目录），否则「项目资产」要等一次手动保存才看得到。 */
const UNNAMED_PREFIX = '_unnamed-'
/* 已命名项目 → 解析出的存储 key；未命名 → 会话级暂存目录（同一窗口内稳定） */
function resolveAssetKey(projectName, sessionId) {
  const disp = String(projectName || '').trim()
  if (disp && disp !== '未命名' && disp !== '未命名项目') {
    try { return resolveProjectEntry(disp).key } catch { /* 落到暂存目录 */ }
  }
  const sid = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'default'
  return UNNAMED_PREFIX + sid
}
/* 把任意本地文件按「内容哈希」收进目标资产目录，同名内容天然去重 */
function adoptLocalFile(dir, srcFile) {
  const buf = fs.readFileSync(srcFile)
  const ext = (path.extname(srcFile).slice(1) || 'bin').toLowerCase()
  const file = 'a_' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + '.' + ext
  const fp = path.join(dir, file)
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf)
  return file
}
function thumbPathFor(assetPath) {
  return path.join(path.dirname(assetPath), 'thumbs', path.basename(assetPath, path.extname(assetPath)) + '.webp')
}
const thumbUrlFor = (assetPath) => pathToFileUrl(thumbPathFor(assetPath))

/* 渲染端生成好 WebP 后回写：src 为原图 file:// 地址，dataUrl 为 canvas.toDataURL('image/webp') */
ipcMain.handle('thumb:put', async (e, { src, dataUrl } = {}) => {
  try {
    if (typeof src !== 'string' || !src.startsWith('file:///')) return { ok: false, error: 'not a local asset' }
    const p = fileUrlToPath(src)
    /* 阶段0修复⑨：startsWith 前缀判定可被同级目录名绕过（assetsX/），改用严格包含判定 */
    if (!isInside(assetsRoot(), p) || !fs.existsSync(p)) return { ok: false, error: 'asset missing' }
    const m = /^data:image\/webp;base64,([\s\S]+)$/.exec(String(dataUrl || ''))
    if (!m) return { ok: false, error: 'bad payload' }
    const tp = thumbPathFor(p)
    fs.mkdirSync(path.dirname(tp), { recursive: true })
    fs.writeFileSync(tp, Buffer.from(m[1], 'base64'))
    return { ok: true, url: pathToFileUrl(tp) }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})

/* 项目列表缩略图：优先缩略图文件，还没生成就用原图（避免列表白图） */
function thumbOrOriginal(assetPath) {
  const tp = thumbPathFor(assetPath)
  return pathToFileUrl(fs.existsSync(tp) ? tp : assetPath)
}

/* ---------- S18 项目资产面板 ----------
   assets:scan   全库资产清单（懒加载，仅面板打开时调用）
   assets:insert 插入画布取文件：本项资产直接引用；跨项资产先复制进当前项目目录（绝不跨项引用）
   assets:delete 删除资产：先扫描同存储 key 项目 JSON 的 assets: 引用，被引用须 force 二次确认 */
const ASSET_IMG_EXT = /\.(png|jpe?g|webp|gif)$/i
const ASSET_VID_EXT = /\.(mp4|webm|mov)$/i
/* P2：配音产物（TTS）同样进资产面板，没有缩略图，列表用图标占位 */
const ASSET_AUD_EXT = /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i
ipcMain.handle('assets:scan', () => {
  try {
    const root = assetsRoot()
    let keys = []
    try { keys = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { /* 无 assets 目录 */ }
    const items = []
    for (const key of keys) {
      const dir = path.join(root, key)
      let disp = key
      try { const m = JSON.parse(fs.readFileSync(metaFileFor(key), 'utf-8')); if (m?.name) disp = m.name } catch { /* 目录可能是未保存项目，按 key 显示 */ }
      if (key.startsWith(UNNAMED_PREFIX)) disp = '未命名项目' // 生成后未保存的会话暂存目录
      let files = []
      try { files = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const f of files) {
        if (!f.isFile()) continue
        const isV = ASSET_VID_EXT.test(f.name)
        const isI = ASSET_IMG_EXT.test(f.name)
        const isA = !isV && !isI && ASSET_AUD_EXT.test(f.name)
        if (!isV && !isI && !isA) continue
        const fp = path.join(dir, f.name)
        let st = null
        try { st = fs.statSync(fp) } catch { continue }
        items.push({
          key, proj: disp, name: f.name,
          type: isV ? 'video' : isI ? 'image' : 'audio',
          size: st.size, mtime: st.mtimeMs,
          thumb: isA ? null : thumbOrOriginal(fp),
          url: pathToFileUrl(fp)
        })
      }
    }
    items.sort((a, b) => b.mtime - a.mtime)
    return { ok: true, items }
  } catch (err) { return { ok: false, error: String(err.message || err) } }
})

ipcMain.handle('assets:insert', (e, { url, projectName } = {}) => {
  try {
    const p = fileUrlToPath(String(url || ''))
    if (!isInside(assetsRoot(), p) || !fs.existsSync(p)) return { ok: false, error: '资产文件不存在' }
    const srcKey = path.basename(path.dirname(p))
    let targetKey = null
    const disp = String(projectName || '').trim()
    if (disp && disp !== '未命名') {
      try { targetKey = resolveProjectEntry(disp).key } catch { }
    }
    if (!targetKey) return { ok: false, needSave: true, error: '未命名项目请先保存，再插入其他项目的资产' }
    if (srcKey === targetKey) return { ok: true, url: pathToFileUrl(p), copied: false }
    const destDir = assetsDirFor(targetKey)
    fs.mkdirSync(destDir, { recursive: true })
    const dest = path.join(destDir, path.basename(p))
    if (!fs.existsSync(dest)) fs.copyFileSync(p, dest)
    const sth = thumbPathFor(p)
    const dth = thumbPathFor(dest)
    if (fs.existsSync(sth) && !fs.existsSync(dth)) {
      try { fs.mkdirSync(path.dirname(dth), { recursive: true }); fs.copyFileSync(sth, dth) } catch { /* 缩略图缺失可重建 */ }
    }
    return { ok: true, url: pathToFileUrl(dest), copied: true }
  } catch (err) { return { ok: false, error: String(err.message || err) } }
})

ipcMain.handle('assets:delete', async (e, { url, force } = {}) => {
  try {
    const p = fileUrlToPath(String(url || ''))
    if (!isInside(assetsRoot(), p) || !fs.existsSync(p)) return { ok: false, error: '资产文件不存在' }
    const key = path.basename(path.dirname(p)) // assets/<存储key>/<文件>
    const name = path.basename(p)
    const ref = ASSET_PREFIX + name
    /* 引用扫描：同存储 key 的项目才可能引用（assets: 引用按项目目录展开，跨 key 无意义） */
    const affected = []
    let files = []
    try { files = fs.readdirSync(projectsDir()).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')) } catch { }
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(projectsDir(), f), 'utf-8'))
        const entry = resolveProjectEntry(String(j?.name || ''))
        if (entry.key !== key) continue
        if (JSON.stringify(j?.data || {}).includes('"' + ref + '"')) affected.push({ file: f, name: j.name || f.replace(/\.json$/, '') })
      } catch { /* 单个坏文件不阻塞扫描 */ }
    }
    if (affected.length && !force) {
      return { ok: false, referenced: true, refs: affected.map((x) => x.name), error: `被 ${affected.length} 个项目引用` }
    }
    debugLog(`ASSETS DELETE key=${key} name=${name} affected=${affected.length} force=${!!force}`)
    /* force：置空涉事项目里引用该资产的节点产物并回写（写链参加项目锁） */
    let cleared = 0
    let writeFail = false
    for (const a of affected) {
      try {
        /* 必须 await：withProjLock 返回 promise，不等待会让 rewrite 晚于本 handler 返回，
           cleared 计数丢失（且理论上可能与随后的文件删除交错） */
        await withProjLock(key, () => {
          const fp = path.join(projectsDir(), a.file)
          const j = JSON.parse(fs.readFileSync(fp, 'utf-8'))
          const walk = (nodes) => {
            for (const n of nodes || []) {
              const d = n?.data
              if (!d) continue
              for (const k of ['urls', 'refImages']) {
                if (Array.isArray(d[k]) && d[k].includes(ref)) {
                  d[k] = d[k].filter((u) => u !== ref)
                  cleared++
                }
              }
            }
          }
          walk(j?.data?.nodes)
          fs.writeFileSync(fp, JSON.stringify(j, null, 1))
        })
      } catch { writeFail = true /* 回写失败则中止删除，保引用一致性 */ }
    }
    if (writeFail) return { ok: false, error: '引用项目回写失败，已保留原文件' }
    try { fs.rmSync(p, { force: true }) } catch { }
    try { fs.rmSync(thumbPathFor(p), { force: true }) } catch { }
    return { ok: true, cleared }
  } catch (err) { return { ok: false, error: String(err.message || err) } }
})

/* 生成产物即时入库：远端 / dataURL / 导出目录里的本地文件 → assets/<项目 key>/
   已命名项目进项目目录；未命名进会话暂存目录（保存命名时由 localizeList 并入）
   返回与入参等长的本地 file:// 列表，单条失败原样回传（不阻塞生成主流程） */
ipcMain.handle('assets:adopt', async (e, { urls, projectName, sessionId } = {}) => {
  const list = Array.isArray(urls) ? urls.filter((u) => typeof u === 'string' && u) : []
  if (!list.length) return { ok: true, urls: [] }
  try {
    const key = resolveAssetKey(projectName, sessionId)
    const dir = assetsDirFor(key)
    const out = []
    for (const u of list) {
      try {
        if (u.startsWith('data:')) {
          out.push(pathToFileUrl(path.join(dir, await putAsset(dir, { dataUrl: u }))))
        } else if (/^https?:\/\//.test(u)) {
          out.push(pathToFileUrl(path.join(dir, await putAsset(dir, { url: u }))))
        } else if (u.startsWith('file://')) {
          const p = fileUrlToPath(u)
          /* 只接受导出目录或资产根内的文件，防止渲染端越权搬运任意路径 */
          if (fs.existsSync(p) && (isInside(outputDir(), p) || isInside(assetsRoot(), p))) {
            out.push(pathToFileUrl(path.join(dir, adoptLocalFile(dir, p))))
          } else out.push(u)
        } else out.push(u)
      } catch { out.push(u) }
    }
    return { ok: true, key, urls: out }
  } catch (err) { return { ok: false, error: String(err.message || err), urls: list } }
})

function assetExt(mime, url) {
  /* P2 配音：音频 MIME → 规范后缀（audio/mpeg 直接切 '/' 会得到 mpeg，必须是 mp3） */
  const AUDIO_EXT = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/x-flac': 'flac'
  }
  const key = String(mime || '').split(';')[0].trim().toLowerCase()
  if (AUDIO_EXT[key]) return AUDIO_EXT[key]
  const m = String(mime || '').split('/')[1] || ''
  if (m) return m.replace('jpeg', 'jpg').split('+')[0].toLowerCase()
  return (String(url).match(/\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|aac|ogg|opus|flac)(\?|#|$)/i)?.[1] || 'png').replace('jpeg', 'jpg').toLowerCase()
}

/* 落盘一个资产，返回文件名；同内容/同 URL 幂等 */
async function putAsset(dir, { dataUrl, url }) {
  fs.mkdirSync(dir, { recursive: true })
  let buf, ext, key
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl)
    if (!m) throw new Error('bad dataUrl')
    ext = assetExt(m[1] || 'image/png')
    buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
    key = 'a_' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)
  } else if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    ext = assetExt(resp.headers.get('content-type'), url)
    buf = Buffer.from(await resp.arrayBuffer())
    key = 'u_' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)
  } else throw new Error('nothing to save')
  const file = `${key}.${ext}`
  const fp = path.join(dir, file)
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf)
  return file
}

/* 把一个 url 列表落盘为 assets: 引用；单条失败保留原值（可重入）。
   projKey 为存储 key（已由 resolveProjectEntry 消毒/解析） */
async function localizeList(projKey, list) {
  const dir = assetsDirFor(projKey)
  const dirBase = assetsBaseUrl(projKey)
  const out = []
  for (const u of list || []) {
    if (typeof u !== 'string') { out.push(u); continue }
    if (u.startsWith(ASSET_PREFIX)) { out.push(u); continue }
    if (u.startsWith(dirBase)) { out.push(ASSET_PREFIX + decodeURIComponent(u.slice(dirBase.length))); continue }
    /* 本地 file:// 引用：属于本项目目录 → 只换前缀；属于 assets/ 下的**其他**目录
       （未命名会话暂存 _unnamed-*、或历史遗留）→ 复制进本项目目录后再改引用，
       保证保存后项目自包含、资产面板只剩一份 */
    if (u.startsWith('file://')) {
      const p = fileUrlToPath(u)
      if (isInside(dir, p)) { out.push(ASSET_PREFIX + path.basename(p)); continue }
      if (isInside(assetsRoot(), p) && fs.existsSync(p)) {
        /* 保留原文件名（不能用内容哈希重命名）：渲染端只做「目录前缀重映射」，
           文件名一变画面就断链 */
        try {
          const name = path.basename(p)
          fs.mkdirSync(dir, { recursive: true })
          const dest = path.join(dir, name)
          if (!fs.existsSync(dest)) fs.copyFileSync(p, dest)
          out.push(ASSET_PREFIX + name)
          continue
        } catch { /* 复制失败保留原值 */ }
      }
      out.push(u)
      continue
    }
    if (u.startsWith('data:')) {
      try { out.push(ASSET_PREFIX + await putAsset(dir, { dataUrl: u })) } catch { out.push(u) }
      continue
    }
    if (/^https?:\/\//.test(u)) {
      try { out.push(ASSET_PREFIX + await putAsset(dir, { url: u })) } catch { out.push(u) }
      continue
    }
    out.push(u)
  }
  return out
}

/* 项目数据全量本地化；返回仍含失效外链的节点 id。projKey 为存储 key */
async function localizeProjectData(projKey, data) {
  const lostNodes = []
  for (const n of data?.nodes || []) {
    const d = n.data
    if (!d) continue
    if (Array.isArray(d.urls)) d.urls = await localizeList(projKey, d.urls)
    if (Array.isArray(d.refImages)) d.refImages = await localizeList(projKey, d.refImages)
    const stillRemote = [...(d.urls || []), ...(d.refImages || [])]
      .some((u) => typeof u === 'string' && /^https?:\/\//.test(u))
    if (stillRemote) { if (!d.sourceLost) d.sourceLost = true; lostNodes.push(n.id) }
    else if (d.sourceLost) delete d.sourceLost
  }
  return { lostNodes }
}

/* assets: 引用 → file:// 供渲染端 <img> 直接显示。projKey 为存储 key */
function expandAssets(projKey, data) {
  const base = assetsBaseUrl(projKey)
  for (const n of data?.nodes || []) {
    const d = n.data
    if (!d) continue
    if (Array.isArray(d.urls)) d.urls = d.urls.map((u) =>
      (typeof u === 'string' && u.startsWith(ASSET_PREFIX) ? base + u.slice(ASSET_PREFIX.length) : u))
    if (Array.isArray(d.refImages)) d.refImages = d.refImages.map((u) =>
      (typeof u === 'string' && u.startsWith(ASSET_PREFIX) ? base + u.slice(ASSET_PREFIX.length) : u))
  }
  return data
}

/* file:///...assets/... → dataURL（发给 API 前） */
function inlineLocalAssetUrls(body) {
  const root = path.resolve(assetsRoot())
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const o = {}
      for (const [k, x] of Object.entries(v)) o[k] = walk(x)
      return o
    }
    if (typeof v === 'string' && v.startsWith('file:///')) {
      try {
        const p = toLocalPath(v)
        if (p.startsWith(root)) {
          const ext = path.extname(p).slice(1).toLowerCase()
          const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : 'image/' + (ext || 'png')
          return `data:${mime};base64,` + fs.readFileSync(p).toString('base64')
        }
      } catch { return v }
    }
    return v
  }
  return walk(body)
}

/* 项目列表缩略图/元信息索引：保存与迁移时写 <key>.meta.json，列表只读 meta 不再全量解析 */
function metaFileFor(key) { return path.join(projectsDir(), key + '.meta.json') }
function writeProjectMeta(disp, key, data, savedAt, pinned) {
  try {
    const dir = assetsDirFor(key)
    const thumbs = []
    for (const n of data?.nodes || []) {
      for (const u of n.data?.urls || []) {
        if (typeof u !== 'string') continue
        // REF-002：能落到本地资产就取 thumbs/ 下的 WebP（未生成时回退原图），外链原样透传
        if (u.startsWith(ASSET_PREFIX)) thumbs.push(thumbOrOriginal(path.join(dir, u.slice(ASSET_PREFIX.length))))
        else if (/^https?:\/\/.+\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(u)) thumbs.push(u)
        if (thumbs.length >= 3) break
      }
      if (thumbs.length >= 3) break
    }
    fs.writeFileSync(metaFileFor(key), JSON.stringify({
      name: disp, savedAt, nodeCount: (data?.nodes || []).length, pinned: !!pinned, thumbs
    }, null, 1))
  } catch { /* meta 写失败不影响主流程（列表回退全量解析） */ }
}

// 设置页"测试连接"：逐个入口探测
ipcMain.handle('apimart:test', async (e, { apiKey }) => {
  const s = { ...readSettings(), apiKey: apiKey ?? readSettings().apiKey }
  const results = []
  for (const base of [...new Set([s.baseUrl, ...FALLBACKS])]) {
    try {
      const r = await fetchJson(base, { urlPath: '/v1/models', apiKey: s.apiKey })
      results.push({ url: base, ok: true, status: r.status, keyValid: r.status === 200 })
    } catch (err) {
      results.push({ url: base, ok: false, status: 0 })
    }
  }
  return results
})

/* ---------- 生成结果下载（图片/视频 URL 24h 过期，必须落盘） ----------
   阶段0修复⑩：subdir 白名单 + 文件名消毒 + 解析后路径必须仍在输出目录内
   （旧版 path.join(outputDir(), subdir) 可被 subdir='../../' 带出输出根，filename 同理） */
const DOWNLOAD_SUBDIRS = new Set(['images', 'videos', 'audio'])
const safeFileName = (f, fallback) => {
  const base = path.basename(String(f || '').replace(/[\x00-\x1f]/g, '_'))
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned || fallback
}
ipcMain.handle('download', async (e, { url, subdir, filename }) => {
  const sub = DOWNLOAD_SUBDIRS.has(subdir) ? subdir : 'images'
  const dir = path.join(outputDir(), sub)
  await fsp.mkdir(dir, { recursive: true })
  const file = path.resolve(dir, safeFileName(filename, `out_${Date.now()}`))
  if (!isInside(outputDir(), file)) throw new Error('下载路径越界')
  // 支持 data:URL（OpenAI 风格 b64_json 同步响应）
  if (String(url).startsWith('data:')) {
    const b64 = url.slice(url.indexOf(',') + 1)
    await fsp.writeFile(file, Buffer.from(b64, 'base64'))
    return file
  }
  // ARCH-001：本地资产 file:// 引用直接复制，不走网络栈（源文件也必须位于资产根内）
  if (String(url).startsWith('file://')) {
    const src = toLocalPath(url)
    if (!isInside(assetsRoot(), src)) throw new Error('本地资产路径越界: ' + src)
    if (fs.existsSync(src)) { await fsp.copyFile(src, file); return file }
    throw new Error('本地资产不存在: ' + src)
  }
  const resp = await net.fetch(url)
  if (!resp.ok) throw new Error('download failed: ' + resp.status)
  const buf = Buffer.from(await resp.arrayBuffer())
  await fsp.writeFile(file, buf)
  return file
})

/* ---------- 模型库同步：用全站 Key 拉 /v1/models，返回全部可用模型 id ---------- */
ipcMain.handle('models:sync', async (e, { apiKey, baseUrl } = {}) => {
  const s = readSettings()
  const key = String(apiKey || s.apiKey || '').trim()
  if (!key) return { ok: false, error: '请先填写能调用全站模型的主 API Key' }
  const bases = [...new Set([baseUrl, s.baseUrl, ...FALLBACKS].filter(Boolean))]
  const errs = []
  for (const b of bases) {
    try {
      const r = await fetchJson(b, { urlPath: '/v1/models', apiKey: key })
      if (r.status === 401 || r.status === 403) {
        errs.push(`${b} → Key 无效或无权限（${r.status}）`)
        continue
      }
      if (r.status !== 200) { errs.push(`${b} → HTTP ${r.status}`); continue }
      const raw = r.json?.data || r.json?.models || []
      const ids = [...new Set(raw.map((m) => (typeof m === 'string' ? m : m.id || m.model || m.name)).filter(Boolean))]
      if (!ids.length) { errs.push(`${b} → 返回空列表`); continue }
      stickyBase = b
      return { ok: true, base: b, models: ids.sort((x, y) => x.localeCompare(y)) }
    } catch (err) {
      errs.push(`${b} → ${String(err.message || err).slice(0, 80)}`)
    }
  }
  return { ok: false, error: '拉取失败：' + errs.join(' ｜ ') }
})

/* ---------- 任务中心 store（S17-0b / TECH-005）：userData/tasks.json ----------
   跨视图、跨窗口共享的任务记录。设计要点：
   1) 合并写：按 id upsert + 显式 remove，多窗口各写各的任务，不会互相覆盖整份文件；
   2) 心跳：running 任务随写带 beatAt，超过 TASK_STALE_MS 没有心跳（进程被杀/崩溃/断电）
      即为「已中止」——读取时如实归一化为 aborted，绝不留下假的「执行中/已完成」；
   3) 广播：写入后通知其他窗口刷新，首页与画布共用同一份数据。 */
const TASK_STALE_MS = 20000
const TASK_ABORT_REASON = '应用已关闭，任务已中止'
const taskFile = () => path.join(app.getPath('userData'), 'tasks.json')

function readTasks() {
  try {
    const raw = JSON.parse(fs.readFileSync(taskFile(), 'utf-8'))
    return Array.isArray(raw?.tasks) ? raw.tasks : []
  } catch (_) {
    return [] // 文件缺失/损坏：当作没有任务，不影响启动
  }
}

function writeTasks(list) {
  try {
    fs.mkdirSync(path.dirname(taskFile()), { recursive: true })
    const tmp = taskFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: list }, null, 1), 'utf-8')
    fs.renameSync(tmp, taskFile()) // 原子替换：中途断电不会留下半份 JSON
    return true
  } catch (_) {
    return false
  }
}

/* 心跳过期的 running → aborted（崩溃/强杀/渲染进程卡死后的统一一致性修复） */
function normalizeStaleTasks(list, liveSessions) {
  const now = Date.now()
  let changed = false
  const out = list.map((t) => {
    // S17-3：挂起等确认（paused）也属于「未结束」——窗口没了就不能一直挂着
    if (t?.status !== 'running' && t?.status !== 'paused') return t
    const alive = t.session && liveSessions.has(t.session)
    const beatFresh = now - (Number(t.beatAt) || 0) <= TASK_STALE_MS
    if (alive && beatFresh) return t
    changed = true
    return { ...t, status: 'aborted', endedAt: t.endedAt || Number(t.beatAt) || now, error: TASK_ABORT_REASON }
  })
  return { tasks: out, changed }
}

/* 窗口会话登记：窗口还活着 = 它发起的任务就有资格继续 running；
   窗口关闭（含崩溃）后它的 running 任务在下一次读取时一律落为 aborted */
const liveTaskSessions = new Map() // webContents.id → sessionId
ipcMain.handle('tasks:hello', (e, args) => {
  const sid = String(args?.sessionId || '')
  if (!sid) return { ok: false }
  const wcId = e.sender.id
  liveTaskSessions.set(wcId, sid)
  e.sender.once('destroyed', () => liveTaskSessions.delete(wcId))
  return { ok: true }
})

ipcMain.handle('tasks:read', (e, args) => {
  const sessions = new Set(liveTaskSessions.values())
  if (args?.sessionId) sessions.add(String(args.sessionId))
  const { tasks, changed } = normalizeStaleTasks(readTasks(), sessions)
  if (changed) writeTasks(tasks)
  return { tasks }
})

ipcMain.handle('tasks:merge', (e, args) => {
  const upsert = Array.isArray(args?.upsert) ? args.upsert.filter((t) => t && t.id) : []
  const remove = Array.isArray(args?.remove) ? args.remove : []
  const sid = String(args?.sessionId || '')
  if (sid) liveTaskSessions.set(e.sender.id, sid)
  const cur = readTasks()
  const byId = new Map(cur.map((t) => [t.id, t]))
  for (const t of upsert) {
    const old = byId.get(t.id)
    // updatedAt 旧于磁盘版本时忽略（多窗口并发下的乱序写保护）
    if (old && Number(old.updatedAt) > Number(t.updatedAt)) continue
    byId.set(t.id, t)
  }
  for (const id of remove) byId.delete(id)
  // 只保留最近 50 条，避免文件无限增长
  const list = [...byId.values()].sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0)).slice(0, 50)
  const ok = writeTasks(list)
  /* 通知其他窗口（不回发来源窗口，避免自激） */
  const from = e?.sender?.id
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.id === from || w.webContents.isDestroyed()) continue
    w.webContents.send('tasks:changed', { tasks: list })
  }
  return { ok, tasks: list }
})

/* ---------- 草稿自动保存 store（S19 / ARCH-003）：userData/drafts/draft.json ----------
   与 projects/ 彻底隔离，只承载「未命名画布」的崩溃恢复草稿。设计要点：
   1) 串行写队列 + 单槽积压：draft:save 到来时只保留最新数据，排队逐个落盘时
      直接取最新一份——中间态一律丢弃，同一时刻最多一个写盘；
   2) 原子写：.tmp + renameSync（与 tasks.json 同模式），崩溃不会留半个 JSON；
   3) 崩溃恢复：启动时 drafts 非空 → 弹询问（ISLE_DRAFT_AUTO=restore|discard
      自动化钩子），选择结果经 draft:pending 交给渲染端执行，全部走完才清空 */
const draftFile = () => path.join(app.getPath('userData'), 'drafts', 'draft.json')

function readDraft() {
  try { return JSON.parse(fs.readFileSync(draftFile(), 'utf-8')) } catch { return null }
}

function writeDraft(payload) {
  try {
    fs.mkdirSync(path.dirname(draftFile()), { recursive: true })
    const tmp = draftFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf-8')
    fs.renameSync(tmp, draftFile())
    return true
  } catch { return false }
}

function clearDraft() {
  try { fs.rmSync(draftFile(), { force: true }); return true } catch { return false }
}

/* 串行写队列 + 单槽积压：writing 期间新来的 save 覆盖 pendingSlot；
   每次写盘完成后若槽里有更新数据则继续写，否则队列空闲 */
let draftWriting = false
let draftPendingSlot = null
function enqueueDraftWrite(payload) {
  draftPendingSlot = payload // 只留最新
  if (draftWriting) return Promise.resolve({ ok: true, queued: true })
  draftWriting = true
  const step = () => {
    const p = draftPendingSlot
    draftPendingSlot = null
    if (!p) { draftWriting = false; return Promise.resolve({ ok: true }) }
    writeDraft(p)
    debugLog(`DRAFT saved (${(p?.nodes || []).length} nodes)`)
    return step() // 槽里可能又有新的
  }
  return Promise.resolve().then(step).catch(() => ({ ok: false }))
}

let pendingDraftAction = null // 'restore' | 'discard'，启动询问的结果，渲染端经 draft:pending 领取
ipcMain.handle('draft:save', (e, args) => {
  const payload = args && typeof args === 'object' ? { ...args, savedAt: Date.now() } : null
  if (!payload || !Array.isArray(payload.nodes)) return { ok: false, error: 'draft payload invalid' }
  return enqueueDraftWrite(payload).then((r) => ({ ok: r.ok !== false }))
})
ipcMain.handle('draft:load', () => {
  const d = readDraft()
  return d ? { ok: true, data: d } : { ok: false }
})
ipcMain.handle('draft:clear', () => ({ ok: clearDraft() }))
ipcMain.handle('draft:pending', () => {
  const a = pendingDraftAction
  pendingDraftAction = null // 只领取一次
  return { action: a }
})

/* ---------- Isle 会话持久化 + 项目记忆（S20 / REQ-006b / TECH-006）----------
   userData/sessions/<key>.json（会话）与 <key>.memory.json（项目记忆）。
   key：未命名画布固定 global；命名项目 proj:<名称>（文件名做消毒）。
   写法复用 tasks.json 的 .tmp + rename 原子替换；读写失败一律静默返回空，
   绝不阻塞聊天与委托执行主流程。 */
const sessionsDir = () => path.join(app.getPath('userData'), 'sessions')
const safeKey = (k) => {
  const s = String(k || 'global').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80)
  return s || 'global'
}
const sessionFile = (key) => path.join(sessionsDir(), safeKey(key) + '.json')
const memoryFile = (key) => path.join(sessionsDir(), safeKey(key) + '.memory.json')

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return null }
}
function writeJsonFile(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf-8')
    fs.renameSync(tmp, file)
    return true
  } catch { return false }
}

ipcMain.handle('session:load', (e, args) => {
  const d = readJsonFile(sessionFile(args?.key))
  if (!d || !Array.isArray(d.messages)) return { ok: false }
  return { ok: true, messages: d.messages, summary: d.summary || null, updatedAt: d.updatedAt || null }
})
ipcMain.handle('session:save', (e, args) => {
  const msgs = Array.isArray(args?.messages) ? args.messages : null
  if (!msgs) return { ok: false }
  const ok = writeJsonFile(sessionFile(args.key), {
    version: 1,
    messages: msgs.slice(-1000), // 硬上限防无限膨胀
    summary: typeof args.summary === 'string' ? args.summary : null,
    updatedAt: Date.now()
  })
  return { ok }
})
ipcMain.handle('memory:load', (e, args) => {
  const d = readJsonFile(memoryFile(args?.key))
  return { ok: true, entries: Array.isArray(d?.entries) ? d.entries : [] }
})
ipcMain.handle('memory:save', (e, args) => {
  const entry = args?.entry
  if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return { ok: false }
  const d = readJsonFile(memoryFile(args.key)) || { entries: [] }
  if (!Array.isArray(d.entries)) d.entries = []
  d.entries.push({ text: entry.text.trim().slice(0, 500), at: Date.now(), source: String(entry.source || 'user').slice(0, 20) })
  // 只保留最近 100 条
  d.entries = d.entries.slice(-100)
  return { ok: writeJsonFile(memoryFile(args.key), d) }
})
ipcMain.handle('memory:delete', (e, args) => {
  const idx = Number(args?.index)
  const d = readJsonFile(memoryFile(args?.key)) || { entries: [] }
  if (!Array.isArray(d.entries) || !(idx >= 0 && idx < d.entries.length)) return { ok: false }
  d.entries.splice(idx, 1)
  return { ok: writeJsonFile(memoryFile(args.key), d) }
})
ipcMain.handle('memory:clear', (e, args) => {
  try { fs.rmSync(memoryFile(args?.key), { force: true }); return { ok: true } } catch { return { ok: false } }
})

/* ---------- 设置页「数据」区（S21 / Q3-4 / REF-010 / REF-009）---------- */
function dirSize(dir) {
  let total = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.isDirectory()) total += dirSize(p)
      else total += st.size
    }
  } catch { /* 目录不存在按 0 */ }
  return total
}
ipcMain.handle('storage:usage', () => {
  const base = app.getPath('userData')
  let assets = 0
  let thumbs = 0
  try {
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f)
        let st
        try { st = fs.statSync(p) } catch { continue }
        if (st.isDirectory()) {
          if (f === 'thumbs') thumbs += dirSize(p) // 缩略图分列统计（assets/<项目>/thumbs/）
          else walk(p)
        } else assets += st.size
      }
    }
    walk(assetsRoot())
  } catch { /* 无 assets 目录 */ }
  const usage = {
    projects: dirSize(projectsDir()),
    assets, thumbs,
    templates: dirSize(templatesDir()),
    drafts: dirSize(path.join(base, 'drafts')),
    sessions: dirSize(sessionsDir())
  }
  usage.total = usage.projects + usage.assets + usage.templates + usage.drafts + usage.sessions
  return { ok: true, usage }
})
ipcMain.handle('storage:clear-thumbs', () => {
  let freed = 0
  try {
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f)
        let st
        try { st = fs.statSync(p) } catch { continue }
        if (!st.isDirectory()) continue
        if (f === 'thumbs') {
          freed += dirSize(p)
          fs.rmSync(p, { recursive: true, force: true })
        } else walk(p)
      }
    }
    walk(assetsRoot())
    return { ok: true, freed }
  } catch (err) { return { ok: false, error: String(err.message || err) }
  }
})

/* S21-2 配置导入导出。安全硬约束：
   - enc:v1 值是 DPAPI 本机绑定密文：默认导出一律替换为占位符 __KEY_REDACTED__；
     「包含 Key」选项必须由渲染端二次确认后才传 includeKeys=true，此时解密回明文（跨机导入需重新保存）
   - 绝不导出 userData/Local State 的 os_crypt key（本函数只读配置文件本身，物理上碰不到） */
const KEY_REDACTED = '__KEY_REDACTED__'

function decryptOne(v) {
  try {
    if (typeof v !== 'string' || !v.startsWith('enc:v1:') || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(v.slice('enc:v1:'.length), 'base64'))
  } catch { return null }
}
function sanitizeConfigForExport(cfg, includeKeys) {
  const clone = JSON.parse(JSON.stringify(cfg))
  delete clone.catalogBase // 目录来源主机名无意义且可能带隐私
  /* key 字段三种形态统一处理：
     - enc:v1 密文：默认导出 → 占位符；含 Key 导出 → 解密回明文（跨机解密失败也回退占位）
     - 明文（异常/老配置）：默认导出一律占位，绝不明文出文件 */
  const keyVal = (v, includeKeys) => {
    if (typeof v !== 'string' || !v) return v
    if (v.startsWith('enc:v1:')) {
      if (!includeKeys) return KEY_REDACTED
      const plain = decryptOne(v)
      return plain != null ? plain : KEY_REDACTED
    }
    return includeKeys ? v : KEY_REDACTED
  }
  const walk = (o) => {
    for (const k of Object.keys(o)) {
      const v = o[k]
      if (k === 'modelKeys' && v && typeof v === 'object' && !Array.isArray(v)) {
        o[k] = Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, keyVal(vv, includeKeys)]))
        continue
      }
      if (v && typeof v === 'object') walk(v)
      else if (k === 'apiKey') o[k] = keyVal(v, includeKeys)
    }
  }
  walk(clone)
  return clone
}
ipcMain.handle('config:export-file', async (e, { includeKeys } = {}) => {
  try {
    const exported = sanitizeConfigForExport(readSettingsRaw(), !!includeKeys)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    let filePath = null
    /* ISLE_CONFIG_EXPORT：自动化测试钩子，指定输出路径时跳过另存为对话框 */
    if (process.env.ISLE_CONFIG_EXPORT) {
      filePath = process.env.ISLE_CONFIG_EXPORT
    } else {
      const r = await dialog.showSaveDialog(BrowserWindow.getAllWindows()[0], {
        title: '导出配置',
        defaultPath: path.join(outputDir(), `isle-studio-config_${stamp}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (r.canceled || !r.filePath) return { ok: false, canceled: true }
      filePath = r.filePath
    }
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, exportedAt: Date.now(), includeKeys: !!includeKeys, config: exported }, null, 2), 'utf-8')
    debugLog(`CONFIG EXPORT -> ${filePath} (includeKeys=${!!includeKeys})`)
    return { ok: true, file: filePath }
  } catch (err) { return { ok: false, error: String(err.message || err) } }
})
ipcMain.handle('config:import-file', async (e, { overwrite } = {}) => {
  try {
    let srcFile = null
    /* ISLE_CONFIG_IMPORT：自动化测试钩子，指定来源文件时跳过打开对话框 */
    if (process.env.ISLE_CONFIG_IMPORT) {
      srcFile = process.env.ISLE_CONFIG_IMPORT
    } else {
      const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
        title: '导入配置',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (canceled || !filePaths?.length) return { ok: false, canceled: true }
      srcFile = filePaths[0]
    }
    const parsed = JSON.parse(fs.readFileSync(srcFile, 'utf-8'))
    const inc = parsed?.config && typeof parsed.config === 'object' ? parsed.config : null
    if (!inc) return { ok: false, error: '文件里没有配置数据' }
    const cur = readSettings()
    const added = []
    let skipped = 0
    let overwritten = 0
    /* 明文 Key → 能加密则加密落盘（与接口页保存同路径） */
    const secure = (v) => {
      if (typeof v !== 'string' || !v || v.startsWith('enc:v1:') || v === KEY_REDACTED) return v
      try { if (canEncrypt()) return 'enc:v1:' + safeStorage.encryptString(v).toString('base64') } catch { }
      return v
    }
    /* 模型列表：按 model 名合并（默认跳过同名；overwrite 覆盖同名） */
    for (const cat of ['image', 'video', 'chat']) {
      const list = inc.models?.[cat]
      if (!Array.isArray(list)) continue
      cur.models = cur.models || {}
      cur.models[cat] = Array.isArray(cur.models[cat]) ? cur.models[cat] : []
      for (const m of list) {
        if (!m?.model) continue
        const idx = cur.models[cat].findIndex((x) => x?.model === m.model)
        if (idx >= 0 && !overwrite) { skipped++; continue }
        const nm = { ...m }
        /* KEY_REDACTED 占位 =「脱敏，无实际值」：覆盖同名时保留现条目 Key，绝不把占位符写进配置 */
        if (nm.apiKey === KEY_REDACTED) {
          if (idx >= 0) nm.apiKey = cur.models[cat][idx].apiKey
          else nm.apiKey = ''
        } else if (typeof nm.apiKey === 'string') nm.apiKey = secure(nm.apiKey)
        if (idx >= 0) { cur.models[cat][idx] = nm; overwritten++ } else { cur.models[cat].push(nm); added.push(cat + ':' + m.model) }
      }
    }
    /* 其余字段：默认只填现有空值；overwrite 才覆盖已有非空值 */
    for (const k of ['apiKey', 'baseUrl', 'modelKeys', 'outputDir', 'autoRunAgent', 'generation', 'defaultModels', 'catalog', 'catalogBase', 'personaNote', 'agentSlogan']) {
      if (!(k in inc)) continue
      let v = inc[k]
      if (v === KEY_REDACTED) { skipped++; continue } // 脱敏占位：视为无值，不覆盖现配置
      if (typeof v === 'string' && /key$/i.test(k)) v = secure(v)
      const has = cur[k] !== undefined && cur[k] !== null && cur[k] !== '' && !(typeof cur[k] === 'object' && !Array.isArray(cur[k]) && !Object.keys(cur[k]).length)
      if (has && !overwrite) { skipped++; continue }
      if (has) overwritten++
      cur[k] = v
    }
    writeSettings(cur)
    debugLog(`CONFIG IMPORT from ${srcFile} (overwrite=${!!overwrite}, added=${added.length}, skipped=${skipped}, overwritten=${overwritten})`)
    return { ok: true, added: added.length, skipped, overwritten }
  } catch (err) { return { ok: false, error: String(err.message || err) } }
})

/* ---------- 项目持久化：userData/projects/<名称>.json ---------- */
function projectsDir() {
  return path.join(app.getPath('userData'), 'projects')
}
/* 阶段0修复⑨：文件名消毒强化。旧版不处理 '.'/'..'，name='..' 会令 assetsDirFor 解析到
   assets 根目录、项目文件写到上级目录（project:delete 曾可删掉整个 assets 根）。
   同时剥离控制字符与结尾点/空格（Windows 文件名非法/自动截断）。 */
const safeProjName = (n) => {
  let s = String(n ?? '').replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').slice(0, 80).trim()
  if (/^\.+$/.test(s)) s = '_'
  s = s.replace(/[. ]+$/, '') // 结尾点/空格：Windows 会静默吞掉，导致同名冲突或路径错位
  return s || '未命名'
}
/* 阶段0修复⑨：路径包含判定（child 必须严格位于 parent 内部，不含同级前缀目录名） */
const isInside = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/* 定向复审 P0-3：旧项目文件名兼容。
   旧版 safeProjName 不剥离结尾点/空格、不把纯点映射 '_'，旧库存文件可能是 `项目1..json`；
   新规则会把显示名 `项目1.` 定位到 `项目1.json` —— 两个文件并存时必须避免误定位/误覆盖另一项目。
   解析策略（读与写共用，保证同一显示名在 load/save/delete 间定位一致）：
   - 仅新名文件存在 → 新名；仅旧名文件存在 → 旧名（保号兼容，不分裂项目）；
   - 两者并存 → 读 JSON 内 name 字段精确匹配显示名者；打平取 savedAt 较新者；再打平取新名；
     未选中的文件保持原样不动（数据不丢），并在返回值标注 ambiguous 供上层提示。
   - 两者都不存在 → 新名（新项目的规范名）。 */
const legacyProjName = (n) => String(n || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名'
function resolveProjectEntry(name) {
  const disp = String(name ?? '').trim().slice(0, 80) || '未命名'
  const newKey = safeProjName(disp)
  const legacyKey = legacyProjName(disp)
  const fileOf = (k) => path.join(projectsDir(), k + '.json')
  const newFile = fileOf(newKey)
  const legacyFile = fileOf(legacyKey)
  const newExists = fs.existsSync(newFile)
  const legacyExists = legacyKey !== newKey && fs.existsSync(legacyFile)
  let key = newKey
  let file = newFile
  let ambiguous = false
  if (legacyExists) {
    ambiguous = newExists
    key = legacyKey
    file = legacyFile
    if (newExists) {
      let best = null
      for (const [k, f] of [[newKey, newFile], [legacyKey, legacyFile]]) {
        try {
          const j = JSON.parse(fs.readFileSync(f, 'utf-8'))
          const score = (j.name === disp ? 2e15 : 0) + (Number(j.savedAt) || 0)
          if (best === null || score > best.score) best = { k, f, score }
        } catch { /* 损坏文件不参与消解 */ }
      }
      if (best) { key = best.k; file = best.f }
    }
  }
  return { disp, key, file, newKey, legacyKey, newFile, legacyFile, ambiguous }
}

/* 定向复审 P1-1：主进程侧写入协调。
   渲染端的保存串行队列只属于单个窗口；多窗口（project:open-window）与
   加载迁移回写都会并发触碰同一项目文件。这里按存储 key 串行化所有写路径，
   并做乐观版本检查：渲染端带上它已知的 baseSavedAt（来自 load/save 回执），
   磁盘 savedAt 已被别处推进 → 拒绝覆盖并回传 conflict，由用户重读后再决定 */
const projWriteChains = new Map()
const withProjLock = (key, fn) => {
  const run = (projWriteChains.get(key) || Promise.resolve()).then(fn, fn)
  projWriteChains.set(key, run.then(() => {}, () => {}))
  return run
}

ipcMain.handle('project:save', async (e, { name, data, baseSavedAt, sessionId } = {}) => {
  fs.mkdirSync(projectsDir(), { recursive: true })
  /* 定向复审 P0-3：读/写共用同一套新名/旧名解析，同一显示名在 load/save 间定位一致；
     两文件并存时选中者被更新、未选中者保持原样（数据不丢） */
  let entry = resolveProjectEntry(name)
  /* 首次保存撞名保护：新会话（baseSavedAt==null）保存时若同名项目已存在，
     说明是另一份内容（未命名项目按分钟自动命名，同一分钟内连存两个必撞名），
     自动改用不重复的名字而不是静默覆盖丢数据；渲染端 setProjectName(r.name)
     会采纳返回名，两端保持一致。已加载项目的再保存带 baseSavedAt，不受影响。 */
  if (baseSavedAt == null && fs.existsSync(entry.file)) {
    for (let i = 2; fs.existsSync(entry.file); i++) entry = resolveProjectEntry(entry.disp + ` (${i})`)
  }
  return withProjLock(entry.key, async () => {
    const disp = entry.disp
    const file = entry.file
    const key = entry.key
    let prevPinned = false
    let prevSavedAt = null
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf-8'))
      prevPinned = !!prev.pinned
      prevSavedAt = prev.savedAt ?? null
    } catch { /* 新项目 */ }
    /* 定向复审 P1-1：乐观版本检查。磁盘 savedAt 已被其他窗口推进 → 拒绝本次覆盖 */
    if (baseSavedAt != null && prevSavedAt != null && Number(prevSavedAt) > Number(baseSavedAt)) {
      return { ok: false, conflict: true, savedAt: prevSavedAt, error: '项目文件已被其他窗口更新，本次保存被拒绝以免覆盖。请返回主页重新打开该项目后再继续编辑。' }
    }
    /* savedAt 严格单调（同毫秒并发保存也不产生相同版本号） */
    const savedAt = Math.max(Date.now(), (Number(prevSavedAt) || 0) + 1)
    let work
    try { work = JSON.parse(JSON.stringify(data)) } catch { return { ok: false, error: '项目数据无法序列化' } }
    /* UI 瞬态不落盘（Q1-2 修复）：selected 选中态只属于当前会话，
       持久化会导致重开后带着异常选中并与程序内 setSelectedId 相互拉扯 */
    if (Array.isArray(work.nodes)) work.nodes = work.nodes.map((n) => (n.selected === undefined ? n : (({ selected, ...rest }) => rest)(n)))
    if (Array.isArray(work.edges)) work.edges = work.edges.map((ed) => (ed.selected === undefined ? ed : (({ selected, ...rest }) => rest)(ed)))
    // ARCH-001：保存前把 dataURL/外链 全部落盘为 assets: 引用（失败保留原值不阻塞保存）
    /* 未命名会话暂存目录里的产物会在这里被复制进正式项目目录；记下是否用到，
       写完盘后整目录回收并把引用前缀回传渲染端做重映射（避免留副本、画面不中断） */
    const sidKey = sessionId ? UNNAMED_PREFIX + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) : ''
    const unnamedBase = sidKey ? assetsBaseUrl(sidKey) : ''
    const usedUnnamed = !!unnamedBase && JSON.stringify(work).includes(unnamedBase)
    try { await localizeProjectData(key, work) } catch { /* 忽略整体异常，按原数据保存 */ }
    /* 阶段0修复⑤：原子写入——先写临时文件再改名替换，进程中途被杀不会留下半个项目 JSON */
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ name: disp, savedAt, data: work }, null, 1))
    fs.renameSync(tmp, file)
    writeProjectMeta(disp, key, work, savedAt, prevPinned)
    /* 保存后清掉已经搬空的未命名暂存目录（还留着未被引用的文件则保留） */
    try {
      const root = assetsRoot()
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith(UNNAMED_PREFIX)) continue
        const dp = path.join(root, d.name)
        const remain = fs.readdirSync(dp).filter((f) => f !== 'thumbs')
        if (!remain.length) fs.rmSync(dp, { recursive: true, force: true })
      }
    } catch { /* 清理失败不影响保存 */ }
    let assetRemap = null
    if (usedUnnamed) {
      // 本次保存的产物已并入项目目录，会话暂存目录整体回收
      try { fs.rmSync(assetsDirFor(sidKey), { recursive: true, force: true }) } catch { /* 占用中下次再清 */ }
      assetRemap = { from: unnamedBase, to: assetsBaseUrl(key) }
    }
    const lostCount = (work.nodes || []).filter((n) => n.data?.sourceLost).length
    return { ok: true, name: disp, savedAt, file, lostCount, ...(assetRemap ? { assetRemap } : {}), ...(entry.ambiguous ? { warning: '存在新旧两个同名项目文件，本次保存写入其中较匹配的一个，另一个未改动' } : {}) }
  })
})

/* 从节点产物里取封面缩略图：dataURL 图片用 nativeImage 压到 480 宽 JPEG，远程图片直接透传 */
function thumbOf(url) {
  try {
    if (!url || typeof url !== 'string') return null
    if (url.startsWith('data:image/')) {
      const img = nativeImage.createFromDataURL(url)
      if (img.isEmpty()) return null
      const { width } = img.getSize()
      const small = width > 480 ? img.resize({ width: 480 }) : img
      return 'data:image/jpeg;base64,' + small.toJPEG(70).toString('base64')
    }
    if (/^https?:\/\//.test(url) && !/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) return url
  } catch { /* 取不到缩略图就返回空 */ }
  return null
}

ipcMain.handle('project:list', () => {
  const dir = projectsDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')).map((f) => {
    // ARCH-001：优先读 meta 索引（保存/迁移时已写），不再全量解析大 JSON
    const metaFile = path.join(dir, f.replace(/\.json$/, '.meta.json'))
    if (fs.existsSync(metaFile)) {
      try { return JSON.parse(fs.readFileSync(metaFile, 'utf-8')) } catch { /* 损坏则回退全量解析 */ }
    }
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
      const thumbs = []
      for (const n of j.data?.nodes || []) {
        for (const u of n.data?.urls || []) {
          const t = thumbOf(u)
          if (t) thumbs.push(t)
          if (thumbs.length >= 3) break
        }
        if (thumbs.length >= 3) break
      }
      return { name: j.name, savedAt: j.savedAt, nodeCount: (j.data?.nodes || []).length, pinned: !!j.pinned, thumbs }
    } catch { return null }
  }).filter(Boolean).sort((a, b) => (b.pinned - a.pinned) || (b.savedAt - a.savedAt))
})

ipcMain.handle('project:load', async (e, { name }) => {
  /* 定向复审 P0-3：与 save/delete 同一套新名/旧名解析，旧库存文件可继续打开。
     定向复审 P1-1：读+迁移回写整体参加该项目的写串行链，不与保存交错 */
  const entry = resolveProjectEntry(name)
  return withProjLock(entry.key, async () => {
    try {
      const file = entry.file
      const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
      let work
      try { work = JSON.parse(JSON.stringify(j.data)) } catch { work = j.data }
      /* 兼容旧文件（Q1-2 修复）：历史上 selected 被持久化过，加载时一律剥掉 */
      if (Array.isArray(work.nodes)) work.nodes.forEach((n) => { delete n.selected })
      if (Array.isArray(work.edges)) work.edges.forEach((ed) => { delete ed.selected })
      let migrated = false, lostCount = 0
      try {
        const before = JSON.stringify(work)
        await localizeProjectData(entry.key, work)
        if (JSON.stringify(work) !== before) {
          // ARCH-001：旧项目首次打开一次性迁移并回写；回写失败保留原文件，下次打开重试
          fs.writeFileSync(file, JSON.stringify({ ...j, data: work }, null, 1))
          migrated = true
        }
        lostCount = (work.nodes || []).filter((n) => n.data?.sourceLost).length
      } catch { /* 迁移异常返回原数据，不阻塞打开 */ }
      return { ok: true, data: expandAssets(entry.key, work), name: j.name || entry.disp, savedAt: j.savedAt ?? null, migrated, lostCount }
    } catch (err) {
      return { ok: false, error: String(err.message || err) }
    }
  })
})

ipcMain.handle('project:pin', (e, { name, pinned }) => {
  try {
    const entry = resolveProjectEntry(name) // 定向复审 P0-3
    const j = JSON.parse(fs.readFileSync(entry.file, 'utf-8'))
    j.pinned = !!pinned
    fs.writeFileSync(entry.file, JSON.stringify(j, null, 1))
    try {
      const mf = metaFileFor(entry.key)
      if (fs.existsSync(mf)) {
        const meta = JSON.parse(fs.readFileSync(mf, 'utf-8'))
        meta.pinned = j.pinned
        fs.writeFileSync(mf, JSON.stringify(meta, null, 1))
      }
    } catch { /* meta 更新失败不影响 pin */ }
    return { ok: true, pinned: j.pinned }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})

ipcMain.handle('project:rename', (e, { name, newName }) => {
  try {
    const disp = String(newName || '').trim().slice(0, 80)
    if (!disp) return { ok: false, error: '项目名不能为空' }
    /* 定向复审 P0-3：源文件按新名/旧名解析定位；目标名任一文件已存在即视为同名冲突 */
    const entry = resolveProjectEntry(name)
    const oldFile = entry.file
    const newKey = safeProjName(disp)
    const legacyKey = legacyProjName(disp)
    const newFile = path.join(projectsDir(), newKey + '.json')
    const newLegacyFile = path.join(projectsDir(), legacyKey + '.json')
    if ((fs.existsSync(newFile) && path.resolve(newFile) !== path.resolve(oldFile)) ||
        (legacyKey !== newKey && fs.existsSync(newLegacyFile) && path.resolve(newLegacyFile) !== path.resolve(oldFile))) {
      return { ok: false, error: '已存在同名项目' }
    }
    const j = JSON.parse(fs.readFileSync(oldFile, 'utf-8'))
    j.name = disp
    fs.writeFileSync(newFile, JSON.stringify(j, null, 1))
    if (path.resolve(newFile) !== path.resolve(oldFile)) fs.unlinkSync(oldFile)
    // ARCH-001：资产目录/索引跟着改名；改名后 JSON 里的引用按新目录展开
    try {
      const oldAssets = assetsDirFor(entry.key)
      if (fs.existsSync(oldAssets)) fs.renameSync(oldAssets, assetsDirFor(newKey))
    } catch { /* 资产目录改名失败不阻塞（旧目录仍在，内容寻址重复落盘无害） */ }
    try {
      const oldMeta = metaFileFor(entry.key)
      if (fs.existsSync(oldMeta)) {
        const meta = JSON.parse(fs.readFileSync(oldMeta, 'utf-8'))
        meta.name = disp
        fs.writeFileSync(metaFileFor(newKey), JSON.stringify(meta, null, 1))
        if (path.resolve(metaFileFor(newKey)) !== path.resolve(oldMeta)) fs.unlinkSync(oldMeta)
      }
    } catch { /* meta 迁移失败不影响改名 */ }
    return { ok: true, name: disp }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})

ipcMain.handle('project:delete', (e, { name }) => {
  try {
    /* 定向复审 P0-3：先解析（新名/旧名双轨）再删除，只删被解析选中的那一套文件与资产目录 */
    const entry = resolveProjectEntry(name)
    const aDir = path.resolve(assetsDirFor(entry.key))
    if (!isInside(assetsRoot(), aDir)) return { ok: false, error: '项目名非法，已拒绝删除' }
    fs.unlinkSync(entry.file)
    try { const mf = metaFileFor(entry.key); if (fs.existsSync(mf)) fs.unlinkSync(mf) } catch { /* meta 清理失败忽略 */ }
    try { fs.rmSync(aDir, { recursive: true, force: true }) } catch { /* 资产清理失败忽略 */ }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})

/* ---------- REQ-002 工作流模板：本地文件存储（userData/templates/<name>.json） ----------
   模板只存结构：节点类型/参数/连线/相对布局；产物与运行态在渲染端剥离后传入。
   与项目文件同一套文件名消毒规则，损坏文件在 list 中标 broken、load 返回明确错误。 */
function templatesDir() { return path.join(app.getPath('userData'), 'templates') }
const templateFile = (name) => path.join(templatesDir(), safeProjName(name) + '.json')

/* 新建模板：同名覆盖需显式 overwrite，避免误盖旧模板 */
ipcMain.handle('template:create', (e, { name, data, overwrite }) => {
  try {
    fs.mkdirSync(templatesDir(), { recursive: true })
    const disp = String(name || '').trim().slice(0, 80) || '未命名模板'
    const file = templateFile(disp)
    if (fs.existsSync(file) && !overwrite) return { ok: false, exists: true, error: '已存在同名模板' }
    fs.writeFileSync(file, JSON.stringify({ name: disp, savedAt: Date.now(), data }, null, 1))
    return { ok: true, name: disp, file }
  } catch (err) { return { ok: false, error: String(err.message || err) } }
})

ipcMain.handle('template:list', () => {
  try {
    const dir = templatesDir()
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
        return { name: j.name || f.replace(/\.json$/, ''), savedAt: j.savedAt || 0, nodeCount: (j.data?.nodes || []).length, broken: false }
      } catch {
        return { name: f.replace(/\.json$/, ''), savedAt: 0, nodeCount: 0, broken: true }
      }
    }).sort((a, b) => (b.savedAt - a.savedAt))
  } catch { return [] }
})

ipcMain.handle('template:load', (e, { name }) => {
  try {
    const file = templateFile(name)
    if (!fs.existsSync(file)) return { ok: false, error: '模板文件不存在，可能已被删除' }
    let j
    try { j = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return { ok: false, error: '模板文件已损坏，无法读取（现有项目不受影响）' } }
    if (!j?.data?.nodes) return { ok: false, error: '模板内容不完整（缺少节点数据）' }
    return { ok: true, name: j.name || name, data: j.data }
  } catch (err) { return { ok: false, error: String(err.message || err) } }
})

ipcMain.handle('template:rename', (e, { name, newName }) => {
  try {
    const from = templateFile(name)
    if (!fs.existsSync(from)) return { ok: false, error: '模板不存在' }
    const disp = String(newName || '').trim().slice(0, 80)
    if (!disp) return { ok: false, error: '名称不能为空' }
    const to = templateFile(disp)
    if (fs.existsSync(to) && path.resolve(to) !== path.resolve(from)) return { ok: false, error: '已存在同名模板' }
    const j = JSON.parse(fs.readFileSync(from, 'utf-8'))
    j.name = disp
    fs.writeFileSync(to, JSON.stringify(j, null, 1))
    if (path.resolve(to) !== path.resolve(from)) fs.unlinkSync(from)
    return { ok: true, name: disp }
  } catch (err) { return { ok: false, error: String(err.message || err) } }
})

ipcMain.handle('template:delete', (e, { name }) => {
  try {
    const file = templateFile(name)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return { ok: true }
  } catch (err) { return { ok: false, error: String(err.message || err) } }
})

/* 主页项目卡片「在新窗口中打开」：新开一个应用窗口并直接载入该项目 */
ipcMain.handle('project:open-window', (e, { name }) => {
  createWindow({ project: String(name || '') })
  return { ok: true }
})

/* ---------- 工具条「下载保存」：弹系统另存为对话框，把单个产物存到用户指定位置 ---------- */ipcMain.handle('save-as', async (e, { url, kind, ext }) => {
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const name = `flowstudio_${stamp}.${ext || (kind === 'video' ? 'mp4' : 'png')}`
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.getAllWindows()[0], {
      title: '保存' + (kind === 'video' ? '视频' : '图片'),
      defaultPath: path.join(outputDir(), name),
      filters: kind === 'video'
        ? [{ name: '视频', extensions: ['mp4', 'webm'] }]
        : [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    if (url.startsWith('data:')) {
      await fsp.writeFile(filePath, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    } else if (url.startsWith('file://')) {
      // ARCH-001：本地资产直接复制
      const src = toLocalPath(url)
      if (!fs.existsSync(src)) throw new Error('本地资产不存在: ' + src)
      await fsp.copyFile(src, filePath)
    } else {
      const resp = await net.fetch(url)
      if (!resp.ok) throw new Error('HTTP ' + resp.status)
      await fsp.writeFile(filePath, Buffer.from(await resp.arrayBuffer()))
    }
    return { ok: true, filePath }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})

/* ---------- Agent 流式对话 ---------- */
/* 定向复审 P1-2：net.fetch 的网络错误按「确定未发出」分级。
   只有确定未发出的失败（DNS/拒连等）才允许换下一候选或走 Node 栈兜底；
   请求已发出但结果未知（发送后断连/超时等）→ 终止，避免重复提交 */
const CHAT_UNSENT_NET = /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_ACCESS_DENIED|EACCES|ERR_ADDRESS_UNREACHABLE|EHOSTUNREACH|ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_MANDATORY_CONFIGURATION_FAILED|ERR_PROXY_CONNECTION_FAILED/
ipcMain.handle('agent:chat', async (e, { model, messages, baseUrl, apiKey }) => {
  const s = readSettings()
  const key = apiKey || s.apiKey
  if (!key) { e.sender.send('agent:error', '未配置 API Key'); return { ok: false } }
  const body = JSON.stringify({ model, messages, stream: true })
  const bases = baseUrl ? [baseUrl.replace(/\/+$/, '')] : candidateBases(s)
  let resp = null
  let lastErr = ''
  let allUnsent = true /* 记录是否全部失败都属「确定未发出」：是才允许 Node 栈兜底 */
  for (const base of bases) {
    try {
      resp = await net.fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body
      })
      if (resp.ok) { stickyBase = base; break }
      // HTTP 层错误（401/402 等）：请求已被明确处理并拒绝，换入口兜底不构成重复计费，直接报
      const t = await resp.text()
      e.sender.send('agent:error', `HTTP ${resp.status}: ${t.slice(0, 300)}`)
      return { ok: false }
    } catch (err) {
      lastErr = String(err)
      resp = null
      if (!CHAT_UNSENT_NET.test(lastErr)) {
        allUnsent = false
        break /* 结果未知：不得换候选重发，也不得走 Node 栈兜底 */
      }
    }
  }
  if (!resp) {
    if (!allUnsent) {
      e.sender.send('agent:error', UNKNOWN_SUBMIT_MSG)
      return { ok: false }
    }
    // Chromium 流式失败（且均确定未发出）→ Node https 非流式兜底，整段一次性下发
    try {
      const r = await nodeFetchJson(bases[0], {
        method: 'POST',
        urlPath: '/v1/chat/completions',
        body: { model, messages, stream: false },
        apiKey: key
      })
      const text = r.json?.choices?.[0]?.message?.content
      if (r.status === 200 && text) {
        e.sender.send('agent:chunk', text)
        e.sender.send('agent:done')
        return { ok: true }
      }
      e.sender.send('agent:error', `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`)
      return { ok: false }
    } catch (err2) {
      e.sender.send('agent:error', '网络错误: ' + String(err2).slice(0, 160))
      return { ok: false }
    }
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const j = JSON.parse(payload)
        const delta = j.choices?.[0]?.delta?.content || ''
        if (delta) e.sender.send('agent:chunk', delta)
      } catch { /* 忽略无法解析的行 */ }
    }
  }
  e.sender.send('agent:done')
  return { ok: true }
})

/* ---------- Agent 工具调用（非流式，带 function calling） ---------- */
const NO_TOOL_MODELS = new Set() // 记住不支持 tools 的模型，后续直接走 JSON 协议，避免每轮先撞墙
ipcMain.handle('agent:step', async (e, { model, messages, tools, baseUrl, apiKey }) => {
  const s = readSettings()
  const key = apiKey || s.apiKey
  if (!key) return { ok: false, error: '未配置 API Key' }
  const bases = baseUrl ? [baseUrl.replace(/\/+$/, '')] : candidateBases(s)
  const withTools = { model, messages, tools, tool_choice: 'auto', stream: false }
  const noTools = { model, messages, stream: false }
  const skipTools = !tools || NO_TOOL_MODELS.has(model)
  let lastErr = ''
  let toolErr = ''
  for (const base of bases) {
    const call = (body) => fetchJsonDual(base, { method: 'POST', urlPath: '/v1/chat/completions', body, apiKey: key })
    try {
      let r = await call(skipTools ? noTools : withTools)
      let usedTools = !skipTools
      // 该模型/网关不支持 tools：去掉工具重试一次，退回 JSON 协议模式
      if (r.status !== 200 && r.status >= 400 && r.status < 500) {
        const t = JSON.stringify(r.json || '')
        if (/tool|function/i.test(t)) {
          toolErr = `HTTP ${r.status}: ${t.slice(0, 200)}`
          NO_TOOL_MODELS.add(model)
          r = await call(noTools)
          usedTools = false
        }
      }
      if (r.status === 200) {
        stickyBase = base
        const msg = r.json?.choices?.[0]?.message
        if (!msg) { lastErr = '响应缺少 choices.message'; continue }
        return { ok: true, message: msg, model: r.json?.model, noTools: !usedTools, toolErr }
      }
      lastErr = `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`
    } catch (err) {
      /* 定向复审 P1-2：提交结果未知（请求可能已到达服务端）时禁止换候选域名重发 */
      if (err?.unknownSubmit) { lastErr = UNKNOWN_SUBMIT_MSG; break }
      lastErr = String(err)
    }
  }
  debugLog(`AGENT STEP FAIL ${lastErr}`)
  return { ok: false, error: lastErr.slice(0, 400) }
})

app.whenReady().then(async () => {
  if (!singleInstanceLock) return // E-1：第二个实例不初始化任何界面与数据
  /* 1.2.1 macOS：没有菜单栏时 ⌘C/⌘V/⌘Q 等标准快捷键会失效，
     这里只挂最小可用菜单（应用/编辑/窗口），不引入 Windows 侧的可见菜单 */
  if (IS_MAC) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Isle Studio', submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit' }
      ] },
      { label: '编辑', submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }
    ]))
  }
  // 数据指针失效（数据盘未连接 / 目录被删）：明确告知，避免被误当成「升级后数据丢失」
  if (dataHomeResolved.stale) {
    try {
      if (process.env.ISLE_DATA_AUTO === 'skip') {
        debugLog(`DATA stale pointer=${dataHomeResolved.staleFrom} fallback=${app.getPath('userData')} (auto skip)`)
      } else {
      const c = dialog.showMessageBoxSync({
        type: 'warning',
        title: '数据目录不可用',
        message: '上次使用的数据目录当前无法访问',
        detail: `${dataHomeResolved.staleFrom}\n\n可能原因：数据所在的磁盘/移动硬盘未连接，或该目录已被删除。\n\n本次将暂时使用：${app.getPath('userData')}\n指针已保留——磁盘接回后重启应用即可回到原数据。`,
        buttons: ['选择新位置', '暂时使用默认位置'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      debugLog(`DATA stale pointer=${dataHomeResolved.staleFrom} fallback=${app.getPath('userData')} choice=${c}`)
      if (c === 0) {
        const dir = await pickDataHomeDir()
        if (dir) {
          dataHome.writePointer(appDataDir, dir, { source: 'stale-rebind', replacedFrom: dataHomeResolved.staleFrom })
          app.relaunch()
          app.exit(0)
        }
      }
      }
    } catch (err) { debugLog(`DATA stale prompt FAIL: ${String(err).slice(0, 120)}`) }
  }
  // 安装版首启迁移询问（必须先于 createWindow，弹窗独占前台）
  await maybeMigrateUserData()
  // S19-3：崩溃恢复询问——上次会话留下未命名画布草稿时询问恢复或丢弃。
  // 复用迁移询问的 dialog 模式与 ISLE_* 自动化钩子风格。
  // 在迁移之后执行（旧目录迁移清单不含 drafts，草稿只属于本目录的崩溃恢复）。
  try {
    if (fs.existsSync(draftFile())) {
      let choice = 1
      if (process.env.ISLE_DRAFT_AUTO === 'restore') choice = 0
      else if (process.env.ISLE_DRAFT_AUTO === 'discard') choice = 1
      else {
        choice = dialog.showMessageBoxSync({
          type: 'question',
          title: '发现未保存的草稿',
          message: '检测到上次使用时未保存的画布草稿',
          detail: '「恢复草稿」会把上次的内容重新载入画布（标记为未保存，由你决定是否保存）；「丢弃」将永久删除这份草稿。',
          buttons: ['恢复草稿', '丢弃'],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        })
      }
      if (choice === 0) {
        pendingDraftAction = 'restore'
        debugLog('DRAFT restore pending (user chose restore)')
      } else {
        clearDraft()
        debugLog('DRAFT discarded (user chose discard)')
      }
    }
  } catch (err) { debugLog(`DRAFT ask FAIL: ${String(err).slice(0, 120)}`) }
  // ARCH-002：旧明文 key 一次性迁移加密（失败保留原数据，下次启动重试）
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'))
    const hasPlain = (v) => typeof v === 'string' && v && !v.startsWith(ENC_PREFIX)
    const plainKey = hasPlain(raw.apiKey)
      || (raw.models && Object.values(raw.models).some((a) => Array.isArray(a) && a.some((m) => hasPlain(m.apiKey))))
      || (raw.modelKeys && Object.values(raw.modelKeys).some(hasPlain))
    if (plainKey && canEncrypt()) writeSettings(readSettings())
  } catch (_) { /* 配置缺失或迁移失败不阻塞启动 */ }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  debugLog('APP window-all-closed → quit')
  if (process.platform !== 'darwin') app.quit()
})
/* E-1 诊断：把退出/被二次启动的时机写日志，若用户在别的设备仍遇到“自动重启”，
   可据 debug.log 判断是二次启动（second-instance）还是安装器自动运行 */
app.on('before-quit', () => debugLog('APP before-quit'))
app.on('will-quit', () => debugLog('APP will-quit'))

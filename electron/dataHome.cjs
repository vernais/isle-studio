/* ============================================================================
   dataHome.cjs —— 数据家目录（Data Home）架构
   ----------------------------------------------------------------------------
   目标：程序（安装目录）与用户数据（项目 / 生成物 / 资产 / 模板 / API Key）
        彻底解耦。升级时只替换安装目录里的程序文件，用户数据一动不动，
        新版本启动后直接接着用旧数据，无需任何手动搬迁。

   数据家目录解析优先级（高 → 低）：
     1. 命令行 --user-data-dir=<path>   开发/审查实例专用，两者数据天然隔离
     2. 环境变量 ISLE_USER_DATA         仅安装版生效（可把数据放到非系统盘）
     3. 安装版默认  %APPDATA%\Isle Studio Release
     4. 开发版      交给 Electron 默认（%APPDATA%\Isle Studio）

   首启接入：目标目录没有 .data-schema.json 且没有核心数据时，按候选源
   （上一版安装数据 / 开发数据 / 早期版本数据 / 程序目录内 data）从新到旧
   探测，命中则询问「迁移旧数据 / 全新开始」。迁移是复制而非移动，旧数据
   永远保留可回退。

   版本演进：.data-schema.json 记录 schema 版本与来源，后续结构变更只需在
   SCHEMA_MIGRATIONS 里按版本号补一段升级函数，升级安装后自动跑，不动用户
   文件结构。
   ========================================================================== */
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

/* 当前数据结构版本：新增/改动目录结构时 +1，并在 SCHEMA_MIGRATIONS 补对应步骤 */
const SCHEMA_VERSION = 2

/* 迁移/接入的核心数据（不含缓存类目录，避免把 Cache/GPUCache 搬过来） */
const CORE_DIRS = ['projects', 'assets', 'templates', 'drafts', 'sessions']
const CORE_FILES = ['flowstudio-config.json', 'tasks.json']

/* 判定「这个目录里有没有值得接入的数据」的轻量探针 */
function hasCoreData(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false
    for (const d of ['projects', 'assets', 'templates']) {
      const p = path.join(dir, d)
      if (fs.existsSync(p) && fs.readdirSync(p).length) return true
    }
    return CORE_FILES.some((f) => fs.existsSync(path.join(dir, f)))
  } catch {
    return false
  }
}

function samePath(a, b) {
  if (!a || !b) return false
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

/* 目录最后修改时间，用于在多个候选里挑「最像当前在用」的那份 */
function dirStamp(dir) {
  try { return fs.statSync(dir).mtimeMs } catch { return 0 }
}

/* ---------- 1. 指针文件：数据目录的唯一事实来源 ----------
   落点固定在 %APPDATA%\IsleStudio\data-home.json（≤200 字节，与任何数据目录无关），
   记录「用户数据到底在哪个盘」。只要这个文件还在，之后无论：
     · 覆盖安装到同一目录、装到新目录、改安装路径、换便携版、跨版本升级，
   都读同一个指针 → 永远指向同一份数据，不会出现「升级后数据失踪」。      */
const POINTER_FILE = 'data-home.json'
const DATA_DIR_NAME = 'IsleStudio-data'

function pointerPath(appData) {
  return path.join(appData, 'IsleStudio', POINTER_FILE)
}

function readPointer(appData) {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerPath(appData), 'utf-8'))
    const dir = String(raw?.dir || '').trim()
    if (!dir) return null
    return { dir: path.resolve(dir), at: raw.updatedAt || '', source: raw.source || '' }
  } catch {
    return null
  }
}

function writePointer(appData, dir, extra = {}) {
  const p = pointerPath(appData)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const prev = readPointer(appData)
  fs.writeFileSync(p, JSON.stringify({
    dir: path.resolve(dir),
    updatedAt: new Date().toISOString(),
    ...(prev?.at && !extra.replacedFrom ? { firstBoundAt: prev.at } : {}),
    ...extra
  }, null, 2), 'utf-8')
  return p
}

/* 目录（或其最近存在的祖先）是否可写：用于判定默认位置能不能放数据 */
function probeWritable(dir) {
  try {
    if (!dir) return false
    if (fs.existsSync(dir)) {
      if (!fs.statSync(dir).isDirectory()) return false
      const f = path.join(dir, `.write-probe-${process.pid}`)
      fs.writeFileSync(f, 'ok')
      fs.unlinkSync(f)
      return true
    }
    let a = path.dirname(dir)
    while (a && !fs.existsSync(a)) {
      const n = path.dirname(a)
      if (n === a) return false
      a = n
    }
    if (!fs.existsSync(a)) return false
    const f = path.join(a, `.write-probe-${process.pid}`)
    fs.writeFileSync(f, 'ok')
    fs.unlinkSync(f)
    return true
  } catch {
    return false
  }
}

/* 安装版默认数据目录：安装目录的「同级」IsleStudio-data。
   必须同级而不是安装目录内部——NSIS 卸载会 RMDir /r 整个安装目录，
   数据放里面会被连锅端；同级目录不在卸载范围内，卸载重装也能接回。
   安装到不可写位置（如 Program Files）时回退 %APPDATA%。

   macOS 例外：安装目录在 .app 包内（Contents/MacOS），「同级」仍是包内路径，
   覆盖安装会整包替换、数据会跟着没；而且管理员账户对 /Applications 可写，
   probeWritable 会误判成功。因此 macOS 一律直接落到 ~/Library/Application Support。 */
function defaultPackagedDir({ appData, installDir, platform }) {
  if (installDir && platform !== 'darwin') {
    const sibling = path.join(path.dirname(installDir), DATA_DIR_NAME)
    if (!samePath(sibling, installDir) && probeWritable(sibling)) return { dir: sibling, source: 'install-sibling' }
  }
  return { dir: path.join(appData, 'Isle Studio Release'), source: 'packaged-default' }
}

/* ---------- 2. 解析数据家目录 ---------- */
function readCliDataDir(argv = []) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--user-data-dir=')) return a.slice('--user-data-dir='.length)
    if (a === '--user-data-dir' && argv[i + 1]) return argv[i + 1]
  }
  return ''
}

/* 优先级（高 → 低）：
     1. --user-data-dir      开发/审查实例，天然隔离，不落指针
     2. 指针文件             分发场景的唯一事实来源
     3. ISLE_USER_DATA       部署时由管理员强制指定（无指针时生效）
     4. 安装目录同级 data    安装版默认（可写时）
     5. %APPDATA%\Isle Studio Release  兜底 */
function resolveDataHome({ isPackaged, appData, argv = [], env = {}, installDir = '', exePath = '', platform = process.platform }) {
  const cli = readCliDataDir(argv)
  if (cli) return { dir: path.resolve(cli), source: 'cli' }
  if (!isPackaged) return { dir: '', source: 'default' } // 开发版沿用 Electron 默认，不强行改写

  const inst = installDir || (exePath ? path.dirname(exePath) : '')

  const ptr = readPointer(appData)
  if (ptr) {
    /* 指针在但目录不在了（移动硬盘没插 / 目录被删）：不静默新建空目录，
       本次退回默认位置，并保留指针——磁盘接回来重启即回到原数据。 */
    if (fs.existsSync(ptr.dir)) return { dir: ptr.dir, source: 'pointer', fromPointer: true, pointerAt: ptr.at }
    const fb = defaultPackagedDir({ appData, installDir: inst, platform })
    return { ...fb, stale: true, staleFrom: ptr.dir, fromPointer: false }
  }

  const envDir = (env.ISLE_USER_DATA || '').trim()
  if (envDir) return { dir: path.resolve(envDir), source: 'env' }

  return defaultPackagedDir({ appData, installDir: inst, platform })
}

/* ---------- 2. 候选源（首启接入用） ---------- */
function findCandidates({ appData, dataHome, installDir }) {
  const seen = []
  const push = (label, dir) => {
    if (!dir) return
    if (dataHome && samePath(dir, dataHome)) return
    if (seen.some((c) => samePath(c.dir, dir))) return
    if (!hasCoreData(dir)) return
    seen.push({ label, dir, stamp: dirStamp(dir) })
  }
  push('上一版本数据', path.join(appData, 'Isle Studio Release'))
  push('开发版数据', path.join(appData, 'Isle Studio'))
  push('早期版本数据', path.join(appData, 'Flow Studio'))
  if (installDir) push('程序目录数据', path.join(installDir, 'data'))
  return seen.sort((a, b) => b.stamp - a.stamp)
}

/* ---------- 3. 数据版本标记 ---------- */
function schemaPath(dir) { return path.join(dir, '.data-schema.json') }

function readSchema(dir) {
  try { return JSON.parse(fs.readFileSync(schemaPath(dir), 'utf-8')) } catch { return null }
}

function writeSchema(dir, appVersion, extra = {}) {
  const prev = readSchema(dir) || {}
  const next = {
    schema: SCHEMA_VERSION,
    appVersion,
    updatedAt: new Date().toISOString(),
    createdAt: prev.createdAt || new Date().toISOString(),
    ...prev,
    ...extra
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(schemaPath(dir), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

/* schema 差量升级：key 为「升到该版本」要做的动作。当前 v2 为架构基线，
   没有实际结构变换；后续版本在此追加即可（例：3: (dir) => ...）。 */
const SCHEMA_MIGRATIONS = {}

function upgradeSchema(dir, appVersion) {
  const cur = readSchema(dir)
  if (!cur) {
    /* 老数据没有版本标记（≤v1.1.1 的用户）→ 直接落当前基线，不做结构变换 */
    writeSchema(dir, appVersion, { adoptedFrom: null, baseline: true })
    return { schema: SCHEMA_VERSION, from: null, steps: [] }
  }
  const from = Number(cur.schema) || 1
  const steps = []
  for (let v = from + 1; v <= SCHEMA_VERSION; v += 1) {
    if (typeof SCHEMA_MIGRATIONS[v] === 'function') SCHEMA_MIGRATIONS[v](dir)
    steps.push(v)
  }
  if (steps.length) writeSchema(dir, appVersion, { schema: SCHEMA_VERSION })
  return { schema: SCHEMA_VERSION, from, steps }
}

/* ---------- 4. 迁移（接入）核心数据 ---------- */
function backupTargetConfig(toDir) {
  const cfg = path.join(toDir, 'flowstudio-config.json')
  if (!fs.existsSync(cfg)) return ''
  const bak = path.join(toDir, `flowstudio-config.before-adopt-${Date.now()}.json`)
  try { fs.copyFileSync(cfg, bak); return bak } catch { return '' }
}

/* 复制核心数据（不移动，旧目录原样保留，随时可回退） */
function portCore(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true })
  const copied = []
  backupTargetConfig(toDir)
  for (const d of CORE_DIRS) {
    const src = path.join(fromDir, d)
    if (!fs.existsSync(src)) continue
    try {
      fs.cpSync(src, path.join(toDir, d), { recursive: true, force: true })
      copied.push(d)
    } catch (_) { /* 单个目录失败不影响其余，最后在日志里体现 */ }
  }
  for (const f of CORE_FILES) {
    const src = path.join(fromDir, f)
    if (!fs.existsSync(src)) continue
    try {
      fs.copyFileSync(src, path.join(toDir, f))
      copied.push(f)
    } catch (_) {}
  }
  return copied
}

/* safeStorage 的 DPAPI key 与数据目录绑定：只搬配置不搬 key，API Key 会
   静默解不开。这里把 <from>/Local State 里的 os_crypt.encrypted_key 移植过去。 */
function portOsCryptKey(fromDir, toDir) {
  try {
    const from = path.join(fromDir, 'Local State')
    const to = path.join(toDir, 'Local State')
    if (!fs.existsSync(from)) return false
    const src = JSON.parse(fs.readFileSync(from, 'utf-8'))
    const key = src?.os_crypt?.encrypted_key
    if (!key) return false
    let dst = {}
    try { dst = JSON.parse(fs.readFileSync(to, 'utf-8')) } catch { dst = {} }
    if (dst?.os_crypt?.encrypted_key === key) return true
    dst.os_crypt = { ...(dst.os_crypt || {}), encrypted_key: key }
    fs.writeFileSync(to, JSON.stringify(dst), 'utf-8')
    return true
  } catch {
    return false
  }
}

/* 一次完整的「接入旧数据」动作 */
function adopt(fromDir, toDir, appVersion) {
  const copied = portCore(fromDir, toDir)
  const keyPorted = copied.includes('flowstudio-config.json') ? portOsCryptKey(fromDir, toDir) : false
  writeSchema(toDir, appVersion, {
    adoptedFrom: path.resolve(fromDir),
    adoptedAt: new Date().toISOString(),
    adoptedItems: copied
  })
  return { copied, keyPorted }
}

/* ---------- 5. 数据位置迁移（设置页「数据位置 → 更改」） ----------
   把整份用户数据搬到新盘，校验通过后才改指针；旧目录原样保留（只清缓存类
   目录），失败时指针不动，用户不会因为一次搬家中断而丢数据。 */
const SKIP_NAMES = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'ShaderCache', 'GrShaderCache', 'Crashpad', 'logs', 'temp',
  'SingletonLock', 'SingletonCookie', 'SingletonSocket'
])

function isInside(parent, child) {
  const p = path.resolve(parent).toLowerCase()
  const c = path.resolve(child).toLowerCase()
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

function countTree(dir, stat) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of ents) {
    if (SKIP_NAMES.has(ent.name)) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) { countTree(p, stat); continue }
    if (!ent.isFile()) continue
    try { stat.files += 1; stat.bytes += fs.statSync(p).size } catch (_) {}
  }
}

/* 目标合法性：不能与源相同、不能互相包含、不能落在安装目录内（卸载会删） */
function checkTarget(fromDir, toDir, installDir) {
  if (!toDir) return '未指定目标目录'
  if (samePath(fromDir, toDir)) return '目标目录与当前数据目录相同'
  if (isInside(fromDir, toDir)) return '目标目录不能位于当前数据目录内部'
  if (isInside(toDir, fromDir)) return '当前数据目录不能位于目标目录内部'
  if (installDir && isInside(installDir, toDir)) return '数据目录不能放在安装目录内（卸载会一并删除）'
  if (!probeWritable(toDir)) return '目标目录不可写（磁盘不存在或无权限）'
  return ''
}

async function relocate(fromDir, toDir, appData, opts = {}) {
  const err = checkTarget(fromDir, toDir, opts.installDir)
  if (err) return { ok: false, error: err }
  const from = path.resolve(fromDir)
  const to = path.resolve(toDir)
  /* 异步复制：不让主进程在搬几 GB 生成物时卡死 UI */
  try {
    await fsp.cp(from, to, {
      recursive: true,
      force: true,
      filter: (src) => !SKIP_NAMES.has(path.basename(src))
    })
  } catch (e) {
    return { ok: false, error: `复制中断：${String(e.message || e).slice(0, 120)}` }
  }
  /* 校验：文件数必须与源一致，否则不切指针（宁可不生效，也不切到不完整的数据） */
  const src = { files: 0, bytes: 0 }
  countTree(from, src)
  const dst = { files: 0, bytes: 0 }
  countTree(to, dst)
  if (dst.files < src.files) {
    return { ok: false, error: `校验未通过：应为 ${src.files} 个文件，实际 ${dst.files} 个`, expected: src, copied: dst }
  }
  if (appData) writePointer(appData, to, { source: 'moved', replacedFrom: from })
  /* 旧目录：只清缓存类，核心数据保留可回退 */
  let freed = 0
  for (const name of SKIP_NAMES) {
    const p = path.join(from, name)
    if (!fs.existsSync(p)) continue
    try {
      const s = { files: 0, bytes: 0 }
      countTree(p, s)
      fs.rmSync(p, { recursive: true, force: true })
      freed += s.bytes
    } catch (_) {}
  }
  return { ok: true, from, to, copied: dst, expected: src, freed, pointer: appData ? pointerPath(appData) : '' }
}

module.exports = {
  SCHEMA_VERSION,
  CORE_DIRS,
  CORE_FILES,
  SCHEMA_MIGRATIONS,
  POINTER_FILE,
  DATA_DIR_NAME,
  pointerPath,
  readPointer,
  writePointer,
  probeWritable,
  defaultPackagedDir,
  checkTarget,
  relocate,
  hasCoreData,
  readCliDataDir,
  resolveDataHome,
  findCandidates,
  readSchema,
  writeSchema,
  upgradeSchema,
  portCore,
  portOsCryptKey,
  adopt,
  samePath
}

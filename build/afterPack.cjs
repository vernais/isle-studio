/* 打包钩子（打包验收修复）：在 afterPack 阶段为 exe 写入应用图标与版本信息。
   背景：本机无管理员/开发者模式，electron-builder 的 winCodeSign 解压会因
   macOS 符号链接失败，只能以 signAndEditExecutable=false 打包；该开关会连带
   跳过 rcedit 资源编辑，导致安装后图标为 Electron 默认图标。
   这里直接复用缓存里的 rcedit-x64.exe 补写图标与版本信息（只改 exe 资源，
   不涉及代码签名，也不修改任何业务代码）。 */
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

/* 查找顺序：项目内置 → ELECTRON_BUILDER_CACHE（自定义缓存盘）→ 系统默认缓存。
   内置优先：打包不再依赖 C 盘缓存，换机/换缓存目录（如迁到 D 盘）都能出图标。 */
function findRcedit(context) {
  const candidates = [path.join(context.packager.projectDir, 'build', 'rcedit-x64.exe')]
  const eb = process.env.ELECTRON_BUILDER_CACHE || ''
  if (eb) {
    candidates.push(path.join(eb, 'winCodeSign'))
    candidates.push(path.join(eb, 'Cache', 'winCodeSign'))
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign'))
  }
  for (const c of candidates) {
    if (c.toLowerCase().endsWith('.exe')) {
      if (fs.existsSync(c)) return c
      continue
    }
    if (!fs.existsSync(c)) continue
    for (const dir of fs.readdirSync(c)) {
      const p = path.join(c, dir, 'rcedit-x64.exe')
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const { productName, version } = context.packager.appInfo
  const exe = path.join(context.appOutDir, `${productName}.exe`)
  if (!fs.existsSync(exe)) {
    console.log(`  • afterPack: 未找到 ${exe}，跳过图标写入`)
    return
  }
  const rcedit = findRcedit(context)
  if (!rcedit) {
    console.log('  • afterPack: 未找到 rcedit-x64.exe，跳过图标写入（exe 将使用默认图标）')
    return
  }
  const icon = path.join(context.packager.projectDir, 'build', 'icon.ico')
  const args = [
    exe,
    '--set-icon', icon,
    '--set-file-version', version,
    '--set-product-version', version,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'CompanyName', 'AZ DESIGN',
    '--set-version-string', 'OriginalFilename', `${productName}.exe`
  ]
  execFileSync(rcedit, args, { stdio: 'inherit' })
  console.log(`  • afterPack: 已写入图标与版本信息 → ${path.basename(exe)} (v${version})`)
}

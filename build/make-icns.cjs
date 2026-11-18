/* 生成 macOS 图标 build/icon.icns（纯 Node，无第三方依赖）。
   输入：build/icns/icon_<size>.png（由 ffmpeg 从 build/icon.png 缩放而来，
   见同目录 make-icns.sh）。ICNS 本质是若干 PNG chunk 的容器，
   这里按 Apple 的 icp4-icp6 与 ic07-ic14 类型逐个写入，涵盖 16→1024 及 @2x 槽位。 */
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, 'icns')
const out = path.join(__dirname, 'icon.icns')

/* chunk 类型 → 需要的像素尺寸 */
const SLOTS = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64],
  ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]
]

const chunks = []
for (const [type, size] of SLOTS) {
  const f = path.join(dir, `icon_${size}.png`)
  if (!fs.existsSync(f)) { console.warn(`跳过 ${type}：缺少 ${path.basename(f)}`); continue }
  const data = fs.readFileSync(f)
  const head = Buffer.alloc(8)
  head.write(type, 0, 4, 'ascii')
  head.writeUInt32BE(data.length + 8, 4)
  chunks.push(head, data)
}
const body = Buffer.concat(chunks)
const header = Buffer.alloc(8)
header.write('icns', 0, 4, 'ascii')
header.writeUInt32BE(body.length + 8, 4)
fs.writeFileSync(out, Buffer.concat([header, body]))
console.log(`✓ ${path.basename(out)} ${(fs.statSync(out).size / 1024).toFixed(0)}KB · ${chunks.length / 2} 个尺寸`)

/* 卡片尺寸与画面比例的统一算法（nodes 侧渲染、engine 侧回写、参数面板换算共用） */

export const CARD_TARGET_H = 340
const CHROME = 18 // 上下 padding(7*2) + border(2*2)

/** 画面比例是否为「自动」：空值或 Auto/auto 都算 */
export function isAutoSize(size) {
  const s = String(size ?? '').trim()
  return !s || s.toLowerCase() === 'auto'
}

/** 按目标高度与画面比例反推卡片宽度（width:height 型比例才缩放宽度，否则取方形基准） */
export function cardWidthFor(kind, size, targetH = CARD_TARGET_H) {
  const [rw, rh] = String(size || '1:1').split(':').map(Number)
  const inner = targetH - CHROME
  const previewW = kind === 'video' && rw && rh ? (inner * rw) / rh : inner
  return Math.round(previewW + CHROME)
}

/** 已知真实宽高比时反推宽度（限幅 170~820） */
export function uploadedWidth(ar, targetH = CARD_TARGET_H) {
  if (!Number.isFinite(ar) || ar <= 0) return cardWidthFor('image', '1:1', targetH)
  const w = Math.round((targetH - CHROME) * ar + CHROME)
  return Math.max(170, Math.min(820, w))
}

/** 画面比例数值：真实比例 ar 优先，其次 size 预设；Auto 时回落到初始比例（图片 1:1 / 视频 16:9） */
export function ratioOf(data) {
  if (data?.ar && Number.isFinite(data.ar)) return data.ar
  if (isAutoSize(data?.size)) return data?.kind === 'video' ? 16 / 9 : 1
  const [rw, rh] = String(data?.size || '').split(':').map(Number)
  return rw && rh ? rw / rh : data?.kind === 'video' ? 16 / 9 : 1
}

/** 卡片宽度：显式拖拽过的优先；其次按真实比例；再按比例预设 */
export function cardWidthOf(data) {
  if (data?.cardWidth) return data.cardWidth
  if (data?.ar && Number.isFinite(data.ar)) return uploadedWidth(data.ar)
  return cardWidthFor(data?.kind || 'image', isAutoSize(data?.size) ? '1:1' : data?.size)
}

/** 读取媒体真实宽高比（图片/视频通用；失败返回 0） */
export function measureRatio(url, kind) {
  return new Promise((resolve) => {
    if (!url) return resolve(0)
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(Number.isFinite(v) && v > 0 ? v : 0)
    }
    const timer = setTimeout(() => done(0), 4000)
    if (kind === 'video') {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.onloadedmetadata = () => { clearTimeout(timer); done(v.videoWidth / v.videoHeight) }
      v.onerror = () => { clearTimeout(timer); done(0) }
      v.src = url
    } else {
      const img = new Image()
      img.onload = () => { clearTimeout(timer); done(img.naturalWidth / img.naturalHeight) }
      img.onerror = () => { clearTimeout(timer); done(0) }
      img.src = url
    }
  })
}

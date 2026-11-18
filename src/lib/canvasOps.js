/* 画布批量操作纯函数（ARCH-004 拆分：从 App.jsx 抽出，不含 React 状态） */

/* 按连线依赖拓扑分层排列：上游在左、下游在右，同层纵向等距 */
export function layoutByDepth(nodes, edges) {
  if (!nodes.length) return []
  const depth = new Map()
  const getDepth = (id, seen) => {
    if (depth.has(id)) return depth.get(id)
    if (seen.has(id)) return 0 // 环保护
    seen.add(id)
    let d = 0
    for (const e of edges) if (e.target === id) d = Math.max(d, getDepth(e.source, seen) + 1)
    depth.set(id, d)
    return d
  }
  nodes.forEach((n) => getDepth(n.id, new Set()))
  const cols = new Map()
  nodes.forEach((n) => {
    const d = depth.get(n.id)
    if (!cols.has(d)) cols.set(d, [])
    cols.get(d).push(n)
  })
  let x = 0
  const next = []
  for (const d of [...cols.keys()].sort((a, b) => a - b)) {
    let y = 0
    let colW = 0
    for (const n of cols.get(d)) {
      next.push({ ...n, selected: false, position: { x, y } })
      y += 430
      colW = Math.max(colW, n.data?.cardWidth || 340)
    }
    x += colW + 170
  }
  return next
}

/* 收集画布上所有生成产物（供「下载全部」批量落盘） */
export function collectOutputs(nodes) {
  const items = []
  for (const n of nodes) for (const u of n.data?.urls || []) items.push({ url: u, kind: n.data.kind })
  return items
}

/* 产物扩展名推断：优先 URL 后缀，其次按类型兜底 */
export function extOf(url, kind) {
  return (url.match(/\.(png|jpe?g|webp|gif|mp4|webm|mp3|wav|m4a|aac|ogg|opus|flac)(\?|#|$)/i) || [])[1]
    || (kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png')
}

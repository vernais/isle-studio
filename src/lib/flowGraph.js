/* 画布图结构纯函数：挂点菜单项、上游图片收集、参考栏数据、对齐吸附 */
export function itemsForHandle(handleType, handleId) {
  if (handleType === 'source') {
    return [
      { key: 'image', label: '图片生成' },
      { key: 'video', label: '视频生成' },
      { key: 'compose', label: '成片合成' }
    ]
  }
  if (handleId === 'in-text') {
    return [{ key: 'text', label: '提示词' }]
  }
  /* P3 成片合成的两个输入口：视频片 / 配音轨 */
  if (handleId === 'in-video') {
    return [
      { key: 'video', label: '视频生成' },
      { key: 'upload', label: '上传' }
    ]
  }
  if (handleId === 'in-audio') {
    return [
      { key: 'audio', label: '配音' },
      { key: 'upload', label: '上传' }
    ]
  }
  return [
    { key: 'image', label: '图片生成' },
    { key: 'upload', label: '上传' }
  ]
}

export function upstreamImagesFor(nodeId, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visited = new Set()
  const out = []
  let frontier = [nodeId]
  while (frontier.length) {
    const next = []
    for (const t of frontier) {
      for (const e of edges) {
        if (e.target !== t || visited.has(e.source)) continue
        visited.add(e.source)
        const src = byId.get(e.source)
        if (!src) continue
        if (src.type === 'image' || src.type === 'video') {
          for (const u of src.data?.urls || []) if (!out.includes(u)) out.push(u)
          continue // 图片/视频节点自身即是来源，不再向上穿透
        }
        next.push(e.source)
      }
    }
    frontier = next
  }
  return out.slice(0, 4)
}


export function refsFor(nodeId, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = []
  for (const e of edges) {
    if (e.target !== nodeId || (e.targetHandle || '') !== 'in-img') continue
    const src = byId.get(e.source)
    /* P1：视频卡的输出不是图片参考，走「参考视频」链路，不进参考图栏
       P2：音频卡（配音）同理，不进参考图栏 */
    if (!src || src.data?.kind === 'video' || src.data?.kind === 'audio') continue
    const url = (src?.data?.urls || [])[0]
    if (!url) continue
    out.push({
      edgeId: e.id,
      nodeId: src.id,
      url,
      label: src.data?.label || src.id,
      /* C-1：上传素材卡没有生成模型，历史数据里可能残留 model，一律不显示模型名 */
      model: src.data?.uploaded ? '' : (src.data?.model || '')
    })
    if (out.length >= 4) break
  }
  return out
}

/* 连线端点徽标图标类型 */
export const iconFor = (t) => (t === 'text' ? 'T' : t === 'video' ? 'vid' : 'img')

/* D-5：历史项目提示词回填。
   C-2 的同步只在「连线那一刻 / 之后编辑文本」时发生，早于该修复保存的项目里，
   text→in-text 连线已存在但下游 prompt 仍为空，用户看到的就是「连了线但框里没字」。
   载入时按连线补一次：下游 prompt 为空才填，已有手写内容绝不覆盖。
   返回原引用（无改动时）以便调用方判断是否需要基线对齐。 */
export function backfillPromptLinks(nodes, edges) {
  const list = Array.isArray(nodes) ? nodes : []
  if (!list.length || !Array.isArray(edges) || !edges.length) return nodes
  const byId = new Map(list.map((n) => [n.id, n]))
  const fill = new Map()
  for (const e of edges) {
    if ((e.targetHandle || '') !== 'in-text') continue
    const src = byId.get(e.source)
    if (src?.type !== 'text') continue
    const text = src.data?.text || ''
    if (!text.trim()) continue
    if (!fill.has(e.target)) fill.set(e.target, text)
  }
  if (!fill.size) return nodes
  let changed = false
  const out = list.map((n) => {
    if (n.type === 'text' || !fill.has(n.id)) return n
    if ((n.data?.prompt || '').trim()) return n
    changed = true
    return { ...n, data: { ...n.data, prompt: fill.get(n.id) } }
  })
  return changed ? out : nodes
}

/* 与 App 的 EDGE_COLOR 保持一致的兜底描边（老数据缺 style 时使用） */
const EDGE_COLOR_FALLBACK = '#7c86ff'

/* D-6：统一的「载入时数据修正」入口。
   背景：历史上多次修复只改了「新建/操作时」的数据路径，已保存项目里的旧数据不会被修正
   （提示词连线不回填、非法连线、老边缺显示字段）。以后再有同类兼容需求，只在这里加一条规则，
   三条载入路径（打开项目 / 新窗口直开 / 草稿恢复）自动生效。
   纯函数：不修改入参；无改动时返回原引用，调用方可据此判断是否需要提示。 */
export function normalizeLoadedGraph(nodes, edges) {
  const list = Array.isArray(nodes) ? nodes : []
  const byId = new Map(list.map((n) => [n.id, n]))
  let edgesChanged = false
  const cleanEdges = []
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e || !byId.has(e.source) || !byId.has(e.target)) { edgesChanged = true; continue } // 悬空边（节点已删）
    const src = byId.get(e.source)
    const sIcon = iconFor(src?.type)
    const srcIsText = src?.type === 'text' || src?.data?.kind === 'text'
    /* 1.2.0：旧版连线的目标挂点判定看的是「目标类型」，提示词→视频会被挂成 in-img
       （提示词当成参考图，重开项目又被当非法连线清掉，用户感知「连线自己没了」）。
       载入时把它迁到 in-text 而不是删除；已有 in-text 同源同目标则去重。 */
    if (srcIsText && (e.targetHandle || '') === 'in-img') {
      edgesChanged = true
      const t = byId.get(e.target)
      if (!t || t.type === 'text') continue
      const dup = cleanEdges.some((x) => x.source === e.source && x.target === e.target && (x.targetHandle || '') === 'in-text')
      if (dup) continue
      cleanEdges.push({
        ...e,
        id: `e_${e.source}__${e.target}__text`,
        targetHandle: 'in-text',
        data: { sIcon, tIcon: iconFor(t.type), ...(e.data || {}) },
        style: e.style?.stroke ? e.style : { stroke: EDGE_COLOR_FALLBACK }
      })
      continue
    }
    /* 老版本保存的边可能没有徽标/描边字段，补齐避免渲染层取空值 */
    if (!e.data?.sIcon || !e.data?.tIcon || !e.style?.stroke) {
      edgesChanged = true
      cleanEdges.push({
        ...e,
        data: { sIcon, tIcon: iconFor(byId.get(e.target)?.type), ...(e.data || {}) },
        style: e.style?.stroke ? e.style : { stroke: EDGE_COLOR_FALLBACK }
      })
      continue
    }
    cleanEdges.push(e)
  }
  /* 旧版本没有「续查中断任务」机制：停在 生成中/排队 但没有 taskId 的节点会永远转圈，
     载入时标记为失败并给出原因，用户可直接重跑 */
  let nodesChanged = false
  const fixedNodes = list.map((n) => {
    const d = n.data || {}
    const pending = d.status === 'queued' || d.status === 'submitted' || d.status === 'running'
    if (!pending || d.taskId) return n
    nodesChanged = true
    return { ...n, data: { ...d, status: 'failed', progress: 0, error: '上次生成被中断（任务记录已失效），请重新运行' } }
  })
  const base = nodesChanged ? fixedNodes : list
  const filled = backfillPromptLinks(base, cleanEdges)
  return {
    nodes: filled,
    edges: edgesChanged ? cleanEdges : edges,
    changed: filled !== nodes || edgesChanged
  }
}

/* ---------- 拖动对齐吸附：左/中/右 × 上/中/下 对齐参考线 ---------- */
export const SNAP_TOL = 7

export function calcSnap(node, nodes) {
  const dw = node.measured?.width, dh = node.measured?.height
  if (!dw || !dh) return { dx: 0, dy: 0, lines: [] }
  const dx = { l: node.position.x, c: node.position.x + dw / 2, r: node.position.x + dw }
  const dy = { t: node.position.y, c: node.position.y + dh / 2, b: node.position.y + dh }
  let bx = null, by = null
  for (const o of nodes) {
    if (o.id === node.id) continue
    const ow = o.measured?.width, oh = o.measured?.height
    if (!ow || !oh) continue
    const ox = { l: o.position.x, c: o.position.x + ow / 2, r: o.position.x + ow }
    const oy = { t: o.position.y, c: o.position.y + oh / 2, b: o.position.y + oh }
    for (const dk of ['l', 'c', 'r']) for (const ok of ['l', 'c', 'r']) {
      const delta = ox[ok] - dx[dk]
      if (Math.abs(delta) <= SNAP_TOL && (!bx || Math.abs(delta) < Math.abs(bx.delta))) {
        bx = { delta, pos: ox[ok] }
      }
    }
    for (const dk of ['t', 'c', 'b']) for (const ok of ['t', 'c', 'b']) {
      const delta = oy[ok] - dy[dk]
      if (Math.abs(delta) <= SNAP_TOL && (!by || Math.abs(delta) < Math.abs(by.delta))) {
        by = { delta, pos: oy[ok] }
      }
    }
  }
  const lines = []
  if (bx) lines.push({ orient: 'v', pos: bx.pos })
  if (by) lines.push({ orient: 'h', pos: by.pos })
  return { dx: bx ? bx.delta : 0, dy: by ? by.delta : 0, lines }
}

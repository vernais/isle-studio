/* 撤销 / 重做：基于「节点 + 连线」快照的栈式历史（UI-007 B-2）
 *
 * 设计要点：
 * 1. 只记录图结构，不记录面板开关、选中态等 UI 状态 —— 因此撤销不会破坏
 *    UI-002 的「参数面板与 Agent 面板互斥」逻辑（任务书硬性约束 6）。
 * 2. 用轻量签名做去重：拖动节点会产生上百次状态更新，只有「稳定后内容确实变了」
 *    才压栈，避免历史被位置抖动填满（上限 50 步）。
 * 3. 运行期状态（status / progress / urls / error / lastCost）不算编辑内容：
 *    既不参与签名，应用撤销时也从当前节点继承回来，于是撤销只回退「人为编辑」，
 *    不会因为按了 Ctrl+Z 就把刚生成好的图片抹掉。
 */

export const HISTORY_LIMIT = 50

/** 内容签名：只取会影响用户体验的编辑字段（不含运行期状态、不含 dataURL 体积） */
export function graphSignature(nodes, edges) {
  const n = (nodes || []).map((x) => [
    x.id, x.type,
    Math.round(x.position?.x || 0), Math.round(x.position?.y || 0),
    x.data?.cardWidth || 0,
    x.data?.locked ? 1 : 0,
    x.data?.prompt || '', x.data?.text || '',
    x.data?.model || '', x.data?.size || '', x.data?.resolution || '',
    x.data?.n || 0, x.data?.duration || 0,
    x.data?.audio ? 1 : 0,
    (x.data?.refImages || []).length
  ].join('\u0001')).join('\u0002')
  const e = (edges || []).map((x) => [
    x.id || '', x.source, x.sourceHandle || '', x.target, x.targetHandle || ''
  ].join('\u0001')).join('\u0002')
  return n + '\u0003' + e
}

export function snapshot(nodes, edges) {
  return {
    nodes: (nodes || []).map((n) => ({ ...n, position: { ...n.position }, data: { ...n.data } })),
    edges: (edges || []).map((e) => ({ ...e }))
  }
}

/* 运行期字段：撤销时从当前状态继承，不随快照回滚 */
const RUNTIME = ['status', 'progress', 'urls', 'error', 'lastCost', 'cost']

export function mergeRuntime(snap, currentNodes) {
  const byId = new Map((currentNodes || []).map((n) => [n.id, n]))
  return (snap.nodes || []).map((n) => {
    const cur = byId.get(n.id)
    if (!cur) return n
    const data = { ...n.data }
    for (const k of RUNTIME) if (cur.data && k in cur.data) data[k] = cur.data[k]
    return { ...n, data }
  })
}

export function createHistory(limit = HISTORY_LIMIT) {
  let past = []
  let future = []
  let last = null
  let lastSig = ''

  return {
    reset(nodes, edges) {
      past = []
      future = []
      last = snapshot(nodes, edges)
      lastSig = graphSignature(nodes, edges)
    },
    /** 图状态稳定后调用；内容没变返回 false */
    commit(nodes, edges) {
      const sig = graphSignature(nodes, edges)
      if (sig === lastSig) return false
      if (last) {
        past.push(last)
        if (past.length > limit) past.shift()
      }
      last = snapshot(nodes, edges)
      lastSig = sig
      future = []
      return true
    },
    undo(nodes, edges) {
      if (!past.length) return null
      future.unshift(snapshot(nodes, edges))
      const s = past.pop()
      last = s
      lastSig = graphSignature(s.nodes, s.edges)
      return s
    },
    redo(nodes, edges) {
      if (!future.length) return null
      past.push(snapshot(nodes, edges))
      const s = future.shift()
      last = s
      lastSig = graphSignature(s.nodes, s.edges)
      return s
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    depth: () => ({ past: past.length, future: future.length })
  }
}

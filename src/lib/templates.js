/* REQ-002 工作流模板：结构与内容的边界
   - 模板只保存「可复用结构」：节点类型、位置、参数（提示词/模型/比例/分辨率/时长/数量/音频）、连线
   - 落模板时剥离所有产物与运行态：urls / refImages / uploaded / status / progress / cost / lastCost /
     error / taskId / submittedAt / pendingPlace / sourceLost / dupFlash
   - 载入模板时重新分配节点 id 并重映射连线，节点状态统一为「待生成」(idle) */

const RUNTIME_KEYS = [
  'urls', 'refImages', 'uploaded', 'status', 'progress', 'cost', 'lastCost',
  'error', 'taskId', 'submittedAt', 'pendingPlace', 'sourceLost', 'dupFlash'
]

/* 画布 → 模板数据 */
export function templateFrom(nodes, edges, viewport) {
  const keep = (nodes || []).map((n) => {
    const data = { ...(n.data || {}) }
    for (const k of RUNTIME_KEYS) delete data[k]
    return {
      id: n.id,
      type: n.type,
      position: { x: Math.round(n.position?.x || 0), y: Math.round(n.position?.y || 0) },
      data
    }
  })
  return {
    nodes: keep,
    edges: (edges || []).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle || 'out',
      targetHandle: e.targetHandle,
      type: e.type || 'flow'
    })),
    viewport: viewport || null
  }
}

/* 模板数据 → 画布节点：重新编号 + 状态归零（待生成） */
export function instantiateTemplate(data, nextId) {
  const idMap = new Map()
  const nodes = (data?.nodes || []).map((n) => {
    const id = nextId()
    idMap.set(n.id, id)
    const data2 = { ...(n.data || {}) }
    for (const k of RUNTIME_KEYS) delete data2[k]
    data2.status = 'idle'
    data2.progress = 0
    data2.urls = []
    return {
      ...n,
      id,
      selected: false,
      position: { ...n.position },
      data: data2
    }
  })
  const edges = (data?.edges || [])
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({
      ...e,
      id: `e_${idMap.get(e.source)}__${idMap.get(e.target)}`,
      source: idMap.get(e.source),
      target: idMap.get(e.target),
      animated: true,
      type: e.type || 'flow'
    }))
  return { nodes, edges }
}

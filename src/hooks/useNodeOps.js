/* S17-0a：从 App.jsx 抽出的节点操作（纯搬移，逻辑逐行保持原样）
   含：连线合法性校验 / 卡片尺寸与占位矩形 / 复制 / 删除 / 全选 / 方向键微调。
   工具条 / 右键菜单 / 快捷键共用同一份实现（UI-020 同源性）。 */
import { nextId } from '../lib/ids.js'
import { uploadedWidth, cardWidthFor } from '../nodes.jsx'

export function useNodeOps({
  nodesRef, edgesRef, setNodes, setEdges, selectedId, setSelectedId, rfw, setConnTip, connTipTimer
}) {
  /* 连线合法性（UI-019）：拒绝时给出具体原因，不再静默 return false */
  const connRejectReason = (conn) => {
    const { source, target, targetHandle } = conn || {}
    if (!source || !target) return '请把线连到目标卡片左侧的挂点上'
    if (source === target) return '不能把节点连到自己身上'
    const src = nodesRef.current.find((n) => n.id === source)
    const tgt = nodesRef.current.find((n) => n.id === target)
    if (!src || !tgt) return '节点已不存在，请重新拖一次'
    if (src.data?.kind === 'text' && targetHandle === 'in-img') return '文本输出只能连到「提示词」输入，不能当参考图'
    if (src.data?.kind === 'text' && (targetHandle === 'in-video' || targetHandle === 'in-audio')) {
      return '成片合成只接收视频片和配音，文本请连到配音卡的台词输入'
    }
    if (src.type !== 'text' && targetHandle === 'in-text') return '图片/视频输出不能当作文本，请连到参考图输入'
    /* P3：合成卡的两个输入口按类型分流，避免把图片当视频、把视频当音轨 */
    if (targetHandle === 'in-video' && src.data?.kind !== 'video') return '「视频」输入口只接收视频节点'
    if (targetHandle === 'in-audio' && src.data?.kind !== 'audio') return '「配音」输入口只接收配音节点'
    if (edgesRef.current.some((e) => e.source === source && e.target === target
      && (e.targetHandle || null) === (targetHandle || null))) {
      return '这两个挂点已经连过了，重复连线不会生效'
    }
    return null
  }
  const isValidConnection = (conn) => connRejectReason(conn) === null

  /* 拒绝原因提示：跟随落点、1.8 秒自动消失 */
  const showConnTip = (x, y, text) => {
    setConnTip({ x, y, text })
    clearTimeout(connTipTimer.current)
    connTipTimer.current = setTimeout(() => setConnTip(null), 1800)
  }

  /* 卡片实际宽度（flow 坐标）：优先数据里的 cardWidth，其次从 DOM 量取（已除以缩放），
     最后按节点类型/比例回推——用于复制偏移，避免写死常量导致大卡片仍重叠（UI-018） */
  const nodeWidthOf = (n) => {
    if (n?.data?.cardWidth) return n.data.cardWidth
    if (n?.type === 'text') return 250
    const el = document.querySelector(`.react-flow__node[data-id="${n.id}"] .node-wrap`)
    const zoom = rfw.getZoom() || 1
    const domW = el ? Math.round(el.getBoundingClientRect().width / zoom) : 0
    if (domW) return domW
    return n?.data?.uploaded && n?.data?.ar
      ? uploadedWidth(n.data.ar)
      : cardWidthFor(n?.data?.kind || n?.type, n?.data?.size)
  }

  /* UI-030：节点占位矩形（宽度数据驱动，高度优先 DOM 量测） */
  const nodeRectOf = (n, w) => {
    const el = document.querySelector(`.react-flow__node[data-id="${n.id}"] .node-wrap`)
    const zoom = rfw.getZoom() || 1
    const domH = el ? Math.round(el.getBoundingClientRect().height / zoom) : 0
    return { x: n.position.x, y: n.position.y, w, h: domH || 260 }
  }
  const rectsOverlap = (a, b) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) > 0 &&
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) > 0

  const duplicateSelected = (onlyId) => {
    const src = onlyId
      ? nodesRef.current.find((n) => n.id === onlyId)
      : (nodesRef.current.find((n) => n.id === selectedId) || nodesRef.current.find((n) => n.selected))
    if (!src) return
    const isUpload = !!src.data?.uploaded
    const w = nodeWidthOf(src)
    // UI-030：副本落点避让所有已有节点 —— 首选右侧 48px 空位（UI-018 语义），
    // 被占则沿 Y 轴/X 轴逐格探测最近空位；宽度全程数据驱动，不写死常量
    const pref = { x: src.position.x + w + 48, y: src.position.y + 24 }
    const self = nodeRectOf(src, w)
    const others = nodesRef.current
      .filter((n) => n.id !== src.id)
      .map((n) => nodeRectOf(n, nodeWidthOf(n)))
    const freePos = (rect, others) => {
      if (!others.some((o) => rectsOverlap(rect, o))) return rect
      for (let row = 0; row < 40; row++) {
        for (let col = 0; col < 10; col++) {
          const cand = { ...rect, x: rect.x + col * (rect.w + 48), y: rect.y + row * (rect.h + 48) }
          if (!others.some((o) => rectsOverlap(cand, o))) return { x: cand.x, y: cand.y }
        }
      }
      return { x: rect.x, y: rect.y }
    }
    const pos = freePos({ ...pref, w, h: self.h }, others)
    const n = {
      ...src,
      id: nextId(),
      position: pos,
      selected: true, // 副本必须真正选中：xyflow 的选中态由节点 selected 字段驱动
      data: {
        ...src.data,
        label: (src.data.label || '') + ' 副本',
        error: '', cost: '', lastCost: 0,
        dupFlash: true, // UI-030：1.8s 淡色描边闪烁，任何落点下都能察觉「多了一个节点」
        // 生成节点副本：清空产物并摘掉 uploaded 语义；上传素材副本保留素材引用
        ...(isUpload
          ? { status: 'done', progress: 100, urls: src.data.urls || [] }
          : { status: 'idle', progress: 0, urls: [], uploaded: false })
      }
    }
    setNodes((ns) => ns.map((x) => ({ ...x, selected: false })).concat(n))
    setSelectedId(n.id)
    // REF-004：副本带上原节点的参考连线（只复制上游仍存在的边，指向新节点）
    const incoming = edgesRef.current.filter((e) => e.target === src.id)
    if (incoming.length) {
      setEdges((es) => es.concat(incoming.map((e) => ({
        ...e, id: `${e.id}__dup_${n.id}`, target: n.id, selected: false
      }))))
    }
    setTimeout(() => {
      setNodes((ns) => ns.map((x) => (x.id === n.id && x.data?.dupFlash ? { ...x, data: { ...x.data, dupFlash: false } } : x)))
    }, 1800)
  }

  /* 删除：支持多选（Ctrl+A 全选后一次删除） */
  const removeSelected = () => {
    const ids = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id))
    if (selectedId) ids.add(selectedId)
    if (!ids.size) return
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)))
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)))
    setSelectedId(null)
  }

  const selectAllNodes = () => {
    if (!nodesRef.current.length) return
    setNodes((ns) => ns.map((n) => ({ ...n, selected: true })))
  }

  /* 方向键微调：锁定节点不动，1px / Shift 10px */
  const nudgeSelected = (dx, dy) => {
    const ids = new Set(nodesRef.current.filter((n) => n.selected && !n.data?.locked).map((n) => n.id))
    if (selectedId) {
      const n = nodesRef.current.find((x) => x.id === selectedId)
      if (n && !n.data?.locked) ids.add(selectedId)
    }
    if (!ids.size) return
    setNodes((ns) => ns.map((n) => (ids.has(n.id)
      ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
      : n)))
  }

  return {
    connRejectReason, isValidConnection, showConnTip,
    nodeWidthOf, nodeRectOf, rectsOverlap,
    duplicateSelected, removeSelected, selectAllNodes, nudgeSelected
  }
}

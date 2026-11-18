/* S17-0a：从 App.jsx 抽出的「往画布放节点」逻辑（纯搬移，逻辑逐行保持原样）
   含：落点避让 freeSpot(S16-3) / addNode / ＋菜单 / 上传落卡 / 打开文件对话框。 */
import { useRef } from 'react'
import { addEdge } from '@xyflow/react'
import { makeTextNode, uploadedWidth } from '../nodes.jsx'
import { iconFor } from '../lib/flowGraph.js'
import { nextId } from '../lib/ids.js'

export function useCanvasInsert({
  nodesRef, setNodes, setEdges, setSelectedId, setMenuAt,
  screenToFlowPosition, mkImage, mkVideo, mkAudio, mkCompose, edgeColor
}) {
  /* 卡片放到鼠标位置后，按实际渲染尺寸再居中一次（上传卡片宽度随比例变化，估算会偏） */
  const centerNodeAt = (id, at) => {
    const fp = screenToFlowPosition({ x: at.x, y: at.y })
    const snap = (tries = 12) => {
      const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
      const w = el?.offsetWidth, h = el?.offsetHeight
      if (!w || !h) { if (tries > 0) setTimeout(() => snap(tries - 1), 50); return }
      setNodes((ns) => ns.map((x) => (x.id === id
        ? { ...x, position: { x: fp.x - w / 2, y: fp.y - h / 2 } }
        : x)))
    }
    setTimeout(() => snap(), 50)
  }

  /* S16-3：本轮已分配的落点（连续新建时 React 尚未渲染，nodesRef 还没更新，靠它防撞） */
  const spotMemo = useRef([])

  /* S16-3：无指定落点时的自动摆放。
     原实现 `80 + (count % 4) * 60` 偏移只有 60×50，节点尺寸 250~340 宽，必然重叠，
     且 % 4 会让第 5 个节点精确回到第 1 个位置。现改为：
     ① 以**当前视口中心**为锚（用户平移后新节点仍在视野内，不跑回画布原点）；
     ② 按网格向外排布，中列优先；
     ③ 每个格位再做矩形相交检测，命中就 +40 对角试探（最多 8 次），仍冲突才换下一格。 */
  const freeSpot = (w = 340, h = 300) => {
    const pane = document.querySelector('.react-flow')
    const r = pane?.getBoundingClientRect()
    const center = r && r.width
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const fp = screenToFlowPosition(center)
    /* 视口在画布坐标系里的可见矩形——用于判断候选点是否落在可见区 */
    const tl = r && r.width ? screenToFlowPosition({ x: r.left, y: r.top }) : { x: fp.x - 640, y: fp.y - 400 }
    const br = r && r.width ? screenToFlowPosition({ x: r.right, y: r.bottom }) : { x: fp.x + 640, y: fp.y + 400 }
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi))
    const minX = tl.x + 16, maxX = clamp(br.x - w - 16, minX, br.x)
    const minY = tl.y + 16, maxY = clamp(br.y - h - 16, minY, br.y)
    const boxes = nodesRef.current.map((n) => ({
      x: n.position?.x || 0,
      y: n.position?.y || 0,
      w: n.measured?.width || n.width || n.data?.cardWidth || 340,
      h: n.measured?.height || n.height || 300
    }))
    /* 已分配但还没进入 nodesRef 的位置（连续 addNode 时 React 尚未渲染）——一并避开 */
    const recent = spotMemo.current
    const clash = (x, y) => [...boxes, ...recent].some((b) => x < b.x + b.w + 20 && x + w + 20 > b.x
      && y < b.y + b.h + 20 && y + h + 20 > b.y)
    const COLS = 3, GAP_X = 400, GAP_Y = 500
    const order = [1, 0, 2] // 先中、再左、再右，视觉上更自然
    /* 优先采用「在视口内且不撞」的格子；视口确实排不下时退而求其次取第一个不撞的位置
       （只保证不重叠 + 尽量靠近视口，不再硬夹紧到边界，否则多个节点会挤成同一格） */
    let inside = null, outside = null
    for (let i = 0; i < 60 && !inside; i++) {
      const col = order[i % COLS] - 1 // -1 / 0 / 1
      const row = Math.floor(i / COLS)
      let cand = { x: fp.x - w / 2 + col * GAP_X, y: fp.y - h / 2 + row * GAP_Y }
      for (let k = 0; k < 8; k++) {
        if (!clash(cand.x, cand.y)) {
          const inView = cand.x >= minX && cand.x <= maxX && cand.y >= minY && cand.y <= maxY
          if (inView) { inside = cand; break }
          if (!outside) outside = cand
        }
        cand = { x: cand.x + 40, y: cand.y + 40 }
      }
    }
    const at = inside || outside || { x: clamp(fp.x - w / 2, minX, maxX), y: clamp(fp.y - h / 2, minY, maxY) }
    spotMemo.current = [...recent, { x: at.x, y: at.y, w, h }].slice(-8)
    return at
  }

  const addNode = (maker, at) => {
    let pos
    if (at) {
      // 在鼠标位置出卡片：以卡片中心对齐光标
      const fp = screenToFlowPosition({ x: at.x, y: at.y })
      pos = { x: fp.x - 170, y: fp.y - 175 }
    } else {
      pos = freeSpot()
    }
    const n = maker(pos)
    n.id = nextId()
    setNodes((ns) => [...ns, n])
    setSelectedId(n.id)
    if (at) centerNodeAt(n.id, at)
  }

  /* ＋ 菜单动作（pos 为右键弹出的鼠标位置） */
  const handleAdd = (key, pos) => {
    setMenuAt(null)
    if (key === 'text') { addNode(makeTextNode, pos); return }
    if (key === 'image') { addNode(mkImage, pos); return }
    if (key === 'video') { addNode(mkVideo, pos); return }
    if (key === 'audio') { addNode(mkAudio, pos); return }
    if (key === 'compose') { addNode(mkCompose, pos); return }
    if (key === 'upload') uploadMedia(pos ? { drop: pos } : {})
  }

  /* 上传本地媒体 → 生成对应卡片（可指定落点并回连到发起挂点） */
  /* 媒体落卡核心：拖放与文件对话框共用。label 可覆盖默认标题（S18 资产插入显示文件名） */
  const createMediaNode = async ({ kind, dataUrl, drop, connectTo, label }) => {
    let pos
    if (drop) {
      const fp = screenToFlowPosition({ x: drop.x, y: drop.y })
      pos = { x: fp.x - 170, y: fp.y - 170 }
    } else {
      pos = freeSpot(340, 420) // S16-3：上传卡同走避让落点
    }
    const maker = kind === 'video' ? mkVideo : kind === 'audio' ? mkAudio : mkImage
    const n = maker(pos)
    n.id = nextId()
    n.data.urls = [dataUrl]
    n.data.uploaded = true
    /* C-1：上传素材卡不是生成任务，不能带默认模型——否则参考栏/运行提示会把
       「flux 2-pro」之类的模型标挂到上传图上（mkImage/mkVideo 会注入偏好默认模型） */
    n.data.model = ''
    n.data.status = 'done'
    n.data.progress = 100
    n.data.label = label || (kind === 'video' ? '上传视频' : kind === 'audio' ? '配音' : '上传图片')
    // 读取素材真实宽高比：卡片按原比例显示，不再固定 1:1（音频卡无画面比例）
    const ar = kind === 'audio' ? null : await new Promise((res) => {
      if (kind === 'video') {
        const v = document.createElement('video')
        v.onloadedmetadata = () => res(v.videoWidth / v.videoHeight)
        v.onerror = () => res(null)
        v.src = dataUrl
      } else {
        const img = new Image()
        img.onload = () => res(img.naturalWidth / img.naturalHeight)
        img.onerror = () => res(null)
        img.src = dataUrl
      }
    })
    if (ar && Number.isFinite(ar) && ar > 0) {
      n.data.ar = ar
      n.data.cardWidth = uploadedWidth(ar) // 卡片宽度按原图比例重算（默认 340 的 1:1 会盖住比例）
    }
    setNodes((ns) => [...ns, n])
    if (drop) centerNodeAt(n.id, drop) // 双击/右键/拖放落点：按真实比例居中到光标
    if (connectTo) {
      setEdges((es) => addEdge({
        source: n.id, sourceHandle: 'out',
        target: connectTo.nodeId, targetHandle: connectTo.handleId,
        animated: true, type: 'flow',
        data: { sIcon: iconFor(kind), tIcon: 'img' },
        style: { stroke: edgeColor }
      }, es))
    }
    setSelectedId(n.id)
  }

  const uploadMedia = async (opts = {}) => {
    const f = await window.flow.pickFile()
    if (!f || f.error) { if (f?.error) console.error(f.error); return }
    await createMediaNode({ kind: f.kind, dataUrl: f.dataUrl, drop: opts.drop, connectTo: opts.connectTo })
  }

  return { freeSpot, addNode, handleAdd, createMediaNode, uploadMedia }
}

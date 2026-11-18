/* S17-0a：从 App.jsx 抽出的 Agent 工具桥（纯搬移，逻辑逐行保持原样）
   职责：暴露 window.__flowAgent，让右下角 Agent 与自动化测试操作画布。
   定向复审 P1-2：Agent 与 UI（execute）共用同一个 runningRef 原子闸——
   旧实现 Agent 只查/置 running 状态字段，与 execute 的 runningRef 互不可见，
   两侧可同时进入 runFlow，同一画布并发提交生成任务。 */
import { useEffect } from 'react'
import { addEdge } from '@xyflow/react'
import { runFlow } from '../engine.js'
import { modelPricingKnown } from '../costEstimate.js'
import { makeTextNode, cardWidthFor } from '../nodes.jsx'
import { iconFor } from '../lib/flowGraph.js'
import { nextId } from '../lib/ids.js'
import { useTaskApi } from '../store/taskStore.jsx'
import { mdPlain } from '../lib/mdplain.js'
import { sanitizeImageParams } from '../lib/imageSpecs.js'

export function useAgentBridge({
  nodesRef, edgesRef, setNodes, setEdges, setSelectedId, update,
  setSpent, setRunning, runningRef, freeSpot, mkImage, mkVideo, edgeColor, taskCtxRef
}) {
  /* S17-0b：Agent 的 run_all 与 UI 运行写同一个任务 store——首页看到的是同一件事 */
  const taskApi = useTaskApi()

  /* 问题5：画布引用索引——把生成节点编成人话序号（图1/图2…视频1…），
     让用户能说「用画布里的第 2 张人物图」，Agent 不必反过来向用户要节点 id */
  const refIndexOf = (nodes) => {
    let gi = 0, vi = 0
    const map = new Map() // id → '图1' / '视频2'
    for (const n of nodes) {
      if (n.type === 'image') { gi++; map.set(n.id, `图${gi}`) }
      else if (n.type === 'video') { vi++; map.set(n.id, `视频${vi}`) }
    }
    return map
  }
  const resolveRef = (raw) => {
    const s = String(raw ?? '').trim()
    if (!s) return { id: s }
    if (nodesRef.current.some((n) => n.id === s)) return { id: s }
    const m = /^(?:图|第)\s*(\d+)\s*张?(?:图|片|照片)?$/.exec(s)
    if (m) {
      const idx = Number(m[1])
      const imgs = nodesRef.current.filter((n) => n.type === 'image')
      if (idx >= 1 && idx <= imgs.length) return { id: imgs[idx - 1].id }
      return { error: `画布里没有第 ${idx} 张图片（现在共 ${imgs.length} 张）` }
    }
    const mv = /^视频\s*(\d+)$/.exec(s)
    if (mv) {
      const idx = Number(mv[1])
      const vids = nodesRef.current.filter((n) => n.type === 'video')
      if (idx >= 1 && idx <= vids.length) return { id: vids[idx - 1].id }
      return { error: `画布里没有第 ${idx} 个视频节点（现在共 ${vids.length} 个）` }
    }
    return { error: '节点不存在: ' + s }
  }
  /* 角色摘要：从下游节点的 refRoles 反查本节点被标注的角色（主角/场景/产品/风格参考） */
  const roleSummary = (nid) => {
    const roles = []
    for (const n of nodesRef.current) {
      for (const [k, v] of Object.entries(n.data?.refRoles || {})) {
        if (k === nid && v && !roles.includes(v)) roles.push(v)
      }
    }
    return roles.join('/')
  }

  const agentRun = async (onlyId) => {
    if (runningRef.current) throw new Error('已有任务正在运行，请稍候再试')
    const caps = {}
    const upd = (id, patch) => { caps[id] = { ...(caps[id] || {}), ...patch }; update(id, patch) }
    runningRef.current = true
    setRunning(true)
    const meta = taskCtxRef?.current || {}
    const taskId = taskApi.start({
      projectKey: meta.projectKey,
      projectName: meta.projectName,
      scope: onlyId ? 'node' : 'all',
      total: 0,
      estimate: 0
    })
    try {
      const res = await runFlow({
        nodes: nodesRef.current, edges: edgesRef.current, update: upd,
        onSpend: (c) => { setSpent((v) => v + c); taskApi.spend(taskId, c) },
        onlyId, skipDone: !onlyId,
        // BUG-2 相关：Agent 路径固定原地覆盖——不落新卡片，结果写回原节点，
        // 避免「生成完多出一张看不见的新卡片 / 原卡片看似消失」的感知错位，
        // 也避免 pendingPlace:'new' 在无 onResult 时残留在节点数据里
        regenerate: 'inplace',
        onPlan: (ids) => taskApi.plan(taskId, ids),
        onNodeEnd: (id, ok) => taskApi.nodeEnd(taskId, ok)
      })
      taskApi.finish(taskId, res)
      return { caps, credits: res.credits }
    } catch (err) {
      taskApi.fail(taskId, err?.message || err)
      throw err
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }

  const agent = {
    readFlow() {
      const refIdx = refIndexOf(nodesRef.current)
      return {
        nodes: nodesRef.current.map((n) => ({
          id: n.id, type: n.type, label: n.data?.label || '',
          ...(refIdx.has(n.id) ? { ref: refIdx.get(n.id) } : {}),
          ...(n.type !== 'text' ? { role: roleSummary(n.id) } : {}),
          model: n.data?.model || '',
          prompt: n.data?.prompt || n.data?.text || '',
          size: n.data?.size || '', resolution: n.data?.resolution || '',
          ...(n.type === 'video' ? { duration: n.data?.duration, audio: n.data?.audio } : {}),
          ...(n.type === 'video' && n.data?.klingMode ? { klingMode: n.data.klingMode } : {}),
          ...(n.type === 'image' ? { n: n.data?.n } : {}),
          status: n.data?.status || 'idle',
          hasResult: (n.data?.urls || []).length > 0,
          urls: (n.data?.urls || []).slice(0, 2)
        })),
        edges: edgesRef.current.map((e) => ({
          source: e.source, target: e.target,
          /* 1.2.0：带上挂点，控制脚本才能验证「提示词进的是 T 入口而不是图片入口」 */
          sourceHandle: e.sourceHandle || '', targetHandle: e.targetHandle || ''
        })),
        /* 引用说明：用户说的「第 N 张图」「视频N」可直接作为 id 传给工具 */
        refNote: '图片节点按顺序编号为 图1/图2…，视频节点为 视频1…；工具的 id 参数可直接填这些引用'
      }
    },
    // 返回节点原始 data（readFlow 是扁平摘要；Isle/测试需要 refRoles/refImages 等完整字段时用这个）
    getNode({ id }) {
      const r = resolveRef(id)
      if (r.error) return { ok: false, error: r.error }
      const n = nodesRef.current.find((x) => x.id === r.id)
      if (!n) return { ok: false, error: '节点不存在: ' + id }
      return { ok: true, id: n.id, type: n.type, data: n.data }
    },
    // 移动节点到指定画布坐标（Isle 排版 / 测试避让重叠用）
    moveNode({ id, x, y }) {
      const n = nodesRef.current.find((v) => v.id === id)
      if (!n) return { ok: false, error: '节点不存在: ' + id }
      setNodes((ns) => {
        const next = ns.map((v) => (v.id === id ? { ...v, position: { x: Number(x), y: Number(y) } } : v))
        nodesRef.current = next
        return next
      })
      return { ok: true, id, x, y }
    },
    async listModels() {
      const s = await window.flow.getSettings()
      return {
        image: (s.models?.image || []).map((m) => m.model),
        video: (s.models?.video || []).map((m) => m.model),
        chat: (s.models?.chat || []).map((m) => m.model),
        aspects: ['Auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9', '4:5', '5:4'],
        imageResolutions: ['1K', '2K', '4K'],
        videoResolutions: ['480p', '720p', '1080p', '4k']
      }
    },
    async addNode({ kind, prompt, x, y }) {
      const s = await window.flow.getSettings()
      const maker = kind === 'video' ? mkVideo : kind === 'text' ? makeTextNode : mkImage
      /* S16-3：Agent 建节点与手动新建共用同一套避让落点（旧实现 % 4 循环会让第 5 个回到第 1 个位置） */
      const auto = freeSpot(kind === 'text' ? 260 : 340, kind === 'video' ? 470 : 460)
      const pos = {
        x: typeof x === 'number' ? x : auto.x,
        y: typeof y === 'number' ? y : auto.y
      }
      const n = maker(pos)
      n.id = nextId()
      const cleanPrompt = mdPlain(prompt) // B-3：提示词落画布必须是纯文本
      if (kind === 'text' || kind === undefined) n.data.text = cleanPrompt
      else {
        n.data.prompt = cleanPrompt
        const list = s.models?.[kind] || []
        if (list.length) {
          // Q1-2：与 mkImage/mkVideo 同一默认链路——默认模型仍启用则用之；
          // 回落优先计费已知（未定价模型大概率网关未配置，实测 500）
          const dm = (s.defaultModels || {})[kind]
          if (dm && list.some((m) => m.model === dm)) n.data.model = dm
          else {
            const known = list.find((m) => modelPricingKnown(m.model, kind))
            n.data.model = known?.model || list[0].model
          }
        }
      }
      setNodes((ns) => { const next = [...ns, n]; nodesRef.current = next; return next })
      setSelectedId(n.id)
      return { ok: true, id: n.id, type: n.type, model: n.data.model || '', position: pos }
    },
    setParams({ id, ...p }) {
      const r = resolveRef(id)
      if (r.error) return { ok: false, error: r.error }
      const nid = r.id
      const n = nodesRef.current.find((x) => x.id === nid)
      if (!n) return { ok: false, error: '节点不存在: ' + id }
      const patch = {}
      // taskId/submittedAt：Isle 需要能给节点挂远端任务上下文（查询/续查），也便于运维排查
      for (const k of ['prompt', 'text', 'model', 'size', 'resolution', 'duration', 'n', 'audio', 'taskId', 'submittedAt', 'refRoles', 'refImages',
        /* 1.2.0：Kling-v4 模式 / 音色地址 / 参考视频（Agent 与自动化脚本可改） */
        'klingMode', 'refAudioUrl', 'refVideoUrl', 'motionOrientation', 'motionMode']) {
        if (p[k] === undefined || p[k] === null) continue
        patch[k] = k === 'duration' || k === 'n' ? Number(p[k]) : (k === 'prompt' || k === 'text' ? mdPlain(p[k]) : p[k]) // B-3
      }
      if (!Object.keys(patch).length) return { ok: false, error: '没有可设置的字段' }
      /* 1.2.0：图片节点按模型尺寸口径收敛（4K 只到 2K 的模型、固定像素模型）。
         走界面设置时面板已经裁过，这里是 Agent/脚本路径——保证卡片上显示的值
         就是真正会提交的值，不会出现「卡片写 4K、实际发 2K」。 */
      if (n.type === 'image') {
        const fixed = sanitizeImageParams(patch.model ?? n.data.model, {
          size: patch.size !== undefined ? patch.size : n.data.size,
          resolution: patch.resolution !== undefined ? patch.resolution : n.data.resolution
        })
        patch.size = fixed.params.size
        patch.resolution = fixed.params.resolution
        if (fixed.notes.length) patch.sizeNotes = fixed.notes
      }
      // 视频改比例时同步卡片宽度（与右侧面板行为一致）
      if (patch.size && n.type === 'video') patch.cardWidth = cardWidthFor('video', patch.size)
      update(nid, patch)
      return { ok: true, id: nid, params: patch }
    },
    connect({ source, target }) {
      const rs = resolveRef(source), rt = resolveRef(target)
      if (rs.error) return { ok: false, error: rs.error }
      if (rt.error) return { ok: false, error: rt.error }
      source = rs.id; target = rt.id
      const byId = new Map(nodesRef.current.map((n) => [n.id, n]))
      const s = byId.get(source), t = byId.get(target)
      if (!s || !t) return { ok: false, error: '节点不存在: ' + (!s ? source : target) }
      if (source === target) return { ok: false, error: '不能把节点连到自身' }
      if (edgesRef.current.some((e) => e.source === source && e.target === target)) {
        return { ok: true, source, target, already: true }
      }
      /* 1.2.0：目标挂点由「来源类型」决定，而不是目标类型。
         旧实现按目标类型给出 in-img——提示词连到视频卡时会挂到图片入口，
         提示词变成参考图，重开项目又被当非法连线清掉（用户感知「连线自己没了」）。 */
      const sourceIsText = s.type === 'text' || s.data?.kind === 'text'
      let targetHandle = 'in-img'
      if (sourceIsText || t.type === 'text') targetHandle = 'in-text'
      else if (t.data?.kind === 'compose') targetHandle = s.data?.kind === 'audio' ? 'in-audio' : 'in-video'
      setEdges((es) => addEdge({
        id: `e_${source}__${target}`, source, sourceHandle: 'out', target, targetHandle,
        animated: true, type: 'flow',
        data: { sIcon: iconFor(s.type), tIcon: iconFor(t.type) },
        style: { stroke: edgeColor }
      }, es))
      return { ok: true, source, target, sourceHandle: 'out', targetHandle }
    },
    deleteNode({ id }) {
      const r = resolveRef(id)
      if (r.error) return { ok: false, error: r.error }
      const nid = r.id
      if (!nodesRef.current.some((n) => n.id === nid)) return { ok: false, error: '节点不存在: ' + id }
      setNodes((ns) => { const next = ns.filter((n) => n.id !== nid); nodesRef.current = next; return next })
      setEdges((es) => { const next = es.filter((e) => e.source !== nid && e.target !== nid); edgesRef.current = next; return next })
      setSelectedId((cur) => (cur === nid ? null : cur))
      return { ok: true, id: nid }
    },
    async runNode({ id }) {
      const r = resolveRef(id)
      if (r.error) return { ok: false, error: r.error }
      const nid = r.id
      const n = nodesRef.current.find((x) => x.id === nid)
      if (!n) return { ok: false, error: '节点不存在: ' + id }
      if (!n.data?.model) return { ok: false, error: '该节点未选择模型，请先用 set_params 设置 model' }
      try {
        const { caps, credits } = await agentRun(nid)
        const st = caps[nid] || {}
        return {
          ok: true, id: nid, ref: refIndexOf(nodesRef.current).get(nid) || '', status: st.status || 'done',
          urls: (st.urls || []).slice(0, 2), credits
        }
      } catch (err) {
        return { ok: false, id: nid, error: String(err?.message || err) }
      }
    },
    async runAll() {
      try {
        const { caps, credits } = await agentRun(null)
        const nodes = Object.entries(caps).map(([id, p]) => ({
          id, status: p.status, urls: (p.urls || []).slice(0, 1)
        }))
        return { ok: true, credits, ranNodes: nodes }
      } catch (err) {
        return { ok: false, error: String(err?.message || err) }
      }
    }
  }

  // 保持原语义：无依赖数组，每次渲染都刷新挂载（Agent 取到最新闭包）
  useEffect(() => { window.__flowAgent = agent })

  return agent
}

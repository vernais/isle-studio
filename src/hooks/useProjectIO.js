import { useEffect, useRef, useState } from 'react'
import { bumpIdSeq, nextId } from '../lib/ids.js'
import { normalizeLoadedGraph } from '../lib/flowGraph.js'
import { taskSessionId, useTaskApi } from '../store/taskStore.jsx'

/* S18 修复：保存时未命名会话的资产会被并入项目目录，主进程回传前缀映射，
   内存节点必须同步改指到新目录，否则画面上的图会因暂存目录被回收而断链 */
function remapAssetUrls(list, from, to) {
  if (!Array.isArray(list)) return list
  let changed = false
  const out = list.map((u) => {
    if (typeof u === 'string' && u.startsWith(from)) { changed = true; return to + u.slice(from.length) }
    return u
  })
  return changed ? out : list
}
function remapNodes(nodes, from, to) {
  if (!Array.isArray(nodes)) return nodes
  let touched = false
  const out = nodes.map((n) => {
    const d = n?.data
    if (!d) return n
    const urls = remapAssetUrls(d.urls, from, to)
    const refs = remapAssetUrls(d.refImages, from, to)
    if (urls === d.urls && refs === d.refImages) return n
    touched = true
    return { ...n, data: { ...d, urls, refImages: refs } }
  })
  return touched ? out : nodes
}

/* ---------- 项目持久化（从 App.jsx 抽出，ARCH-004）----------
   承载：项目名 / 脏标记（内容快照 diff）/ 保存 / 打开 / 新建 / 快速生成 / 返回主页 / 项目列表。
   依赖由调用方注入；续查任务用 ref 延迟绑定（调用方定义在 hook 之后）。 */
export function useProjectIO({
  nodes, edges, nodesRef, edgesRef, setNodes, setEdges, setSelectedId, setView,
  historyRef, askConfirm, showToast, resumePendingRef, mkImage, rfw,
  /* S17-3：首页沟通记录随项目落盘（agentLog），打开项目时回传 */
  getAgentLog, onAgentLog,
  /* B-9：画布会话开始（新建/打开/快速生成/模板）回调——顶栏「本次已用」积分随之归零 */
  onSessionBegin
}) {
  const taskApi = useTaskApi() // B-5：命名保存后把 session 任务记录并入项目
  const extraData = () => {
    const log = typeof getAgentLog === 'function' ? getAgentLog() : null
    return Array.isArray(log) && log.length ? { agentLog: log } : {}
  }
  const noteAgentLog = (d) => { if (typeof onAgentLog === 'function') onAgentLog(d?.agentLog || null) }
  const resumePendingNodes = (l) => resumePendingRef?.current?.(l)
  /* ---------- 项目：脏标记 + 保存/打开/新建 ---------- */
  const [projectName, setProjectName] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [projects, setProjects] = useState([])
  const firstGraph = useRef(true)

  /* dirty 判定（S9 / IR-001）：基于内容快照 diff，而非 nodes/edges 数组引用变化。
     xyflow 的选中/拖拽会重建节点数组但不改变内容，旧的引用监听会把「选中→取消选中」误标为未保存。
     快照只剔除纯瞬态字段（selected / dragging / measured / dupFlash），
     其余 data 字段（含运行 status/urls）保留——运行产物更新仍按现有行为标脏。
     基线快照在保存 / 打开 / 新建 / 撤销等整图替换时刷新，机制可直接复用为自动保存（ARCH-003）的变更检测。 */
  const graphSnap = (nodes, edges) => JSON.stringify({
    nodes: (nodes || []).map((n) => {
      const o = { ...n }
      delete o.selected; delete o.dragging; delete o.measured
      if (o.data && 'dupFlash' in o.data) { const d = { ...o.data }; delete d.dupFlash; o.data = d }
      return o
    }),
    edges: (edges || []).map((e) => { const o = { ...e }; delete o.selected; return o }),
  })
  const savedSnapRef = useRef(null)
  const snapReset = useRef(false) // 打开/新建等整图替换：刷新基线快照，而不是标脏
  // 注意：撤销/重做（applySnapshot）不设 snapReset——阶段0修复①：基线只跟「成功落盘的快照」走，
  // undo 穿过保存点时 dirty 必须为 true，否则返回主页会静默丢弃未保存内容
  useEffect(() => {
    if (firstGraph.current) { firstGraph.current = false; savedSnapRef.current = graphSnap(nodes, edges); return }
    if (snapReset.current) { snapReset.current = false; savedSnapRef.current = graphSnap(nodes, edges); setDirty(false); return }
    setDirty(graphSnap(nodes, edges) !== savedSnapRef.current)
  }, [nodes, edges])

  const stamp = () => {
    const d = new Date(); const p = (x) => String(x).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /* 定向复审补充项：未落盘画布的离开保护。
     quickCreate/模板载入把画布设为「干净」（基线=当前图，dirty=false），但这些内容
     从未落盘——返回主页/关闭应用会静默丢失。用 everSavedRef 区分两种「干净」：
     会话内从未保存成功且画布非空 → 离开前同样必须提示。空画布不受影响 */
  const everSavedRef = useRef(true)
  const setPersisted = (v) => { everSavedRef.current = !!v }
  const unsavedWork = () => dirty || (!everSavedRef.current && (nodesRef?.current?.length || 0) > 0)

  /* 阶段0修复②：保存竞态防护。
     - 调用时即冻结快照与项目名：保存期间继续编辑，成功回调只把「落盘的那份快照」设为基线，
       画布与新基线的 diff 交给既有 effect 重算 → 保存后的编辑仍是 dirty=true
     - 保存串行排队：同项目并发保存按调用顺序落盘，杜绝旧快照逆序覆盖新快照
     - 项目上下文守卫：完成时若已切换/新建项目，只落盘、不污染当前会话的名称与基线
     （切换项目后旧保存回调改当前项目名的缺陷，见阶段0报告 §3.2-5 SWITCH 场景） */
  const projectNameRef = useRef(null)
  useEffect(() => { projectNameRef.current = projectName }, [projectName])
  /* 定向复审 P0-2：会话标识。项目名不能唯一标识会话——两个未命名项目的名字都是 null，
     同名项目名字相同；旧保存完成回调只凭名字比对会把结果污染进新会话。
     每次新建/打开/快速生成/模板载入都递增 sessionRef，保存完成回调先验会话再落地 */
  const sessionRef = useRef(0)
  /* 定向复审 P1-1：乐观版本基线。load/save 回执的 savedAt 作为本窗口已知版本，
     保存时随 baseSavedAt 送给主进程；磁盘版本被其他窗口推进时主进程拒绝覆盖 */
  const lastSavedAtRef = useRef(null)
  const noteSavedAt = (ts) => { lastSavedAtRef.current = ts ?? null }
  const beginSession = () => { sessionRef.current += 1; lastSavedAtRef.current = null; try { onSessionBegin?.() } catch { } }
  const saveChainRef = useRef(Promise.resolve())

  const doSaveProject = async (projAtStart, sessAtStart, snapNodes, snapEdges, opts = {}) => {
    const silent = !!opts.silent // S19-2：自动保存静默——成功不弹 toast，失败静默累计
    const name = projAtStart || `项目 ${stamp()}`
    let r
    try { r = await window.flow.projectSave({ name, baseSavedAt: lastSavedAtRef.current, sessionId: taskSessionId, data: { nodes: snapNodes, edges: snapEdges, ...extraData() } }) }
    catch (err) {
      if (!silent) showToast('保存失败：' + (err?.message || '未知错误'))
      else noteAutoFail()
      return false
    }
    if (!r.ok) {
      if (silent) { noteAutoFail(); return false }
      if (r.conflict) showToast(r.error || '项目文件已被其他窗口更新，保存被拒绝')
      else showToast('保存失败：' + (r.error || '未知错误'))
      return false
    }
    autoFailRef.current = 0
    lastSavedAtRef.current = r.savedAt ?? null
    /* 未命名暂存目录并入项目目录后，内存里的引用要跟着换前缀（画布不闪断）；
       基线快照也必须用重映射后的节点计算，否则 dirty 会被误判成「又有改动」 */
    let nodesForSnap = snapNodes
    if (r.assetRemap?.from && r.assetRemap?.to) {
      const { from, to } = r.assetRemap
      nodesForSnap = remapNodes(snapNodes, from, to)
      if (nodesForSnap !== snapNodes) setNodes((ns) => remapNodes(ns, from, to))
    }
    const savedSnap = graphSnap(nodesForSnap, snapEdges)
    if (projectNameRef.current !== projAtStart || sessionRef.current !== sessAtStart) {
      // 保存期间用户已切换/新建/打开其他项目：磁盘已按请求写入，但不触碰当前会话状态
      if (!silent) showToast(`已保存「${r.name}」（保存期间已切换项目）`)
      return true
    }
    setProjectName(r.name)
    /* B-5：未命名期间的委托执行任务随命名并入项目——首页任务卡显示项目名、可直达 */
    try { taskApi?.rebindSession?.('proj:' + r.name, r.name)?.catch?.(() => {}) } catch { }
    savedSnapRef.current = savedSnap
    everSavedRef.current = true // 补充项：本会话已有成功落盘
    setDirty(graphSnap(nodesRef.current, edgesRef.current) !== savedSnap)
    if (!silent) showToast('已保存：' + r.file)
    /* S19-2：命名保存成功后草稿即清（未命名期间的 drafts 不再需要） */
    try { window.flow?.draftClear?.()?.catch?.(() => {}) } catch { /* 草稿清理失败不影响保存 */ }
    return true
  }

  const saveProject = () => {
    const projAtStart = projectNameRef.current
    const sessAtStart = sessionRef.current
    const snapNodes = nodesRef.current
    const snapEdges = edgesRef.current
    const run = saveChainRef.current.then(() => doSaveProject(projAtStart, sessAtStart, snapNodes, snapEdges))
    saveChainRef.current = run.then(() => {}, () => {})
    return run
  }

  /* ---------- S19-2：自动保存（ARCH-003）----------
     已命名项目：内容变化后 debounce 3s → 静默 project:save（走既有锁与原子写、串行队列）；
     未命名项目：内容变化后 debounce 5s → draft:save（userData/drafts/，与 projects 隔离）。
     硬约束：零 toast（连续失败 ≥3 次才弱提示一次）、不打断「未命名→首次保存命名」流程、
     手动 Ctrl+S 行为完全不变。空画布不触发。 */
  const autoFailRef = useRef(0)
  const noteAutoFail = () => {
    autoFailRef.current += 1
    if (autoFailRef.current === 3) { showToast('自动保存连续失败，请注意手动保存'); autoFailRef.current = 0 }
  }
  const autoTimerRef = useRef(null)
  const autoSaveNow = () => {
    const projAtStart = projectNameRef.current
    const sessAtStart = sessionRef.current
    const snapNodes = nodesRef.current
    const snapEdges = edgesRef.current
    const run = saveChainRef.current.then(() => doSaveProject(projAtStart, sessAtStart, snapNodes, snapEdges, { silent: true }))
    saveChainRef.current = run.then(() => {}, () => {})
  }
  const autoDraftNow = () => {
    const n = nodesRef.current; const e = edgesRef.current
    if (!n.length && !e.length) return
    const log = typeof getAgentLog === 'function' ? getAgentLog() : null
    try {
      const p = window.flow?.draftSave?.({ nodes: n, edges: e, ...(Array.isArray(log) && log.length ? { agentLog: log } : {}) })
      p?.then((r) => { if (r && r.ok === false) noteAutoFail() })?.catch?.(() => noteAutoFail())
    } catch { /* 主进程不可用时静默 */ }
  }
  useEffect(() => {
    const snap = graphSnap(nodes, edges)
    if (snap === savedSnapRef.current) return // 无内容变化（含保存后基线对齐）
    if (!(nodes || []).length && !(edges || []).length) return // 空画布
    const named = !!projectNameRef.current
    clearTimeout(autoTimerRef.current)
    autoTimerRef.current = setTimeout(named ? autoSaveNow : autoDraftNow, named ? 3000 : 5000)
    return () => clearTimeout(autoTimerRef.current)
  }, [nodes, edges])

  const loadProject = async (name, force = false) => {
    if (!force && dirty && !(await askConfirm({
      title: `打开「${name}」？`,
      text: `当前画布有 ${nodesRef.current.length} 个节点、${edgesRef.current.length} 条连线尚未保存，打开其他项目会替换它们。`,
      okText: '替换并打开', danger: true
    }))) return false
    const r = await window.flow.projectLoad({ name })
    if (!r.ok) { showToast('打开失败：' + (r.error || '未知错误')); return false }
    beginSession() // 定向复审 P0-2：新会话开始，旧会话未完成的保存回调不得再触碰本会话状态
    noteSavedAt(r.savedAt) // 定向复审 P1-1：记录载入版本，作为后续保存的乐观检查基线
    setPersisted(true)
    // ARCH-001：旧项目迁移/失效源提示（不阻塞打开）
    if (r.migrated) showToast('已将产物与素材迁移到本地资产')
    if (r.lostCount > 0) showToast(`${r.lostCount} 个节点的产物源已失效（链接过期），已标记，建议重新生成`)
    bumpIdSeq(r.data.nodes)
    snapReset.current = true
    const nextNodes = r.data.nodes || []
    /* D-6：载入时统一修正旧数据（非法连线清理、老边补显示字段、提示词连线回填）。
       以前这些规则分散在各修复点、只作用于新数据，旧项目就漏掉了。修正静默进行，不打扰用户。 */
    const norm = normalizeLoadedGraph(nextNodes, r.data.edges || [])
    setNodes(norm.nodes)
    setEdges(norm.edges)
    historyRef.current.reset(norm.nodes, norm.edges) // 打开项目 = 新的历史基线
    setSelectedId(null)
    setProjectName(name)
    setDirty(false)
    setProjectsOpen(false)
    setView('studio')
    setTimeout(() => rfw.fitView({ duration: 250, padding: 0.18, maxZoom: 1 }), 120)
    showToast('已打开：' + name)
    noteAgentLog(r.data) // S17-3：把项目里带的沟通记录还原到画布 Isle 面板
    // REF-001：把上次没跑完的生成任务续上（有 taskId 的生成中节点）
    resumePendingNodes(nextNodes)
    return true
  }

  /* force：自动化/控制脚本用（isle-control.cjs）。UI 永不传 force，
     保留「未保存先确认」的原有行为；脚本侧明确知道自己在丢弃什么。 */
  const newProject = async (force = false) => {
    if (!force && dirty && !(await askConfirm({
      title: '新建项目？',
      text: `当前画布有 ${nodesRef.current.length} 个节点、${edgesRef.current.length} 条连线尚未保存，新建会丢弃这些更改。`,
      okText: '丢弃并新建', danger: true
    }))) return
    beginSession() // 定向复审 P0-2
    setPersisted(false) // 补充项：新建画布从未落盘
    snapReset.current = true
    setNodes([])
    setEdges([])
    historyRef.current.reset([], [])
    setSelectedId(null)
    setProjectName(null)
    setDirty(false)
    setProjectsOpen(false)
    noteAgentLog(null) // 新画布：不继承上一个项目的沟通记录
  }

  /* 主页「新建项目」：确认后进入画布 */
  const newFromHome = () => { newProject(); setView('studio') }

  /* 主页快速生成：用输入的场景创建图片节点并直接进入画布 */
  const quickCreate = async (prompt) => {
    if (dirty && !(await askConfirm({
      title: '开始新的生成？',
      text: '当前画布有未保存的更改，继续会丢弃它们（节点与连线）。',
      okText: '丢弃并开始', danger: true
    }))) return
    const s = await window.flow.getSettings()
    const n = mkImage({ x: 160, y: 120 })
    n.id = nextId()
    n.data.prompt = prompt
    const list = s.models?.image || []
    if (list.length) n.data.model = list[0].model
    beginSession() // 定向复审 P0-2
    setPersisted(false) // 补充项：快速生成的画布从未落盘
    snapReset.current = true
    setNodes([n])
    setEdges([])
    setSelectedId(n.id)
    setProjectName(null)
    setDirty(false)
    setView('studio')
    noteAgentLog(null)
  }

  /* 主页重命名/删除后同步当前打开的项目名 */
  const onHomeRenamed = (oldName, newName) => setProjectName((cur) => (cur === oldName ? newName : cur))
  const onHomeDeleted = (name) => setProjectName((cur) => (cur === name ? null : cur))

  /* 返回主页：有未保存更改时先弹确认（取消 / 不保存 / 保存并返回） */
  const [leavePrompt, setLeavePrompt] = useState(false)
  const leaveNow = () => {
    setProjectsOpen(false)
    setSelectedId(null)
    setLeavePrompt(false)
    setView('home')
  }
  const goHome = () => {
    if (unsavedWork() && nodesRef.current.length) { setLeavePrompt(true); return }
    leaveNow()
  }
  /* 定向复审 P0-1：保存+复检的共享实现（saveAndLeave 与应用关闭确认共用一套逻辑）。
     保存成功 ≠ 可以离开/退出：保存期间画布若又有新改动（后台任务落产物、继续编辑），
     直接离开会把新改动静默判为已保存。返回：
     'clean' 画布与落盘基线一致，可安全离开；'dirty' 保存期间又有新改动；'failed' 保存失败 */
  const saveAndVerify = async () => {
    const ok = await saveProject()
    if (!ok) return 'failed'
    if (graphSnap(nodesRef.current, edgesRef.current) !== savedSnapRef.current) return 'dirty'
    return 'clean'
  }
  const saveAndLeave = async () => {
    const v = await saveAndVerify()
    if (v === 'failed') return
    if (v === 'dirty') {
      showToast('保存期间画布又有新的改动，请再次保存或选择不保存')
      setLeavePrompt(true)
      return
    }
    leaveNow()
  }

  const toggleProjects = async () => {
    const opening = !projectsOpen
    setProjectsOpen(opening)
    if (opening) setProjects(await window.flow.projectList())
  }


  return {
    projectName, setProjectName, dirty, setDirty, projectsOpen, projects, leavePrompt,
    saveProject, loadProject, newProject, newFromHome, quickCreate,
    onHomeRenamed, onHomeDeleted, leaveNow, goHome, saveAndLeave, saveAndVerify, toggleProjects,
    beginSession, noteSavedAt, setPersisted, unsavedWork, snapReset
  }
}

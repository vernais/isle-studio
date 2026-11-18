import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlowProvider,
  useNodesState, useEdgesState, addEdge, useReactFlow
} from '@xyflow/react'
import { makeImageNode, makeVideoNode, makeAudioNode, makeComposeNode, makeTextNode, uploadedWidth, setNodeActions, setNodeUpdater, cardWidthFor, closeNodeMenus, hasOpenNodeMenu } from './nodes.jsx'
import { IcFit, IcPencil, IcExternal, IcTrash, IcLock, IcAlert, IcPlay, IcCopy, IcUnlock, IcDownload, IcRefresh } from './icons.jsx'
import { runFlow, resumeTask, refetchResult, pendingTasks, resumePending, GEN_TIMEOUT_MS } from './engine.js'
import { setAssetContext } from './api.js'
import { modelPricingKnown } from './costEstimate.js'
import CompareView from './CompareView.jsx'
import { createHistory, mergeRuntime } from './history.js'
import ParamsPanel from './ParamsPanel.jsx'
import AgentPanel from './AgentPanel.jsx'
import SettingsModal from './SettingsModal.jsx'
import DialogHost from './Dialogs.jsx'
import AddMenu from './components/AddMenu.jsx'
import ConnectMenu from './components/ConnectMenu.jsx'
import ShortcutsModal from './components/ShortcutsModal.jsx'
import RunHud from './components/RunHud.jsx'
import NodeContextMenu from './components/NodeContextMenu.jsx'
import HomeScreen from './components/HomeScreen.jsx'
import TopBar from './components/TopBar.jsx'
import Toolbar from './components/Toolbar.jsx'
import StudioCanvas from './components/StudioCanvas.jsx'
import { GEN_FALLBACK } from './lib/constants.js'
import { SHORTCUT_GROUPS } from './lib/shortcuts.js'
import { itemsForHandle, upstreamImagesFor, refsFor, iconFor, calcSnap, normalizeLoadedGraph } from './lib/flowGraph.js'
import { nextId, bumpIdSeq } from './lib/ids.js'
import { useProjectIO } from './hooks/useProjectIO.js'
import useHomeIsle from './hooks/useHomeIsle.js'
import { useAgentBridge } from './hooks/useAgentBridge.js'
import { useRunFlow } from './hooks/useRunFlow.js'
import { useHotkeys } from './hooks/useHotkeys.js'
import { useNodeOps } from './hooks/useNodeOps.js'
import { useCanvasInsert } from './hooks/useCanvasInsert.js'
import { TaskProvider, useTaskApi, taskSessionId } from './store/taskStore.jsx'
import TemplateModal from './components/TemplateModal.jsx'
import { templateFrom, instantiateTemplate } from './lib/templates.js'
import { buildPlanGraph } from './lib/planner.js'
import { layoutByDepth, collectOutputs, extOf } from './lib/canvasOps.js'




export default function App() {
  return (
    <ReactFlowProvider>
      {/* S17-0b：任务 store 必须在 Studio 之上——画布写入、首页只读消费同一份数据 */}
      <TaskProvider>
        <Studio />
      </TaskProvider>
    </ReactFlowProvider>
  )
}











function Studio() {
  const [view, setView] = useState('home') // home=主页 studio=画布（启动先显示主页）
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedId, setSelectedId] = useState(null)
  const [running, setRunning] = useState(false)
  const [spent, setSpent] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  /* S16-2：运行时引导落点——null 表示手动打开（保留上次 Tab 记忆），'api' 表示引导到接口页 */
  const [settingsTab, setSettingsTab] = useState(null)
  const [templatesOpen, setTemplatesOpen] = useState(false) // REQ-002 模板库浮层
  const [agentOpen, setAgentOpen] = useState(false)
  /* 版本号从主进程取（跟随安装包），不再硬编码——打包升级后界面自动跟上 */
  const [verLabel, setVerLabel] = useState('')
  const [refPickFor, setRefPickFor] = useState(null) // REF-004：参考选择模式（目标节点 id）
  const [previewUrl, setPreviewUrl] = useState(null)
  const [compareOpen, setCompareOpen] = useState(false) // REQ-007 图片对比查看器
  /* IR-013：对比视角（模式/缩放/分割位置）提升到 App 层，按 items 签名记忆——
     同一组节点关闭重开恢复上次视角；换成另一组节点则重置为默认。 */
  const [cmpView, setCmpView] = useState(null)

  /* 对比候选：选中 2–4 个含图片产物的图片节点（视频/空节点不参与） */
  const compareItems = (() => {
    const picked = nodes
      .filter((n) => n.selected && n.type === 'image' && (n.data?.urls || []).length)
      .slice(0, 4)
    return picked.map((n) => {
      const d = n.data || {}
      const parts = []
      if (d.model) parts.push(d.model)
      if (d.resolution) parts.push(String(d.resolution).toLowerCase())
      if (d.size && d.size !== 'Auto') parts.push(d.size)
      if (d.n > 1) parts.push('×' + d.n)
      return { id: n.id, url: d.urls[0], label: d.label || '图片生成', model: d.model || '', params: parts.join(' · ') }
    })
  })()
  const [minimapOpen, setMinimapOpen] = useState(false)
  const [mode, setMode] = useState('select') // select=框选 hand=移动画布
  const [menuAt, setMenuAt] = useState(null) // null | 'toolbar' | {x,y}（画布右键跟随鼠标）
  const [nodeMenu, setNodeMenu] = useState(null) // 节点右键菜单 {x,y,id,count}（UI-020）
  const [connFrom, setConnFrom] = useState(null) // 正在拖的连线起点 {kind,handleType}（UI-019 挂点高亮）
  const [connTip, setConnTip] = useState(null) // 非法连线原因提示 {x,y,text}
  const connTipTimer = useRef(null)
  const [dragOver, setDragOver] = useState(false) // 拖文件悬停在画布上时高亮提示
  const [helpOpen, setHelpOpen] = useState(false) // 快捷键说明（UI-007 B-3）
  const [spacePan, setSpacePan] = useState(false) // 空格按住 = 临时平移（UI-007）
  const [runIds, setRunIds] = useState(null) // 本次运行的节点集合（进度分母）
  const [runSummary, setRunSummary] = useState(null) // 运行结束汇总（UI-010）
  const [runEstimate, setRunEstimate] = useState(null) // REQ-001：本次运行预估积分（HUD 起始态 + 完成汇总对照）
  const [runMenu, setRunMenu] = useState(false) // 运行方式二级菜单
  const [runMenuAt, setRunMenuAt] = useState(null) // S12：portal 化后菜单的 fixed 定位（相对视口）
  const runMoreRef = useRef(null)
  /* S12 / IR-008：run-menu 与遮罩 createPortal 挂 body。
     .toolbar 的 transform:translateX(-50%) 会创建 containing block，劫持内部 position:fixed
     的遮罩（inset:0 只盖住工具条），导致点画布空白/Esc 都关不掉——portal 是拔根修复，不再打补丁 */
  const toggleRunMenu = () => {
    if (!runMenu) {
      const r = runMoreRef.current?.getBoundingClientRect()
      if (r) setRunMenuAt({
        right: Math.max(10, Math.round(window.innerWidth - r.right)),
        bottom: Math.round(window.innerHeight - r.top) + 10, // 按钮顶边上方 10px，与原 bottom:calc(100%+10px) 一致
      })
    }
    setRunMenu((v) => !v)
  }
  const runningRef = useRef(false)

  /* REF-006：生成偏好活在 ref 里，新建节点时同步取用（不触发额外渲染）
     Q1-2 REF-008：同时解析每分类默认模型——默认值为空或已被删 → 回落该分类首个可用模型 */
  const genPrefsRef = useRef(GEN_FALLBACK)
  const loadGenPrefs = useCallback(() => window.flow.getSettings().then((s) => {
    const g = s?.generation || {}
    const dm = s?.defaultModels || {}
    const enabled = (c) => (s?.models?.[c] || []).map((m) => m.model)
    const defOf = (c) => {
      const list = enabled(c)
      if (dm[c] && list.includes(dm[c])) return dm[c]
      // 回落：优先计费已知（未定价模型大概率网关未配置，实测会 500），
      // 全部未知才落首个（保持旧行为兜底）
      const kind = c === 'video' ? 'video' : 'image'
      const known = list.find((m) => modelPricingKnown(m, kind))
      return (known || list[0] || '')
    }
    genPrefsRef.current = {
      image: { ...GEN_FALLBACK.image, ...(g.image || {}) },
      video: { ...GEN_FALLBACK.video, ...(g.video || {}) },
      regenerate: g.regenerate === 'inplace' ? 'inplace' : 'new',
      model: defOf('image'),       // 图片分类默认模型（可能为 ''：该分类未启用任何模型）
      videoModel: defOf('video')
    }
    return genPrefsRef.current
  }), [])
  const mkImage = useCallback((pos) => makeImageNode(pos, { ...genPrefsRef.current.image, model: genPrefsRef.current.model }), [])
  const mkVideo = useCallback((pos) => makeVideoNode(pos, { ...genPrefsRef.current.video, model: genPrefsRef.current.videoModel }), [])
  /* P2：配音节点不读生成偏好（音色/语速是它自己的参数），保持固定默认值 */
  const mkAudio = useCallback((pos) => makeAudioNode(pos), [])
  /* P3：成片合成不读模型偏好，参数（画幅/字幕/混音）由面板单独控制 */
  const mkCompose = useCallback((pos) => makeComposeNode(pos), [])

  /* ---------- 应用内对话框（UI-021）：替代浏览器原生 prompt / confirm ----------
     调用方 await 拿结果：确认类 → true/false；输入类 → 字符串 / null（取消） */
  const [dialog, setDialog] = useState(null)
  const dialogRef = useRef(null)
  const ask = (cfg) => new Promise((resolve) => {
    const d = { ...cfg, resolve }
    dialogRef.current = d
    setDialog(d)
  })
  const finishDialog = (result) => {
    const d = dialogRef.current
    dialogRef.current = null
    setDialog(null)
    if (d) d.resolve(result)
  }
  const askConfirm = (cfg) => ask({ kind: 'confirm', ...cfg })
  const askInput = (cfg) => ask({ kind: 'input', ...cfg })
  /* 单主题（UI-031）：应用只保留浅色，主题切换能力已移除。
     连线色固定为浅色基准值（原 edgeColor 三元随主题切换，现恒为浅色值） */
  const EDGE_COLOR = '#c3cad6'
  const [connectMenu, setConnectMenu] = useState(null) // {x,y,nodeId,handleId,handleType,nodeType}
  const [snapLines, setSnapLines] = useState([])
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges
  const rfw = useReactFlow()
  const { screenToFlowPosition } = rfw

  /* ---------- 撤销 / 重做（UI-007 B-2）：只记录图结构快照，50 步上限 ---------- */
  const historyRef = useRef(null)
  if (!historyRef.current) historyRef.current = createHistory()
  const histTimer = useRef(null)
  // 图状态稳定 320ms 后压栈：拖动/连续输入只留一条历史，不会把栈塞满
  useEffect(() => {
    clearTimeout(histTimer.current)
    histTimer.current = setTimeout(() => { historyRef.current.commit(nodes, edges) }, 320)
    return () => clearTimeout(histTimer.current)
  }, [nodes, edges])

  useEffect(() => {
    window.flow?.appVersion?.().then((v) => setVerLabel(v ? 'v' + v : '')).catch(() => {})
  }, [])

  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)
  const showToast = (msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 3200)
  }

  /* ARCH-004：续查函数定义在 hook 之后，用 ref 延迟绑定 */
  const resumePendingRef = useRef(null)

  /* ---------- 项目持久化：由 useProjectIO 承载（ARCH-004 拆分） ---------- */
  /* S17-3：首页沟通记录随项目带入画布（落盘在项目数据的 agentLog 字段）。
     保存时读 agentLogRef（避免闭包旧值），打开/新建项目时同步回 state。 */
  const agentLogRef = useRef([])
  const [agentLog, setAgentLog] = useState([])
  const onAgentLog = (log) => {
    agentLogRef.current = Array.isArray(log) ? log : []
    setAgentLog(agentLogRef.current)
  }
  const {
    projectName, setProjectName, dirty, setDirty, projectsOpen, projects, leavePrompt,
    saveProject, loadProject, newProject, newFromHome, quickCreate,
    onHomeRenamed, onHomeDeleted, leaveNow, goHome, saveAndLeave, saveAndVerify, toggleProjects,
    beginSession, noteSavedAt, setPersisted, unsavedWork, snapReset
  } = useProjectIO({
    nodes, edges, nodesRef, edgesRef, setNodes, setEdges, setSelectedId, setView,
    historyRef, askConfirm, showToast,
    resumePendingRef, mkImage, rfw,
    getAgentLog: () => agentLogRef.current,
    onAgentLog,
    onSessionBegin: () => setSpent(0) /* B-9：新建/打开项目时顶栏「本次已用」归零 */
  })

  /* ---------- 1.2.0：自动化控制桥 ----------
     scripts/isle-control.cjs 与 verify-control.cjs 通过 CDP 调这一层完成
     「读状态 / 新建项目 / 建节点 / 改参数 / 连线 / 保存 / 重开 / 截图」。
     只暴露项目级动作与只读状态，节点级动作仍走 window.__flowAgent（同一套业务实现）。
     注意：这里不复制任何业务逻辑，force=true 只用于脚本侧跳过多余的确认弹窗。 */
  useEffect(() => {
    window.__isle = {
      state: () => ({
        view,
        projectName,
        dirty,
        nodes: nodesRef.current.length,
        edges: edgesRef.current.length,
        running: !!runningRef.current
      }),
      newProject: () => newProject(true),
      openProject: (name) => loadProject(name, true),
      saveProject: () => saveProject(),
      listProjects: () => window.flow.projectList()
    }
  })

  /* ---------- D-4 画布内改名：顶栏项目名点击即改，不必回首页 ----------
     已保存项目走 project:rename（主进程同步改名文件+资产目录+meta，含同名冲突检查）；
     未命名画布只本地命名，保存时按新名落盘（沿用 doSaveProject 的 projAtStart 逻辑）。 */
  const renameCurrentProject = async (newName) => {
    const old = projectName
    const nn = String(newName || '').trim().slice(0, 80)
    if (!nn) return false
    if (!old) {
      setProjectName(nn)
      setDirty(true)
      showToast('已命名为「' + nn + '」，保存项目后生效')
      return true
    }
    if (nn === old) return false
    try {
      const r = await window.flow.projectRename({ name: old, newName: nn })
      if (r?.ok) {
        onHomeRenamed(old, r.name)
        showToast('已重命名为「' + r.name + '」')
        return true
      }
      showToast('重命名失败：' + (r?.error || '未知错误'))
      return false
    } catch (err) {
      showToast('重命名失败：' + (err?.message || err))
      return false
    }
  }

  /* ---------- S18 修复：生成产物即时入库上下文 ----------
     生成链在 engine 深处，不知道当前项目；把「项目名 + 会话」推给 api 层，
     产物一生成就写进 assets/<项目>（未命名进会话暂存目录，保存时自动并项）。 */
  useEffect(() => {
    setAssetContext({ projectName: projectName || '', sessionId: taskSessionId })
  }, [projectName])

  /* ---------- S19-3 崩溃恢复：主进程询问「恢复草稿」后渲染端领取并载入画布 ----------
     载入后不刷新基线快照 → 内容与空基线的 diff 让 dirty 自动为 true（由用户决定是否保存）；
     恢复完成即清空 drafts。多窗口场景第二个窗口 draftPending 领到 null，不重复恢复。 */
  useEffect(() => {
    window.flow?.draftPending?.().then(async (r) => {
      if (r?.action !== 'restore') return
      const d = await window.flow.draftLoad().catch(() => null)
      const dn = d?.data?.nodes
      if (!d?.ok || !Array.isArray(dn) || !dn.length) { window.flow?.draftClear?.(); return }
      beginSession()
      setPersisted(false)
      bumpIdSeq(dn)
      /* D-6：崩溃恢复的旧草稿也走载入时数据修正 */
      const dNorm = normalizeLoadedGraph(dn, d.data.edges || [])
      setNodes(dNorm.nodes)
      setEdges(dNorm.edges)
      historyRef.current.reset(dNorm.nodes, dNorm.edges)
      setSelectedId(null)
      setDirty(true)
      setView('studio')
      onAgentLog(d.data?.agentLog || null)
      setTimeout(() => rfw.fitView({ duration: 250, padding: 0.18, maxZoom: 1 }), 120)
      try { window.flow?.draftClear?.()?.catch?.(() => {}) } catch { /* 清理失败不影响恢复 */ }
      resumePendingRef.current?.(dNorm.nodes)
    }).catch(() => {})
  }, [])

  /* ---------- S17-0b：任务归属（哪个项目、哪个窗口）----------
     画布运行写任务记录时带上它：首页据此显示项目名并支持「进入画布」。
     未命名画布用窗口会话 id 兜底——不能拿 null 当 key，否则两个未命名画布会串。 */
  const taskApi = useTaskApi()
  // 调试/自测钩子：只读观察任务 store（与 __flowHistory 同性质，不参与业务逻辑）
  useEffect(() => { window.__taskStore = taskApi }, [taskApi])
  const taskCtxRef = useRef({ projectKey: '', projectName: '', sessionId: taskSessionId })
  /* S17-3：运行入口的 ref——createFromPlan 定义在 useRunFlow 之前，委托执行要带着积分上限调它 */
  const runRef = useRef(null)
  taskCtxRef.current = {
    projectKey: projectName ? 'proj:' + projectName : 'session:' + taskSessionId,
    projectName: projectName || '未命名画布',
    sessionId: taskSessionId
  }
  /* B-7：Isle 会话 key——命名项目按项目名；未命名画布按窗口会话（不再共用 global） */
  const isleSessionKey = projectName ? 'proj:' + projectName : 'draft:' + taskSessionId

  /* ---------- 阶段0修复④：应用关闭未保存确认 ----------
     主进程拦截一切 close（点 X / Alt+F4 / window:close）→ 渲染端询问；
     无未保存内容直接放行；有则三选：保存并退出 / 不保存退出 / 取消。
     handler 每次渲染重建（捕获最新 dirty/saveProject），监听只挂一次。
     定向复审 P0-1：「保存并退出」改走与 saveAndLeave 同一套 saveAndVerify 复检——
     保存期间画布又有新改动（后台任务落产物等）时不放行关闭，保留窗口提示用户 */
  const closeAskRef = useRef(null)
  /* S17-0b：放行关闭前，把本窗口「执行中」的任务如实落为已中止并落盘。
     不允许出现「关掉应用后首页仍显示执行中」或「假装完成」的记录 */
  const confirmCloseNow = async () => {
    await taskApi.abortMine()
    window.flow.confirmClose()
  }
  closeAskRef.current = async () => {
    /* 补充项：unsavedWork 覆盖「从未落盘但非空」的画布（快速生成/模板载入，dirty=false 也会丢内容） */
    if (!unsavedWork()) { confirmCloseNow(); return }
    const r = await askConfirm({
      title: '退出 Isle Studio？',
      text: `当前画布有未保存的更改（${nodesRef.current.length} 个节点、${edgesRef.current.length} 条连线）。`,
      okText: '保存并退出', extraText: '不保存退出'
    })
    if (r === 'extra') { confirmCloseNow(); return }
    if (r === true) {
      const v = await saveAndVerify()
      if (v === 'clean') { confirmCloseNow(); return }
      if (v === 'dirty') showToast('保存期间画布又有新的改动，已保留窗口，请再次保存或选择不保存退出')
      // v === 'failed'：保存失败提示已由 saveProject 弹出，窗口保留
    }
  }
  useEffect(() => {
    if (typeof window.flow?.onCloseRequest !== 'function') return
    window.flow.onCloseRequest(() => closeAskRef.current?.())
  }, [])

  /* ---------- 整理画布：按依赖拓扑分层排列 ---------- */
  /* ---------- 整理画布 / 下载全部：布局与产物收集逻辑在 lib/canvasOps.js ---------- */
  const organizeCanvas = () => {
    if (!nodes.length) return
    setNodes(layoutByDepth(nodes, edges))
    setTimeout(() => rfw.fitView({ duration: 300, padding: 0.15, maxZoom: 1 }), 60)
  }

  const downloadAll = async () => {
    const items = collectOutputs(nodes)
    if (!items.length) return showToast('画布上还没有可下载的产物')
    let ok = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      try {
        await window.flow.download({
          url: it.url,
          subdir: it.kind === 'video' ? 'videos' : it.kind === 'audio' ? 'audio' : 'images',
          filename: `flowstudio_${Date.now()}_${i + 1}.${extOf(it.url, it.kind)}`
        })
        ok++
      } catch { /* 单个失败不中断 */ }
    }
    showToast(`已下载 ${ok}/${items.length} 个文件到输出目录`)
  }

  /* ---------- REQ-002 模板：保存当前画布 / 载入模板 ----------
     保存时剥离产物与运行态（lib/templates.js）；载入后节点统一「待生成」并重新编号。 */
  const saveCurrentAsTemplate = async (name) => {
    const data = templateFrom(nodesRef.current, edgesRef.current, rfw.getViewport?.())
    const r = await window.flow.templateCreate({ name, data })
    if (r?.exists) {
      const ok = await askConfirm({
        title: `覆盖模板「${name}」？`,
        text: '已存在同名模板，覆盖后旧模板内容将丢失（当前画布与项目不受影响）。',
        okText: '覆盖', danger: true
      })
      if (!ok) return { ok: false, error: '已取消' }
      return window.flow.templateCreate({ name, data, overwrite: true })
    }
    return r
  }

  /* S17-1：模板载入是否成功要回传给首页 chips（命中模板时据此决定是否切换视图） */
  const loadTemplate = async (name) => {
    if (dirty && !(await askConfirm({
      title: `载入模板「${name}」？`,
      text: `当前画布有 ${nodesRef.current.length} 个节点、${edgesRef.current.length} 条连线尚未保存，载入模板会替换它们。`,
      okText: '替换并载入', danger: true
    }))) return false
    const r = await window.flow.templateLoad({ name })
    if (!r.ok) { showToast('载入模板失败：' + (r.error || '未知错误')); return false }
    const inst = instantiateTemplate(r.data, nextId)
    /* D-6：老模板也走载入时的数据修正（旧模板可能带非法连线/空提示词/老边字段） */
    const tplNorm = normalizeLoadedGraph(inst.nodes, inst.edges)
    const nn = tplNorm.nodes
    const ne = tplNorm.edges
    beginSession() // 定向复审 P0-2：模板载入 = 新会话
    setPersisted(false) // 补充项：模板画布从未落盘
    snapReset.current = true
    setNodes(nn)
    setEdges(ne)
    historyRef.current.reset(nn, ne)
    setSelectedId(null)
    setProjectName(null) // 模板载入 = 未保存的新画布
    setDirty(false)
    setTemplatesOpen(false)
    setTimeout(() => rfw.fitView({ duration: 250, padding: 0.18, maxZoom: 1 }), 120)
    showToast(`已载入模板「${r.name}」：${nn.length} 个节点（待生成）`)
    return true
  }

  /* S17-1：首页 chips 命中模板 → 载入并直接进画布；返回 false 表示用户取消/载入失败，视图不动 */
  const useTemplateFromHome = async (name) => {
    const ok = await loadTemplate(name)
    if (ok) setView('studio')
    return ok
  }

  /* S17-3：首页沟通记录 → 项目内可回看的会话（只留用户与 Isle 说的话，步骤噪声不进日志） */
  const sessionLogOf = (msgs) => (msgs || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 800) }))
    .filter((m) => m.content)

  /* 委托执行的自动项目名：用计划标题，撞名加序号；非法字符先剔除 */
  const uniqueProjectName = async (base) => {
    const clean = String(base || '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32) || 'Isle 委托任务'
    let names = []
    try { names = (await window.flow.projectList()).map((p) => p.name) } catch { names = [] }
    if (!names.includes(clean)) return clean
    for (let i = 2; i < 60; i++) {
      const cand = `${clean} ${i}`
      if (!names.includes(cand)) return cand
    }
    return `${clean} ${Date.now().toString(36).slice(-4)}`
  }

  /* S17-2/S17-3：首页计划 → 画布。两个出口共用这一份落地逻辑：
     build=只搭结构不运行；delegate=自动建项目并落盘，然后带着积分上限委托执行
     （触顶自动暂停问继续/终止；进入画布接管则停止派发剩余步骤） */
  const createFromPlan = async (plan, { autoRun = false, budget = 0 } = {}) => {
    const s = await window.flow.getSettings()
    const models = {
      image: (s.models?.image || []).map((m) => m.model),
      video: (s.models?.video || []).map((m) => m.model)
    }
    const { nodes: nn, edges: ne } = buildPlanGraph(plan, { models, defaults: s.defaultModels || {}, nextId })
    if (!nn.length) return { ok: false, error: '计划里没有可执行的步骤' }
    const log = sessionLogOf(isle.messages)
    beginSession() // 新会话：旧的保存回调不得再触碰本画布
    snapReset.current = true
    setNodes(nn)
    setEdges(ne)
    historyRef.current.reset(nn, ne)
    setSelectedId(null)
    setDirty(false)
    setTemplatesOpen(false)
    onAgentLog(log) // 会话随项目带入画布 Isle 面板
    setView('studio')

    /* 委托执行：先自动建项目并落盘（AI 命名可在项目栏/首页改），任务才有归属可回看 */
    let savedName = null
    if (autoRun) {
      savedName = await uniqueProjectName(plan?.title)
      try {
        const r = await window.flow.projectSave({
          name: savedName, baseSavedAt: null,
          data: { nodes: nn, edges: ne, ...(log.length ? { agentLog: log } : {}) }
        })
        if (r?.ok) {
          savedName = r.name
          setProjectName(r.name)
          noteSavedAt(r.savedAt)
          setPersisted(true)
        } else {
          savedName = null
          setProjectName(null)
          setPersisted(false)
          showToast('项目没能自动保存：' + (r?.error || '未知错误') + '（任务照常执行）')
        }
      } catch (err) {
        savedName = null
        setProjectName(null)
        setPersisted(false)
        showToast('项目没能自动保存：' + (err?.message || '未知错误') + '（任务照常执行）')
      }
      /* 项目名进 taskCtx 要等下一次渲染，这里先把名字塞给运行入口 */
      if (savedName) {
        taskCtxRef.current = { ...taskCtxRef.current, projectKey: 'proj:' + savedName, projectName: savedName }
      }
    } else {
      setProjectName(null) // 与快速生成一致：先不落盘，用户自己决定保存名
      setPersisted(false)
    }

    setTimeout(() => rfw.fitView({ duration: 260, padding: 0.18, maxZoom: 1 }), 140)

    if (autoRun) {
      showToast(savedName
        ? `已创建项目「${savedName}」并开始执行，进度可在首页任务卡跟进`
        : `已开始执行 ${nn.length} 个节点，进度可在首页任务卡跟进`)
      setTimeout(() => {
        Promise.resolve(runRef.current?.execute?.({
          continueOnError: true,
          delegated: true,
          budget: Math.max(0, Math.round(Number(budget) || 0))
        })).catch(() => {})
      }, 450)
    } else {
      showToast(`已按计划搭好 ${nn.length} 个节点（未自动运行）`)
    }
    return { ok: true, count: nn.length, projectName: savedName || '' }
  }

  /* B-5：去验收 = 导航 + 清卡。同一画布多次委托执行会产生多条「待验收」记录，一并收掉 */
  const acceptTask = (t) => {
    const key = t?.projectKey || ('session:' + taskSessionId)
    Promise.resolve(taskApi.removeDoneByKey?.(key))?.catch?.(() => {})
  }

  /* S17-3：进入画布接管——标记后 Isle 在下一个节点边界停止派发，已有产物保留 */
  const takeoverTask = async (t) => {
    const name = String(t.projectKey || '').replace(/^proj:/, '')
    taskApi.takeover(t.id)
    if (name && name !== projectName) {
      const ok = await loadProject(name)
      if (ok === false) return
    } else {
      setView('studio')
    }
    showToast('已接管：Isle 不再派发剩余步骤，接下来都听你的')
  }

  /* 失败 / 中止 / 按上限停止的任务：重试 = 打开该项目，只跑没完成的节点（skipDone） */
  const retryTask = async (t) => {
    const name = String(t.projectKey || '').replace(/^proj:/, '')
    if (name && name !== projectName) {
      const ok = await loadProject(name)
      if (ok === false) return
    } else {
      setView('studio')
    }
    showToast('正在重跑未完成的节点…')
    setTimeout(() => {
      Promise.resolve(runRef.current?.execute?.({ skipDone: true, continueOnError: true })).catch(() => {})
    }, 420)
  }

  /* S17-2：首页 Isle 会话状态挂在 App 层——收起沉浸态、进出画布都不丢 */
  const isle = useHomeIsle({ onCreateFromPlan: createFromPlan })

  useEffect(() => {
    loadGenPrefs() // REF-006：新建节点前必须有偏好值
    window.addEventListener('settings:saved', loadGenPrefs)
    window.flow.getSettings().then((s) => {
      const hasModels = ['image', 'video', 'chat'].some((k) => (s.models?.[k] || []).length)
      if (!hasModels) { setSettingsTab('api'); setShowSettings(true) } // S16-2：首次无模型引导落到接口页
      /* 单主题迁移兜底（UI-031 A-2）：无条件忽略历史配置里的 theme 字段。
         老配置可能是 "dark"，若不忽略会把应用拉回暗色且用户已无切换按钮可自救。
         同时把失效字段写回 'lovart'，避免配置里残留误导后续开发。 */
      if (s && s.theme && s.theme !== 'lovart') {
        window.flow.setSettings({ theme: 'lovart' }).catch(() => {})
      }
    })
    const qp = new URLSearchParams(window.location.search)
    // 演示模式（DEMO=1 启动）：自动创建并选中一个节点，便于 UI 自检
    if (qp.get('demo')) {
      const n = mkImage({ x: 120, y: 80 })
      n.id = nextId()
      n.data.model = 'gpt-image-2'
      n.data.prompt = ''
      setNodes([n])
      setSelectedId(n.id)
      setView('studio')
    }
    // 「在新窗口打开」：新窗口带 ?project= 参数，启动后直接载入该项目
    const qproj = qp.get('project')
    if (qproj) {
      window.flow.projectLoad({ name: qproj }).then((r) => {
        if (!r.ok) return showToast('打开失败：' + (r.error || '未知错误'))
        beginSession() // 定向复审 P0-2：新窗口直开项目 = 新会话
        noteSavedAt(r.savedAt) // 定向复审 P1-1：记录载入版本
        setPersisted(true) // 补充项：直开的项目已在磁盘上
        bumpIdSeq(r.data.nodes)
        snapReset.current = true
        /* D-6：新窗口直开历史项目同样走载入时数据修正 */
        const qNorm = normalizeLoadedGraph(r.data.nodes || [], r.data.edges || [])
        setNodes(qNorm.nodes)
        setEdges(qNorm.edges)
        setProjectName(qproj)
        setDirty(false)
        setView('studio')
        setTimeout(() => rfw.fitView({ duration: 250, padding: 0.18, maxZoom: 1 }), 160)
        resumePendingNodes(qNorm.nodes)
      })
    }
    return () => window.removeEventListener('settings:saved', loadGenPrefs)
  }, [])

  const update = useCallback((id, patch) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
    /* C-2 提示词镜像：文本节点内容变化时，同步仍镜像着旧文本（或为空）的下游提示词框；
       下游一旦被用户改写就停止镜像，避免覆盖手写内容 */
    if ('text' in patch) {
      const oldText = nodesRef.current.find((n) => n.id === id)?.data?.text || ''
      const targets = edgesRef.current
        .filter((e) => e.source === id && (e.targetHandle || '') === 'in-text')
        .map((e) => e.target)
      if (targets.length) {
        const nextText = (patch.text || '').trim() ? patch.text : ''
        setNodes((ns) => ns.map((n) => {
          if (!targets.includes(n.id) || n.type === 'text') return n
          const cur = n.data?.prompt || ''
          if (cur.trim() && cur !== oldText) return n
          return { ...n, data: { ...n.data, prompt: nextText } }
        }))
      }
    }
  }, [setNodes])

  /* REF-006「再生成行为=新建节点」：结果落一张新卡片，原节点保持原样。
     引擎在 patch.pendingPlace 里告知本次落位策略；返回 'placed' 表示上层已接管。 */
  const placeResult = useCallback((node, patch) => {
    if (patch?.pendingPlace !== 'new') return undefined
    const src = nodesRef.current.find((n) => n.id === node.id) || node
    const w = nodeWidthOf(src)
    const nn = {
      ...src,
      id: nextId(),
      position: { x: src.position.x + w + 48, y: src.position.y + 24 },
      selected: false,
      data: {
        ...src.data,
        ...patch,
        pendingPlace: '',
        label: (src.data.label || '图片生成') + ' 新版本',
        dupFlash: true
      }
    }
    setNodes((ns) => ns
      .map((x) => (x.id === src.id
        ? { ...x, data: { ...x.data, status: 'done', progress: 100, taskId: '', taskKind: '', submittedAt: 0, pendingPlace: '', error: '' } }
        : x))
      .concat(nn))
    setSelectedId(nn.id)
    // BUG-2 感知修复：新卡片可能落在视口外（画布大/缩放小时用户以为「原卡片消失了」），
    // 落位后把视口平移到新卡片，保证用户看得见结果去了哪
    setTimeout(() => {
      try {
        rfw.setCenter(nn.position.x + w / 2, nn.position.y + 180, { zoom: Math.max(0.6, rfw.getZoom()), duration: 300 })
      } catch { /* 视口操作失败不影响落位 */ }
    }, 80)
    setTimeout(() => {
      setNodes((ns) => ns.map((x) => (x.id === nn.id && x.data?.dupFlash ? { ...x, data: { ...x.data, dupFlash: false } } : x)))
    }, 1800)
    showToast('已生成新版本，原节点保持不变')
    return 'placed'
  }, [])

  /* REF-001：启动/打开项目后，对「生成中且有 taskId」的节点自动续查 */
  const resumePendingNodes = useCallback(async (list) => {
    const pend = pendingTasks(list || nodesRef.current)
    if (!pend.length) return []
    showToast(`检测到 ${pend.length} 个未完成的生成任务，正在续查…`)
    const out = await resumePending({
      nodes: pend, update, onSpend: (c) => setSpent((v) => v + c), onResult: placeResult
    })
    const ok = out.filter((r) => r.ok).length
    if (ok) showToast(`续查完成：${ok} 个任务已取回结果`)
    return out
  }, [update, placeResult])

  /* ARCH-004：hook 内通过 ref 调用续查（定义顺序解耦） */
  resumePendingRef.current = resumePendingNodes

  /* 拖动对齐吸附：贴近其他卡片边缘/中线时自动贴合并显示红色参考线 */
  const onNodeDrag = useCallback((_, node) => {
    const { dx, dy, lines } = calcSnap(node, nodesRef.current)
    if (dx || dy) {
      setNodes((ns) => ns.map((n) => (n.id === node.id
        ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
        : n)))
    }
    setSnapLines(lines)
  }, [setNodes])

  const onNodeDragStop = useCallback((_, node) => {
    // 松手时 RF 会按原始轨迹覆盖一次位置，这里再做最终吸附修正
    if (node) {
      const { dx, dy } = calcSnap(node, nodesRef.current)
      if (dx || dy) {
        setNodes((ns) => ns.map((n) => (n.id === node.id
          ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
          : n)))
      }
    }
    setSnapLines([])
  }, [setNodes])

  const onConnect = useCallback(
    (c) => {
      const nodes = nodesRef.current
      const byId = new Map(nodes.map((n) => [n.id, n.type]))
      setEdges((es) => addEdge({
        ...c, animated: true, type: 'flow',
        data: { sIcon: iconFor(byId.get(c.source)), tIcon: iconFor(byId.get(c.target)) },
        style: { stroke: EDGE_COLOR }
      }, es))
      /* C-2：提示词节点连入 in-text 时，把内容同步到下游提示词框——
         下游已有手写内容则不覆盖（引擎运行时两侧会拼接） */
      const src = nodes.find((n) => n.id === c.source)
      if (src?.type === 'text' && (c.targetHandle || '') === 'in-text') {
        const text = (src.data?.text || '').trim()
        if (text) {
          setNodes((ns) => ns.map((n) => (n.id === c.target && n.type !== 'text' && !(n.data?.prompt || '').trim()
            ? { ...n, data: { ...n.data, prompt: src.data.text } }
            : n)))
        }
      }
    },
    [setEdges, setNodes]
  )

  /* REF-004：参考选择模式——点画布节点即建参考连线（可连续点选，Esc 结束） */
  const addRefFromNode = (srcId) => {
    const target = refPickFor
    if (!target || !srcId) return
    if (srcId === target) { showToast('不能把节点设为自己的参考'); return }
    const src = nodesRef.current.find((n) => n.id === srcId)
    if (!src) return
    if (src.type === 'text' || !(src.data?.urls || []).length) {
      showToast('只有带产物图的节点能作为参考')
      return
    }
    const dup = edgesRef.current.some((e) => e.source === srcId && e.target === target
      && (e.targetHandle || '') === 'in-img')
    if (dup) { showToast('该节点已在参考里'); return }
    const count = edgesRef.current.filter((e) => e.target === target && (e.targetHandle || '') === 'in-img').length
    if (count >= 4) { showToast('参考图最多 4 张'); return }
    setEdges((es) => addEdge({
      source: srcId, sourceHandle: 'out', target, targetHandle: 'in-img',
      animated: true, type: 'flow',
      data: { sIcon: iconFor(src.type), tIcon: 'img' },
      style: { stroke: EDGE_COLOR }
    }, es))
    showToast('已加入参考：' + (src.data?.label || srcId))
  }

  /* 拖挂点松手但未连上：
     · 落在节点/挂点上 → 说明被规则拒绝，就地点出原因（UI-019）
     · 落在空白处 → 沿用旧行为，弹出「新建下游卡片」选项菜单 */
  const onConnectStart = useCallback((_, params) => {
    const n = nodesRef.current.find((x) => x.id === params?.nodeId)
    setConnFrom({
      nodeId: params?.nodeId,
      kind: n?.data?.kind || n?.type || 'image',
      handleType: params?.handleType
    })
  }, [])

  const onConnectEnd = useCallback((event, state) => {
    setConnFrom(null)
    if (state.isValid) return
    const fromNode = state.fromNode
    const fromHandle = state.fromHandle
    if (!fromNode || !fromHandle) return
    if (state.toNode) {
      const reason = state.toHandle
        ? (connRejectReason({
            source: fromNode.id,
            sourceHandle: fromHandle.id,
            target: state.toNode.id,
            targetHandle: state.toHandle.id
          }) || '这两个节点不能这样连')
        : '松手位置不在挂点上，请对准目标卡片左侧的圆点'
      showConnTip(event.clientX, event.clientY, reason)
      return
    }
    setConnectMenu({
      x: event.clientX, y: event.clientY,
      nodeId: fromNode.id, nodeType: fromNode.type,
      handleId: fromHandle.id, handleType: fromHandle.type
    })
  }, [])

  /* 从菜单创建节点并自动连线 */
  const handleConnectPick = async (key) => {
    const m = connectMenu
    setConnectMenu(null)
    if (!m) return
    if (key === 'upload') {
      uploadMedia({ drop: { x: m.x, y: m.y }, connectTo: { nodeId: m.nodeId, handleId: m.handleId } })
      return
    }
    const fp = screenToFlowPosition({ x: m.x, y: m.y })
    const maker = key === 'image' ? mkImage : key === 'video' ? mkVideo : key === 'audio' ? mkAudio : key === 'compose' ? mkCompose : makeTextNode
    const newType = key === 'video' ? 'video' : key === 'text' ? 'text' : key === 'audio' ? 'audio' : key === 'compose' ? 'compose' : 'image'
    // 新卡片的连接挂点对齐松手点（而非卡片中心），避免卡片盖住连线
    let pos
    if (m.handleType === 'source') {
      pos = { x: fp.x + 8, y: fp.y - 187 }          // 下游：左缘 in-img 对齐松手点
    } else {
      pos = { x: fp.x - 360, y: fp.y - 153 }        // 上游：右缘 out 对齐松手点
    }
    const n = maker(pos)
    n.id = nextId()
    let edge
    const byId = new Map(nodesRef.current.map((n) => [n.id, n.type]))
    if (m.handleType === 'source') {
      // 从输出挂点拖出 → 新卡片作为下游；合成卡的入口按上游类型分流（视频→in-video / 配音→in-audio）
      const srcKind = nodesRef.current.find((x) => x.id === m.nodeId)?.data?.kind
      const targetHandle = m.nodeType === 'text' ? 'in-text'
        : m.nodeType === 'compose' ? (srcKind === 'audio' ? 'in-audio' : 'in-video')
          : 'in-img'
      edge = { source: m.nodeId, sourceHandle: m.handleId, target: n.id, targetHandle }
      /* C-2：从提示词节点拖出的下游卡片，初始提示词直接带入源文本 */
      if (m.nodeType === 'text') {
        const src = nodesRef.current.find((x) => x.id === m.nodeId)
        if ((src?.data?.text || '').trim()) n.data.prompt = src.data.text
      }
    } else {
      // 从输入挂点拖出 → 新卡片作为上游供给
      edge = { source: n.id, sourceHandle: 'out', target: m.nodeId, targetHandle: m.handleId }
    }
    setNodes((ns) => [...ns, n])
    setEdges((es) => addEdge({
      ...edge, animated: true, type: 'flow',
      data: { sIcon: iconFor(byId.get(edge.source) || newType), tIcon: iconFor(byId.get(edge.target) || newType) },
      style: { stroke: EDGE_COLOR }
    }, es))
    setSelectedId(n.id)
  }

  /* 落点 / 新建 / 上传（S17-0a：实现搬到 hooks/useCanvasInsert.js） */
  const { freeSpot, addNode, handleAdd, createMediaNode, uploadMedia } = useCanvasInsert({
    nodesRef, setNodes, setEdges, setSelectedId, setMenuAt,
    screenToFlowPosition, mkImage, mkVideo, mkAudio, mkCompose, edgeColor: EDGE_COLOR
  })

  /* ---------- S18 项目资产面板：插入画布 / 删除 ----------
     插入：跨项复制由主进程 assets:insert 处理（绝不跨项目直接引用）；
     删除：被引用二次确认后 force，主进程置空涉事项目 JSON 引用，这里同步清空打开画布的内存引用
     （节点变更走既有 dirty/自动保存链路） */
  const insertAssetToCanvas = useCallback(async (item) => {
    try {
      const r = await window.flow.assetsInsert({ url: item.url, projectName: projectName || '' })
      if (!r?.ok) { showToast(r?.error || '插入失败'); return }
      if (r.copied) showToast('跨项目资产已先复制到当前项目')
      await createMediaNode({ kind: item.type, dataUrl: r.url, label: item.name })
    } catch (e) { showToast('插入失败：' + (e?.message || e)) }
  }, [projectName, createMediaNode])
  const deleteAssetFromPanel = useCallback(async (item, force) => {
    try {
      const r = await window.flow.assetsDelete({ url: item.url, force: !!force })
      if (r?.ok) {
        setNodes((ns) => ns.map((n) => {
          const d = n?.data
          if (!d) return n
          let changed = false
          const strip = (arr) => {
            if (!Array.isArray(arr) || !arr.includes(item.url)) return arr
            changed = true
            return arr.filter((u) => u !== item.url)
          }
          const urls = strip(d.urls)
          const refImages = strip(d.refImages)
          return changed ? { ...n, data: { ...d, urls, refImages } } : n
        }))
      }
      return r
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }, [setNodes])

  /* 连线校验 / 尺寸 / 复制 / 删除 / 微调（S17-0a：实现搬到 hooks/useNodeOps.js） */
  const {
    isValidConnection, showConnTip, nodeWidthOf, nodeRectOf,
    duplicateSelected, removeSelected, selectAllNodes, nudgeSelected
  } = useNodeOps({
    nodesRef, edgesRef, setNodes, setEdges, selectedId, setSelectedId, rfw, setConnTip, connTipTimer
  })

  /* ---------- 撤销 / 重做（UI-007 B-2）----------
     阶段0修复①：整图替换不再重置保存基线（snapReset）。
     基线只跟「成功落盘的快照」走：undo 穿过保存点时 dirty 自动为 true（diff 判定），
     修复「撤销到保存点之前仍显示已保存、返回主页静默丢内容」的缺陷 */
  const applySnapshot = (snap) => {
    const merged = mergeRuntime(snap, nodesRef.current)
    bumpIdSeq(merged)
    setNodes(merged)
    setEdges(snap.edges)
    setSelectedId((cur) => (cur && merged.some((n) => n.id === cur) ? cur : null))
  }
  const undo = () => {
    const snap = historyRef.current.undo(nodesRef.current, edgesRef.current)
    if (!snap) { showToast('没有可撤销的操作'); return false }
    applySnapshot(snap)
    showToast(`已撤销 · 还可撤销 ${historyRef.current.depth().past} 步`)
    return true
  }
  const redo = () => {
    const snap = historyRef.current.redo(nodesRef.current, edgesRef.current)
    if (!snap) { showToast('没有可重做的操作'); return false }
    applySnapshot(snap)
    showToast('已重做')
    return true
  }

  /* 连线中点“移除连接”按钮 */
  const removeEdgeById = useCallback((id) => {
    setEdges((es) => es.filter((e) => e.id !== id))
  }, [setEdges])

  // 工具条「下载保存」：弹系统另存为，保存当前节点的首个产物
  const downloadMedia = async (url, kind) => {
    if (!url) return
    const ext = (url.match(/\.(png|jpe?g|webp|gif|mp4|webm)(\?|#|$)/i) || [])[1]
    const r = await window.flow.saveAs({ url, kind, ext })
    if (r.ok) showToast('已保存：' + r.filePath)
    else if (!r.canceled) showToast('保存失败：' + (r.error || '未知错误'))
  }

  // 节点卡片上的动作桥 + 数据更新桥（与右键菜单共用 nodeActionMap，同一份实现）
  useEffect(() => {
    setNodeActions(nodeActionMap)
    setNodeUpdater(update)
  })

  /* ---------- 运行：单节点 / 整图 / 从选中节点（S17-0a：实现搬到 hooks/useRunFlow.js） ---------- */
  const { execute, doRun, runAll, runFromSelected } = useRunFlow({
    nodesRef, edgesRef, runningRef, update,
    setRunning, setRunSummary, setRunIds, setRunEstimate, setSpent,
    setSettingsTab, setShowSettings, showToast, askConfirm, genPrefsRef, placeResult, selectedId,
    taskCtxRef
  })
  runRef.current = { execute, runAll, runFromSelected }

  /* 定位到节点：选中 + 居中（失败节点一键定位） */
  const focusNode = (id) => {
    const n = nodesRef.current.find((x) => x.id === id)
    if (!n) return
    setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === id })))
    setSelectedId(id)
    const w = n.data?.cardWidth || 340
    const h = 360
    rfw.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(0.75, rfw.getZoom()), duration: 300 })
  }

  /* ---------- 节点操作表：工具条 / 右键菜单 / 快捷键共用同一份实现（UI-020 同源性） ---------- */
  const toggleLock = (id) => {
    const n = nodesRef.current.find((x) => x.id === id)
    if (!n) return
    update(id, { locked: !n.data?.locked })
  }
  const renameNode = async (id) => {
    const n = nodesRef.current.find((x) => x.id === id)
    if (!n) return
    const nn = await askInput({
      title: '重命名节点',
      label: '节点名称',
      defaultValue: n.data?.label || '',
      maxLength: 24,
      okText: '保存'
    })
    if (nn == null || nn === n.data?.label) return
    update(id, { label: nn })
  }
  const runFromId = (id) => {
    setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === id })))
    setSelectedId(id)
    execute({ fromId: id, continueOnError: true })
  }
  /* REF-001 + 1.2.0：手动找回结果（网络中断/超时/扣费无产出后先问一句，不重新生成）。
     - 有 taskId：续查远端任务
     - 只有远端地址：按地址重新入库（下载失败可重来）
     - 都没有（提交结果未知）：给出核对路径，避免盲目重试二次扣费 */
  const queryTask = async (id) => {
    const n = nodesRef.current.find((x) => x.id === id)
    const d = n?.data || {}
    if (!d.taskId && !(d.remoteUrls || []).length) {
      showToast(d.unknownSubmit
        ? '这次提交没有拿到任务 ID：先到服务商网页核对是否已生成，有就下载后拖回画布，没有再重新生成'
        : '该节点没有可查询的任务 ID，请重新生成')
      return
    }
    showToast(d.taskId ? '正在查询任务状态…' : '正在按远端地址重新取回…')
    const r = await refetchResult({
      node: n, update, onSpend: (c) => setSpent((v) => v + c), onResult: placeResult
    })
    if (r.ok) showToast('结果已取回')
    else showToast('查询失败：' + (r.error || '未知错误'))
  }
  const nodeActionMap = {
    duplicate: (id) => duplicateSelected(id),
    remove: () => removeSelected(),
    preview: setPreviewUrl,
    removeEdge: removeEdgeById,
    download: downloadMedia,
    retry: (id) => doRun(id),
    rename: renameNode,
    toggleLock,
    queryTask
  }

  /* 右键菜单项：全部转调 nodeActionMap，不复制第二份实现 */
  const buildNodeMenu = (node, selectedCount = 1) => {
    if (!node) return []
    const d = node.data || {}
    const url = d.urls?.[0]
    const isText = node.type === 'text'
    const items = [
      { key: 'preview', label: '放大预览', icon: IcFit, disabled: !url, run: () => nodeActionMap.preview(url) },
      { key: 'duplicate', label: '复制节点', icon: IcCopy, hint: 'Ctrl+D', run: () => nodeActionMap.duplicate(node.id) },
      { key: 'download', label: '下载产物', icon: IcDownload, disabled: !url, run: () => nodeActionMap.download(url, d.kind) },
      { key: 'retry', label: d.status === 'failed' ? '重试生成' : '重新生成', icon: IcRefresh, disabled: isText || !d.model, run: () => nodeActionMap.retry(node.id) },
      // REF-001 / 1.2.0：有远端任务 ID 或已取回的远端地址时提供手动找回（超时/断网/扣费无产出先查再说）
      { key: 'queryTask', label: d.taskId ? '查询任务状态' : '重新取回结果', icon: IcExternal, hidden: !(d.taskId || (d.remoteUrls || []).length), run: () => nodeActionMap.queryTask(node.id) },
      { sep: true },
      { key: 'rename', label: '重命名', icon: IcPencil, run: () => nodeActionMap.rename(node.id) },
      { key: 'lock', label: d.locked ? '解锁节点' : '锁定节点', icon: d.locked ? IcUnlock : IcLock, run: () => nodeActionMap.toggleLock(node.id) },
      { key: 'runFrom', label: '从该节点运行（含下游）', icon: IcPlay, disabled: isText, run: () => runFromId(node.id) },
      { sep: true },
      {
        key: 'remove', label: selectedCount > 1 ? `删除所选 ${selectedCount} 个节点` : '删除节点',
        icon: IcTrash, danger: true, hint: 'Del', run: () => nodeActionMap.remove()
      }
    ]
    // hidden 项直接摘掉，顺带清理因摘项留下的重复分隔线
    const shown = items.filter((it) => !it.hidden)
    return shown.filter((it, i) => !(it.sep && (i === 0 || i === shown.length - 1 || shown[i - 1].sep)))
  }

  /* 右键节点：先选中（多选时保留其余选中，便于批量删除），再在鼠标位置弹菜单 */
  const openNodeMenu = (e, node) => {
    e.preventDefault()
    e.stopPropagation()
    const keepOthers = !!node.selected
    setNodes((ns) => ns.map((x) => (
      x.id === node.id ? { ...x, selected: true } : (keepOthers ? x : { ...x, selected: false }))))
    setSelectedId(node.id)
    setMenuAt(null)     // 与画布空白右键菜单互斥
    setConnectMenu(null)
    const count = nodesRef.current.filter((x) => x.id === node.id || (keepOthers && x.selected)).length
    setNodeMenu({ x: e.clientX, y: e.clientY, id: node.id, idx: 0, count })
  }

  /* 键盘导航用：当前菜单的可选项（跳过分隔线） */
  const nmItems = nodeMenu ? buildNodeMenu(nodes.find((n) => n.id === nodeMenu.id), nodeMenu.count) : []
  const nmNav = nmItems.map((it, i) => ({ it, i })).filter((x) => !x.it.sep)
  const nmRef = useRef([])
  nmRef.current = nmNav

  const pickNodeMenuItem = (it) => {
    setNodeMenu(null)
    if (it && !it.disabled) it.run()
  }
  const moveNodeMenu = (dir) => {
    setNodeMenu((m) => {
      if (!m) return m
      const list = nmRef.current
      if (!list.length) return m
      const cur = Math.max(0, list.findIndex((x) => x.i === m.idx))
      const next = (cur + dir + list.length) % list.length
      return { ...m, idx: list[next].i }
    })
  }

  /* 本次运行的进度（分母来自 onPlan 回传的 id 列表） */
  const runStats = runIds
    ? (() => {
      const list = nodes.filter((n) => runIds.includes(n.id))
      const cnt = (st) => list.filter((n) => n.data?.status === st).length
      return {
        total: list.length,
        done: cnt('done'),
        failed: cnt('failed'),
        active: cnt('queued') + cnt('running') + cnt('submitted')
      }
    })()
    : null

  /* ---------- Agent 工具桥（S17-0a：实现搬到 hooks/useAgentBridge.js，逐行保持原逻辑） ---------- */
  useAgentBridge({
    nodesRef, edgesRef, setNodes, setEdges, setSelectedId, update,
    setSpent, setRunning, runningRef, freeSpot, mkImage, mkVideo, edgeColor: EDGE_COLOR,
    taskCtxRef
  })
  // 调试/自测钩子：暴露历史栈（只读观察用，不参与业务逻辑）
  useEffect(() => { window.__flowHistory = historyRef.current })

  /* ---------- 全局快捷键（S17-0a：实现搬到 hooks/useHotkeys.js，键位与让位规则零改动）---------- */
  useHotkeys({
    dialogRef, finishDialog, nodeMenu, setNodeMenu, showSettings, setShowSettings,
    templatesOpen, setTemplatesOpen, refPickFor, setRefPickFor, compareOpen, setCompareOpen,
    previewUrl, setPreviewUrl, connectMenu, setConnectMenu, menuAt, setMenuAt,
    runMenu, setRunMenu, helpOpen, setHelpOpen, agentOpen, setAgentOpen,
    selectedId, setSelectedId, setNodes, view, saveProject, runFromSelected, runAll,
    undo, redo, duplicateSelected, selectAllNodes, removeSelected, nudgeSelected,
    rfw, moveNodeMenu, pickNodeMenuItem, nmItems, setSpacePan
  })

  const selected = nodes.find((n) => n.id === selectedId)
  // 锁定的节点禁止拖动（保留可选中，方便从工具条解锁）
  const flowNodes = nodes.map((n) => (n.data?.locked ? { ...n, draggable: false } : n))

  return (
    <div className="app">
      {/* 顶栏（S17-0a 拆分：components/TopBar.jsx） */}
      <TopBar
        view={view}
        goHome={goHome}
        spent={spent}
        verLabel={verLabel}
        onOpenSettings={() => { setSettingsTab(null); setShowSettings(true) }}
      />

      {view === 'home' ? (
        <HomeScreen
          onTemplates={() => setTemplatesOpen(true)}
          onUseTemplate={useTemplateFromHome}
          isle={isle}
          onOpenSettings={() => { setSettingsTab(null); setShowSettings(true) }}
          onOpen={loadProject}
          onNew={newFromHome}
          onQuickCreate={quickCreate}
          onRenamed={onHomeRenamed}
          onDeleted={onHomeDeleted}
          toast={showToast}
          askConfirm={askConfirm}
          askInput={askInput}
          currentProjectKey={taskCtxRef.current.projectKey}
          onResumeCanvas={() => setView('studio')}
          onTakeover={takeoverTask}
          onRetry={retryTask}
          onTaskAccepted={acceptTask}
        />
      ) : (
        <>
      {/* 画布（S17-0a 拆分：components/StudioCanvas.jsx） */}
      <StudioCanvas
        mode={mode} dragOver={dragOver} spacePan={spacePan} connFrom={connFrom}
        uploadMedia={uploadMedia} createMediaNode={createMediaNode} setDragOver={setDragOver}
        nodes={nodes} edges={edges} flowNodes={flowNodes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect} onConnectStart={onConnectStart} onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => {
          // REF-004 参考选择模式：点选节点即建参考连线，可连续点选
          if (refPickFor) { addRefFromNode(n.id); return }
          if (agentOpen && n.type !== 'text' && !n.data?.uploaded) setAgentOpen(false)
          setSelectedId(n.id)
        }}
        openNodeMenu={openNodeMenu}
        onPaneClick={() => { setSelectedId(null); setNodeMenu(null) }}
        onPaneContextMenu={(e) => {
          // 空白处右键 → 弹出与底部 ＋ 完全一致的新增菜单，跟随鼠标（与节点菜单互斥）
          e.preventDefault()
          setNodeMenu(null)
          setMenuAt({ x: e.clientX, y: e.clientY })
        }}
        onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop}
        snapLines={snapLines} minimapOpen={minimapOpen}
        onToggleMinimap={() => setMinimapOpen((v) => !v)}
        edgeColor={EDGE_COLOR}
        projectBar={{
          onTemplates: () => setTemplatesOpen(true),
          name: projectName, dirty, open: projectsOpen, projects,
          onToggle: toggleProjects, onLoad: loadProject, onNew: newProject,
          onSave: saveProject, onOrganize: organizeCanvas, onDownloadAll: downloadAll,
          onRename: renameCurrentProject,
          assets: {
            onToast: showToast,
            onInsert: insertAssetToCanvas,
            onDelete: deleteAssetFromPanel
          }
        }}
      />

      {/* 底部工具栏（S17-0a 拆分：components/Toolbar.jsx） */}
      <Toolbar
        mode={mode} setMode={setMode}
        menuAt={menuAt} setMenuAt={setMenuAt}
        helpOpen={helpOpen} setHelpOpen={setHelpOpen}
        running={running} runAll={runAll}
        runMenu={runMenu} toggleRunMenu={toggleRunMenu}
        runMenuAt={runMenuAt} runMoreRef={runMoreRef} setRunMenu={setRunMenu}
        selectedId={selectedId} runFromSelected={runFromSelected}
        nodes={nodes} edges={edges}
        agentOpen={agentOpen} onOpenAgent={() => setAgentOpen(true)}
      />
      {menuAt && (
        <AddMenu
          pos={menuAt === 'toolbar' ? null : menuAt}
          onClose={() => setMenuAt(null)}
          onAdd={handleAdd}
          onUpload={uploadMedia}
        />
      )}
      {connectMenu && (
        <ConnectMenu info={connectMenu} onPick={handleConnectPick} onClose={() => setConnectMenu(null)} />
      )}

      {/* 节点右键菜单（UI-020）：与工具条同一套 action，支持方向键 + Enter */}
      {nodeMenu && (
        <NodeContextMenu
          menu={nodeMenu}
          items={nmItems}
          onPick={pickNodeMenuItem}
          onHover={(i) => setNodeMenu((m) => (m ? { ...m, idx: i } : m))}
          onClose={() => setNodeMenu(null)}
        />
      )}

      {/* 非法连线原因（UI-019）：跟随落点，1.8s 自动消失 */}
      {connTip && (
        <div className="conn-tip" style={{ left: connTip.x, top: connTip.y }} role="status">
          <span className="ct-ico">⚠</span>{connTip.text}
        </div>
      )}

      {/* 右侧参数面板：与 Agent 面板互斥（同一抽屉位），Agent 打开时自动收起、关闭后恢复。
          提示词/上传卡片仅作内容供给，不弹面板 */}
      {selected && selected.type !== 'text' && !selected.data.uploaded && !agentOpen && (
        <ParamsPanel
          node={selected}
          onChange={update}
          onClose={() => { setSelectedId(null); setRefPickFor(null) }}
          onRunNode={doRun}
          running={running}
          upstreamImages={upstreamImagesFor(selected.id, nodes, edges)}
          refs={refsFor(selected.id, nodes, edges)}
          onRemoveRef={(edgeId) => setEdges((es) => es.filter((e) => e.id !== edgeId))}
          onPickRefs={() => setRefPickFor((cur) => (cur ? null : selected.id))}
          pickingRefs={refPickFor === selected.id}
          toast={showToast}
        />
      )}

      {/* 运行进度 / 结果汇总（UI-010） */}
      <RunHud
        running={running}
        stats={runStats}
        summary={runSummary}
        runEstimate={runEstimate}
        nodes={nodes}
        onDismiss={() => setRunSummary(null)}
        onFocusFail={focusNode}
      />

      {/* Agent */}
      {/* B-7：未命名画布的 Isle 会话按窗口会话独立（draft:<sessionId>），不再与首页/其他项目共用 global——
          否则新建项目会串出之前在首页或别的未命名画布里聊过的内容 */}
      <AgentPanel open={agentOpen} onToggle={() => setAgentOpen((v) => !v)} history={agentLog} sessionKey={isleSessionKey} onOpenSettings={() => { setSettingsTab('api'); setShowSettings(true) }} onUpload={() => uploadMedia()} />
        </>
      )}

      {templatesOpen && (
        <TemplateModal
          onClose={() => setTemplatesOpen(false)}
          canSave={nodes.length > 0}
          toast={showToast}
          askInput={askInput}
          askConfirm={askConfirm}
          onSaveCurrent={saveCurrentAsTemplate}
          onLoad={loadTemplate}
        />
      )}
      <SettingsModal
        open={showSettings}
        initialTab={settingsTab}
        sessionKey={isleSessionKey}
        onClose={() => { setShowSettings(false); setSettingsTab(null) }}
      />
      {helpOpen && <ShortcutsModal onClose={() => setHelpOpen(false)} />}

      {/* 应用内对话框（UI-021）：替换原生 prompt / confirm */}
      <DialogHost dialog={dialog} onDone={finishDialog} />

      {/* 返回主页前的未保存提醒 */}
      {leavePrompt && (
        <div className="modal-mask" onClick={() => setLeavePrompt(false)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-head"><span className="confirm-ico"><IcAlert size={15} /></span> 当前项目有未保存的更改</div>
            <div className="confirm-text">
              {projectName ? `「${projectName}」` : '当前画布'}还有 {nodes.length} 个节点、{edges.length} 条连线没有保存，
              直接返回主页会丢掉这些修改。
            </div>
            <div className="confirm-actions">
              <button className="ghost-btn" onClick={() => setLeavePrompt(false)}>取消</button>
              <button className="ghost-btn danger" onClick={leaveNow}>不保存，直接返回</button>
              <button className="primary-btn" onClick={saveAndLeave}>保存并返回</button>
            </div>
          </div>
        </div>
      )}

      {/* 全屏预览 */}
      {previewUrl && (
        <div className="lightbox" onClick={() => setPreviewUrl(null)}>
          {previewUrl.endsWith('.mp4') || previewUrl.includes('video')
            ? <video src={previewUrl} controls autoPlay loop />
            : <img src={previewUrl} alt="" />}
        </div>
      )}

      {/* REQ-007 图片对比：入口 chip（选中 2–4 个含产物图片节点时出现）+ 对比浮层 */}
      {!compareOpen && compareItems.length >= 2 && (
        <button className="compare-entry" onClick={() => {
          const sig = compareItems.map((i) => i.id).join('|')
          setCmpView((v) => (v && v.sig === sig
            ? v
            : { sig, mode: compareItems.length === 2 ? 'split' : 'grid', zoom: 1, splitPos: 50 }))
          setCompareOpen(true)
        }}>
          <IcFit size={12} /> 对比 · {compareItems.length} 张
        </button>
      )}
      {compareOpen && compareItems.length >= 2 && cmpView && (
        <CompareView
          items={compareItems}
          view={cmpView}
          onView={setCmpView}
          onClose={() => setCompareOpen(false)}
          onPreview={setPreviewUrl}
          onDownload={downloadMedia}
        />
      )}

      {/* 轻提示（保存结果等） */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

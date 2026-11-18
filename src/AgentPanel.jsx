import React, { useEffect, useRef, useState } from 'react'
import { AGENT_TOOLS, AGENT_SYSTEM_PROMPT, AGENT_JSON_PROMPT, parseAgentAction } from './agentTools.js'
import { estimateNodeCost, estimateFlowCost } from './costEstimate.js'
import ApprovalCard from './components/ApprovalCard.jsx'
import logoImg from './assets/logo.png'
import ModelLogo from './modelLogos.jsx'
import { mdPlain } from './lib/mdplain.js'
import { IcClose, IcPlus, IcCaret, IcSend, IcSettings, IcAlert } from './icons.jsx'

const MAX_STEPS = 14

const KIND_LABEL = { image: '图片生成', video: '视频生成', text: '提示词' }

/* 工具调用 → 一行人话，显示在对话流里（每一步都可见，可回溯） */
function stepText(name, args, res) {
  const id = (v) => (v ? String(v).replace(/^n_/, '#') : '')
  switch (name) {
    case 'read_flow':
      return `读取画布 · ${res?.nodes?.length || 0} 节点 / ${res?.edges?.length || 0} 连线`
    case 'list_models':
      return `查看可用模型 · 图片 ${res?.image?.length || 0} 个 · 视频 ${res?.video?.length || 0} 个`
    case 'add_node':
      return `新增${KIND_LABEL[args.kind] || '节点'} ${id(res?.id)}${args.prompt ? '：' + String(args.prompt).slice(0, 28) : ''}`
    case 'set_params': {
      const keys = Object.keys(args).filter((k) => k !== 'id')
      return `设置 ${id(args.id)} · ${keys.join(' / ')}`
    }
    case 'connect_nodes':
      return `连线 ${id(args.source)} → ${id(args.target)}`
    case 'delete_node':
      return `删除 ${id(args.id)}`
    case 'run_node':
      return res?.ok ? `生成 ${id(args.id)} · 完成${res.credits ? ` · ${res.credits} 积分` : ''}` : `生成 ${id(args.id)} 失败`
    case 'run_all':
      return res?.ok ? `跑整张画布 · ${res.ranNodes?.length || 0} 个节点${res.credits ? ` · ${res.credits} 积分` : ''}` : '批量生成失败'
    default:
      return name
  }
}

async function runTool(name, args) {
  const a = window.__flowAgent
  if (!a) return { ok: false, error: '画布未就绪' }
  try {
    switch (name) {
      case 'read_flow': return a.readFlow()
      case 'list_models': return await a.listModels()
      case 'add_node': return await a.addNode(args)
      case 'set_params': return a.setParams(args)
      case 'connect_nodes': return a.connect(args)
      case 'delete_node': return a.deleteNode(args)
      case 'run_node': return await a.runNode(args)
      case 'run_all': return await a.runAll()
      default: return { ok: false, error: '未知工具: ' + name }
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

/* ---------- REQ-006a 审批门控 ----------
   结构操作（read_flow/list_models/add_node/set_params/connect_nodes/delete_node）免审；
   生成操作（run_node/run_all）默认必须弹审批卡，确认后才发请求；设置里「免审直跑」开启后跳过。
   审批明细复用 REQ-001 的成本预估组件（costEstimate.js）。 */
const STRUCT_TOOLS = new Set(['read_flow', 'list_models', 'add_node', 'set_params', 'connect_nodes', 'delete_node'])

/* 组装审批明细（与 agentRun 实际执行范围一致：run_all 跳过已完成节点） */
function buildApprovalPlan(name, args) {
  const a = window.__flowAgent
  if (!a) return null
  const flow = a.readFlow()
  if (name === 'run_node') {
    const n = flow.nodes.find((x) => x.id === args.id)
    if (!n) return null
    const est = estimateNodeCost({ type: n.type, data: {
      model: n.model, resolution: n.resolution, n: n.n, duration: n.duration, uploaded: false
    } })
    return {
      kind: 'run_node',
      items: [{ id: n.id, label: n.label || n.type, model: n.model, known: est.known === true, credits: est.credits || 0 }],
      total: est.credits || 0,
      unknownCount: est.known ? 0 : 1
    }
  }
  const est = estimateFlowCost(
    flow.nodes.map((n) => ({ id: n.id, type: n.type, data: {
      model: n.model, resolution: n.resolution, n: n.n, duration: n.duration,
      status: n.status, uploaded: false
    } })),
    flow.edges, { skipDone: true }
  )
  return { kind: 'run_all', items: est.items, total: est.total, unknownCount: est.unknownCount }
}

export default function AgentPanel({ open, onToggle, onOpenSettings, onUpload, history = [], sessionKey = 'global' }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [models, setModels] = useState([])
  const [model, setModel] = useState('')
  const [modelMenu, setModelMenu] = useState(false)
  const [autoRun, setAutoRun] = useState(false) // REQ-006a：免审直跑（设置项，默认关）
  const [slogan, setSlogan] = useState('') // 设置 → Isle 标语（空 = 不显示）
  const [sloganHidden, setSloganHidden] = useState(false) // 本会话内手动关闭
  const autoRunRef = useRef(false)
  const approvalResolver = useRef(null)
  const modeRef = useRef('tools') // tools=原生 function calling；json=网关不支持工具时的 JSON 协议
  const listRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const load = () => window.flow.getSettings().then((s) => {
      const names = (s.models?.chat || []).map((m) => m.model)
      setModels(names)
      setModel((cur) => (names.includes(cur) ? cur : names[0] || ''))
      setAutoRun(!!s.autoRunAgent)
      autoRunRef.current = !!s.autoRunAgent
      setSlogan(typeof s.agentSlogan === 'string' ? s.agentSlogan.trim() : '')
    })
    load()
    window.addEventListener('settings:saved', load)
    return () => window.removeEventListener('settings:saved', load)
  }, [open])

  /* ---------- S20-1/3：会话持久化 + 项目记忆 ----------
     会话按 sessionKey（未命名=global，命名项目=proj:<名>）落 userData/sessions/；
     打开面板时载入并还原（无存档则回退旧 agentLog，自动迁移进会话存储）；
     变更 debounce 800ms 静默落盘；切换 key 时用旧 key 立即落盘一次，防串会话。
     记忆条目注入 system；读写失败一律静默，不影响聊天与执行。 */
  const messagesRef = useRef([])
  useEffect(() => { messagesRef.current = messages }, [messages])
  const summaryRef = useRef(null)
  const memoryRef = useRef([])
  const saveTimer = useRef(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      const r = await window.flow.sessionLoad?.({ key: sessionKey })?.catch?.(() => null)
      if (cancelled) return
      const mem = await window.flow.memoryLoad?.({ key: sessionKey })?.catch?.(() => null)
      if (cancelled) return
      memoryRef.current = Array.isArray(mem?.entries) ? mem.entries : []
      summaryRef.current = r?.summary || null
      if (r?.ok && Array.isArray(r.messages) && r.messages.length) setMessages(r.messages)
      else if (Array.isArray(history) && history.length) setMessages(history) // 旧项目 agentLog → 会话存储迁移
      else setMessages([])
    })()
    return () => { cancelled = true }
  }, [open, sessionKey])

  useEffect(() => {
    if (!open) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      try { window.flow.sessionSave?.({ key: sessionKey, messages, summary: summaryRef.current })?.catch?.(() => {}) } catch { }
    }, 800)
    return () => {
      // 切换 key / 关闭面板：用本 effect 闭包里的 key+messages 立即落盘，杜绝内容写进新会话
      clearTimeout(saveTimer.current)
      try { window.flow.sessionSave?.({ key: sessionKey, messages, summary: summaryRef.current })?.catch?.(() => {}) } catch { }
    }
  }, [messages, sessionKey, open])

  /* 审批卡：挂起 agent 循环，等用户点「仍然执行 / 取消」 */
  const requestApproval = (plan) => new Promise((resolve) => {
    approvalResolver.current = resolve
    setMessages((ms) => [...ms, { role: 'approval', plan, decided: null }])
  })
  const decideApproval = (ok) => {
    setMessages((ms) => ms.map((m) => (m.role === 'approval' && m.decided === null ? { ...m, decided: ok } : m)))
    const r = approvalResolver.current
    approvalResolver.current = null
    if (r) r(ok)
  }

  /* 生成类工具的审批包装：结构操作直通；生成操作默认先审批，拒绝则不发出任何请求 */
  const runWithGate = async (name, args) => {
    if (STRUCT_TOOLS.has(name)) return runTool(name, args)
    if (autoRunRef.current) return runTool(name, args)
    const plan = buildApprovalPlan(name, args)
    if (!plan || !plan.items.length) return { ok: false, error: '没有可运行的生成节点' }
    const ok = await requestApproval(plan)
    if (!ok) return { ok: false, rejected: true, error: '用户拒绝了本次执行，未发出任何生成请求' }
    return runTool(name, args)
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' })
  }, [messages, status])

  const pushAssistant = (content) => setMessages((ms) => [...ms, { role: 'assistant', content }])

  const send = async () => {
    const text = input.trim()
    if (!text || busy || !model) return
    const s = await window.flow.getSettings()
    const hit = (s.models?.chat || []).find((m) => m.model === model) || {}
    setInput('')
    setBusy(true)
    const isRemember = /记住/.test(text) // S20-3：用户明确交代要记的内容
    const history = [...messages, { role: 'user', content: text }]
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }))
    setMessages((ms) => [...ms, { role: 'user', content: text }])

    // S20-2 上下文预算（TECH-006 收口）：system（+人设补充说明 +项目记忆注入）+ 超长摘要 + 最近窗口。
    // 历史完整入库（sessions/），发送窗口维持等效 16 条规模。
    const personaNote = typeof s.personaNote === 'string' ? s.personaNote.trim().slice(0, 2000) : ''
    const personaBlock = personaNote ? '\n\n【用户补充的人设说明】（用户定制，优先遵循）\n' + personaNote : ''
    const memBlock = memoryRef.current.length
      ? '\n\n【项目记忆】（用户明确交代或历史委托沉淀，回答时遵循）\n' + memoryRef.current.map((m) => '- ' + m.text).join('\n')
      : ''
    let useJson = modeRef.current === 'json'

    let windowMsgs = history
    if (history.length > 200 && !summaryRef.current) {
      // 会话超长：把溢出部分用当前 chat 模型压成一段摘要（失败则直接丢弃最旧轮次，不阻塞）
      try {
        const overflow = history.slice(0, history.length - 200)
          .map((m) => `[${m.role}] ${String(m.content || '').slice(0, 300)}`).join('\n').slice(0, 20000)
        const sr = await window.flow.agentStep({ model, messages: [
          { role: 'system', content: '把以下对话压缩为不超过 300 字的中文摘要，保留关键约定、偏好与结论，直接输出摘要正文。' },
          { role: 'user', content: overflow }
        ], baseUrl: hit.baseUrl, apiKey: hit.apiKey })
        summaryRef.current = (sr?.message?.content || '').trim().slice(0, 800) || null
      } catch { summaryRef.current = null }
    }
    if (history.length > 200) windowMsgs = history.slice(-200)

    const sysText = (useJson ? AGENT_JSON_PROMPT : AGENT_SYSTEM_PROMPT) + personaBlock + memBlock
    const msgs = [
      { role: 'system', content: sysText },
      ...(summaryRef.current ? [{ role: 'system', content: '更早对话的摘要：' + summaryRef.current }] : []),
      ...windowMsgs.slice(-16)
    ]

    const addStep = (name, args, res) => setMessages((ms) => [...ms, {
      role: 'step',
      tool: name,
      err: res?.ok === false,
      content: stepText(name, args, res) + (res?.ok === false && res.error ? ` · ${res.error}` : '')
    }])

    try {
      let used = 0
      while (used < MAX_STEPS) {
        setStatus(used === 0 ? '思考中…' : '继续处理…')
        const r = await window.flow.agentStep({
          model, messages: msgs,
          tools: useJson ? undefined : AGENT_TOOLS,
          baseUrl: hit.baseUrl, apiKey: hit.apiKey
        })
        if (!r.ok) throw new Error(r.error || '请求失败')
        const msg = r.message || {}

        // 网关不支持 tools：切 JSON 协议重来（不消耗步数）
        if (!useJson && r.noTools) {
          useJson = true
          modeRef.current = 'json'
          msgs[0] = { role: 'system', content: AGENT_JSON_PROMPT + personaBlock + memBlock } // 保留人设补充与项目记忆注入
          setMessages((ms) => [...ms, { role: 'step', content: '该模型不支持原生工具调用 → 已切换 JSON 协议模式' }])
          continue
        }

        used++

        if (useJson) {
          const act = parseAgentAction(msg.content)
          if (act && act.tool) {
            const name = act.tool
            const args = act.args || {}
            setStatus((stepText(name, args, null) || name) + '…')
            const res = await runWithGate(name, args)
            addStep(name, args, res)
            msgs.push({ role: 'assistant', content: msg.content || '' })
            msgs.push({ role: 'user', content: '工具结果：' + JSON.stringify(res).slice(0, 3000) })
            continue
          }
          const finalText = (act && act.final ? act.final : msg.content || '').trim()
          if (finalText) pushAssistant(finalText)
          msgs.push({ role: 'assistant', content: finalText })
          break
        }

        const calls = msg.tool_calls || []
        if (msg.content && msg.content.trim()) pushAssistant(msg.content.trim())
        msgs.push(calls.length
          ? { role: 'assistant', content: msg.content || null, tool_calls: calls }
          : { role: 'assistant', content: msg.content || '' })
        if (!calls.length) break

        for (const c of calls) {
          const name = c.function?.name || ''
          let args = {}
          try { args = JSON.parse(c.function?.arguments || '{}') } catch { args = {} }
          setStatus((stepText(name, args, null) || name) + '…')
          const res = await runWithGate(name, args)
          addStep(name, args, res)
          msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(res).slice(0, 4000) })
        }
      }
    } catch (err) {
      setMessages((ms) => [...ms, { role: 'system', content: '⚠️ ' + String(err?.message || err) }])
    } finally {
      setBusy(false)
      setStatus('')
      /* S20-3：「记住…」→ 写入项目记忆（失败静默，不影响本轮回答） */
      if (isRemember) {
        try {
          await window.flow.memorySave?.({ key: sessionKey, entry: { text, source: 'user' } })
          const mem = await window.flow.memoryLoad?.({ key: sessionKey })?.catch?.(() => null)
          memoryRef.current = Array.isArray(mem?.entries) ? mem.entries : memoryRef.current
          setMessages((ms) => [...ms, { role: 'step', content: '已记入项目记忆（可在设置 → Isle 里管理）' }])
        } catch { }
      }
    }
  }

  /* 面板高度（UI-022 / 用户定版）：初始即近全高（顶栏下、距底 18px），随视口实时重算；
     用户拖拽过的高度优先，窗口高度变化超过阈值则回到自动值。 */
  const MIN_H = 280
  const vhNow = () => window.innerHeight || 900
  const maxHeight = (vh = vhNow()) => Math.max(320, vh - 118) // 顶栏 64 + 上呼吸 36，底距 18 由 position:bottom 承担
  const autoHeight = (vh = vhNow()) => maxHeight(vh)
  const [height, setHeight] = useState(() => autoHeight())
  const userH = useRef(null) // { h, vh }：用户手动拖出的高度及其当时的视口高度

  useEffect(() => {
    const onResize = () => {
      const vh = vhNow()
      const u = userH.current
      if (u && Math.abs(vh - u.vh) <= 120) {
        // 小幅缩放：保留用户高度，仅做视口上限夹取
        setHeight(Math.min(maxHeight(vh), Math.max(MIN_H, u.h)))
      } else {
        // 首次缩放或大幅缩放：回到随视口重算的自动高度
        userH.current = null
        setHeight(autoHeight(vh))
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 高度变化时消息区保持贴底，避免滚动位置跳动
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [height])

  const resizeStart = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = height
    const move = (ev) => {
      const h = Math.min(maxHeight(), Math.max(MIN_H, Math.round(startH - (ev.clientY - startY))))
      userH.current = { h, vh: vhNow() }
      setHeight(h)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <>
      {open && (
        <div className="agent-panel" style={{ height }}>
          {/* 顶边拖拽把手：调整面板高度（用户定版：面板顶部仅保留缩放横条，无标题无 ×，Esc 关闭） */}
          <div
            className="agent-resize" title="拖拽调整面板高度"
            role="separator" aria-label="拖拽调整 Isle 面板高度" aria-orientation="horizontal"
            onMouseDown={resizeStart}
          ><span /></div>
          <div className="agent-msgs" ref={listRef}>
            {/* S17-3：首页沟通记录随项目带入——回看得到当初的 brief 与 Isle 的拆解 */}
            {history.length > 0 && (
              <div className="agent-history">
                <div className="agent-history-head">首页沟通记录 · {history.length} 条</div>
                {history.map((m, i) => (
                  <div key={'h' + i} className={'msg ' + (m.role === 'user' ? 'user' : 'agent') + ' history'}>
                    <div className="msg-bubble">{mdPlain(m.content)}</div>
                  </div>
                ))}
                <div className="agent-history-divider">以下是在画布里的对话</div>
              </div>
            )}
            {/* UI-028：无消息空态引导——居中标题 + 竖排选项（参照用户指定样式） */}
            {!messages.length && !busy && !history.length && (
              <div className="agent-empty" role="status">
                <h3 className="agent-empty-title">准备怎么开启你的创作？</h3>
                <div className="agent-opts">
                  <button className="agent-opt" onClick={onUpload}><IcPlus size={13} /> 上传本地参考图</button>
                  <button className="agent-opt" onClick={() => setInput('帮我搭建一个图片生成工作流：')}>从一句话开始搭建工作流</button>
                  <button className="agent-opt" onClick={() => setInput('阅读当前画布，告诉我可以怎么完善它')}>看看画布，给点建议</button>
                  <button className="agent-opt" onClick={() => setInput('运行整张画布，生成所有节点')}>运行整张画布</button>
                </div>
              </div>
            )}
            {messages.map((m, i) => {
              if (m.role === 'step') {
                return (
                  <div key={i} className={'agent-step' + (m.err ? ' err' : '')}>
                    {m.err ? <IcAlert size={11} className="step-ico" /> : <span className="step-dot" />}{m.content}
                  </div>
                )
              }
              /* REQ-006a 审批卡：列节点/模型/预估积分，确认才放行
                 S17-2：卡片壳抽到 components/ApprovalCard.jsx，与首页规划卡共用同一组件 */
              if (m.role === 'approval') {
                return (
                  <ApprovalCard
                    key={i}
                    title={m.plan.kind === 'run_node' ? 'Isle 请求执行生成' : 'Isle 请求运行整张画布'}
                    items={m.plan.items}
                    total={m.plan.total}
                    unknownCount={m.plan.unknownCount}
                    decided={m.decided}
                    onDecide={(ok) => decideApproval(ok)}
                    resultText={m.decided ? '已确认执行' : '已取消 · 未发出任何生成请求'}
                  />
                )
              }
              return (
                <div key={i} className={'msg ' + m.role}>
                  {m.role === 'system'
                    ? m.content
                    : <div className="msg-bubble">{mdPlain(m.content)}</div>}
                </div>
              )
            })}
            {busy && <div className="agent-step live"><span className="step-dot pulse" />{status || '处理中…'}</div>}
          </div>
          {/* 底部输入区：整体包进一个圆角矩形（参照 Lovart）：内部输入无边框，下一行 ＋ / 模型 / 发送 */}
          <div className="agent-composer">
            {/* 自定义标语（设置 → Isle 可改，留空不显示；本会话可关闭） */}
            {slogan && !sloganHidden && (
              <div className="agent-slogan">
                <span>{slogan}</span>
                <button className="slogan-x" title="关闭标语" aria-label="关闭标语" onClick={() => setSloganHidden(true)}><IcClose size={12} /></button>
              </div>
            )}
            <div className="composer-box">
              <input
                value={input}
                placeholder={busy ? '执行中…' : models.length ? '请描述你的设计需求，我直接动手搭建' : '请先在设置中添加 Isle 模型'}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                disabled={!models.length}
              />
              <div className="composer-bar">
                <button className="comp-btn" title="上传图片/视频到画布" onClick={onUpload}><IcPlus size={17} /></button>
                <div className="comp-model-wrap">
                  <button
                    className={'comp-model' + (modelMenu ? ' open' : '')}
                    onClick={() => setModelMenu((v) => !v)}
                    disabled={!models.length}
                    title="切换 Isle 模型"
                  >
                    <img src={logoImg} alt="" width={15} height={15} style={{ display: 'block', borderRadius: '50%' }} /> Isle <i><IcCaret size={12} /></i>
                  </button>
                {modelMenu && models.length > 0 && (
                  <div className="comp-menu">
                    {models.map((m) => (
                      <button key={m}
                        className={'comp-item' + (m === model ? ' on' : '')}
                        onClick={() => { setModel(m); setModelMenu(false) }}
                      ><ModelLogo model={m} size={15} /><span>{m}</span></button>
                    ))}
                  </div>
                )}
              </div>
              <span className="comp-spacer" />
              {!models.length && <button className="icon-btn" title="去设置添加" onClick={onOpenSettings}><IcSettings size={15} /></button>}
              <button className="send-btn" onClick={send} disabled={busy || !models.length} title="发送"><IcSend size={16} /></button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Isle 开关已移入底部工具栏（用户定版）：面板打开时由 Toolbar 隐藏图标，
          面板任意方式关闭（Esc / 热键 / 互斥切换）后图标回归 */}
    </>
  )
}

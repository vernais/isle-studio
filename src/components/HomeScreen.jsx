import React, { useCallback, useEffect, useRef, useState } from 'react'
import { IcBolt, IcPlus, IcImage, IcPin, IcMore, IcLock, IcExternal, IcPencil, IcTrash, IcFolder, IcAlert, IcSparkle, IcVideo, IcCaret, IcOrganize, IcCheck, IcArrowRight } from '../icons.jsx'
import { useTasks } from '../store/taskStore.jsx'
import HomeIsle from './HomeIsle.jsx'
import TaskCards from './TaskCards.jsx'

/* S17-1：常用场景 chips
   - 命中模板（名字里含关键词）→ 直接载入模板画布，结构可复用；
   - 没有模板 → 把示例描述填进输入条并明确提示，不让点击石沉大海。 */
const SCENES = [
  {
    key: 'ecom', label: '电商主图', icon: 'image',
    prompt: '白底电商主图，产品居中，柔和顶光，浅灰渐变背景，高级质感，1:1',
    match: ['电商', '商品', '主图', '产品']
  },
  {
    key: 'social', label: '社媒封面', icon: 'image',
    prompt: '社媒封面，大胆色块与大字排版，留白干净，3:4',
    match: ['社媒', '封面', '小红书', '公众号']
  },
  {
    key: 'i2v', label: '图生视频', icon: 'video',
    prompt: '让画面里的水波缓慢流动，镜头轻轻前推，5 秒',
    match: ['图生视频', '视频', '动态']
  },
  {
    key: 'portrait', label: '人像写真', icon: 'image',
    prompt: '自然光人像写真，浅景深，柔和肤色，生活感抓拍，2:3',
    match: ['人像', '写真', '头像']
  },
  {
    key: 'room', label: '室内场景', icon: 'image',
    prompt: '北欧风客厅，午后斜阳，木质与织物质感，广角，16:9',
    match: ['室内', '空间', '家居']
  }
]
const sceneIcon = (kind, size = 13) => (kind === 'video' ? <IcVideo size={size} /> : <IcImage size={size} />)

/* 输入条行高上限：1~6 行自适应（6 行之后内部滚动，不再撑高整页）
   盒模型是 border-box，所以 6 行高度 = 6×行高 + 上下内边距(7+7) */
const TA_LINE = 22
const TA_MAX = TA_LINE * 6 + 14

export default function HomeScreen({ onOpen, onNew, onQuickCreate, onRenamed, onDeleted, toast, askConfirm, askInput, onTemplates, onUseTemplate, isle, onOpenSettings, onResumeCanvas, onTakeover, onRetry, onTaskAccepted, currentProjectKey }) {
  const [projects, setProjects] = useState([])
  const [menuFor, setMenuFor] = useState(null) // 正在弹菜单的项目名
  /* D-1 首页批量管理：批量态 + 已选集合（按项目名） */
  const [batchMode, setBatchMode] = useState(false)
  const [sel, setSel] = useState(() => new Set())
  const [prompt, setPrompt] = useState('')
  const [tpls, setTpls] = useState([]) // 模板库数据（chips 命中判定 + 底部模板区共用）
  /* D-3 项目区一屏一行：新建卡占 1 格，故默认只露 3 个项目（合计 4 格 = 一行）；
     点一次「加载更多」直接全部展开。模板区同款卡片网格，滚到底自动续加载 */
  const PROJ_VISIBLE = 3
  const TPL_ROW = 4
  const [projLimit, setProjLimit] = useState(PROJ_VISIBLE)
  const [tplLimit, setTplLimit] = useState(TPL_ROW)
  const [tplMenuFor, setTplMenuFor] = useState(null) // 模板卡片 ⋯ 菜单
  const tplSecRef = useRef(null)
  const homeScrollRef = useRef(null)
  /* S17-2：沉浸态（Isle 会话占满主区，项目库隐藏）+ 直接生成小开关（v1.0 旧行为）
     isle 会话状态挂在 App 上（useHomeIsle），进出画布也不丢 */
  const [isleMode, setIsleMode] = useState(false)
  const [directMode, setDirectMode] = useState(false)
  const [hasChatModel, setHasChatModel] = useState(true)
  /* S17-0b：任务摘要只读消费 App 级 store——不在这里另存一份状态 */
  const tasks = useTasks()
  const taRef = useRef(null)

  const refresh = useCallback(() => { window.flow.projectList().then(setProjects).catch(() => {}) }, [])
  useEffect(() => { refresh() }, [refresh])
  /* 模板只在画布里增删，回到首页会重新挂载，这里取一次即可 */
  useEffect(() => { window.flow.templateList().then((l) => setTpls(l || [])).catch(() => setTpls([])) }, [])
  /* 是否有对话模型：决定沉浸态提示语（没有模型也照样给通用计划，不挡路） */
  const readChatModels = useCallback(() => {
    window.flow.getSettings().then((s) => setHasChatModel(!!(s.models?.chat || []).length)).catch(() => {})
  }, [])
  useEffect(() => {
    readChatModels()
    window.addEventListener('settings:saved', readChatModels)
    return () => window.removeEventListener('settings:saved', readChatModels)
  }, [readChatModels])

  /* 多行输入自适应高度：先归零再按 scrollHeight 撑开，超出 6 行转内部滚动 */
  const syncHeight = useCallback(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const h = Math.min(el.scrollHeight, TA_MAX)
    el.style.height = h + 'px'
    el.style.overflowY = el.scrollHeight > TA_MAX ? 'auto' : 'hidden'
  }, [])
  useEffect(() => { syncHeight() }, [prompt, syncHeight])

  const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })

  /* D-1 批量管理：勾选 / 全选 / 退出 */
  const toggleSel = (name) => setSel((s) => {
    const n = new Set(s)
    if (n.has(name)) n.delete(name); else n.add(name)
    return n
  })
  const exitBatch = () => { setBatchMode(false); setSel(new Set()) }
  /* Esc 退出批量态（不抢应用内对话框/菜单的 Esc） */
  useEffect(() => {
    if (!batchMode) return undefined
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.modal-mask, .menu-mask, .dlg-mask')) return
      e.stopPropagation()
      exitBatch()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [batchMode])

  /* D-1 批量删除：确认一次，逐个删除，逐个回调 onDeleted 保持全局状态一致 */
  const batchDelete = async () => {
    const names = [...sel]
    if (!names.length) return
    const shown = names.slice(0, 3).map((n) => `「${n}」`).join('、') + (names.length > 3 ? ` 等 ${names.length} 个项目` : '')
    const okDel = await askConfirm({
      title: `删除 ${names.length} 个项目？`,
      text: `${shown} 的保存文件将被移除，不可恢复；项目里的节点与生成产物会一并删除。`,
      okText: `删除 ${names.length} 个项目`, danger: true, icon: 'trash'
    })
    if (!okDel) return
    let okN = 0
    const fail = []
    for (const name of names) {
      try {
        const r = await window.flow.projectDelete({ name })
        if (r.ok) { okN++; onDeleted(name) } else fail.push(name)
      } catch { fail.push(name) }
    }
    exitBatch()
    refresh()
    if (okN) toast(`已删除 ${okN} 个项目`)
    if (fail.length) toast(`${fail.length} 个删除失败：` + fail.join('、'))
  }

  const refreshTpls = useCallback(() => { window.flow.templateList().then((l) => setTpls(l || [])).catch(() => setTpls([])) }, [])
  /* 模板卡片 ⋯ 菜单：载入 / 重命名 / 删除（与项目卡同一套交互） */
  const tplAct = async (kind, t) => {
    setTplMenuFor(null)
    if (kind === 'load') {
      if (t.broken) { toast('模板文件损坏，无法载入'); return }
      if (typeof onUseTemplate === 'function') await onUseTemplate(t.name)
      return
    }
    if (kind === 'rename') {
      const nn = await askInput({
        title: '重命名模板', label: '模板名称', defaultValue: t.name, maxLength: 40, okText: '保存'
      })
      if (!nn || nn === t.name) return
      const r = await window.flow.templateRename({ name: t.name, newName: nn })
      if (r.ok) { toast('已重命名为「' + r.name + '」'); refreshTpls() }
      else toast('重命名失败：' + (r.error || '未知错误'))
      return
    }
    if (kind === 'delete') {
      const okDel = await askConfirm({
        title: `删除模板「${t.name}」？`,
        text: '模板文件将被移除，不可恢复；当前画布与项目不受影响。',
        okText: '删除模板', danger: true, icon: 'trash'
      })
      if (!okDel) return
      const r = await window.flow.templateDelete({ name: t.name })
      if (r.ok) { toast('已删除模板：' + t.name); refreshTpls() }
      else toast('删除失败：' + (r.error || '未知错误'))
    }
  }
  /* 模板区下滑自动加载：滚动到底部附近再续 4 张（不打断首屏一行展示） */
  const onHomeScroll = (e) => {
    const el = e.currentTarget
    if (!tplSecRef.current) return
    if (tplLimit >= tpls.length) return
    const left = el.scrollHeight - el.scrollTop - el.clientHeight
    if (left < 160) setTplLimit((n) => n + TPL_ROW)
  }

  /* 项目卡片 ⋯ 菜单动作 */
  const act = async (kind, p) => {
    setMenuFor(null)
    if (kind === 'window') { window.flow.projectOpenWindow({ name: p.name }); return }
    if (kind === 'pin') {
      const r = await window.flow.projectPin({ name: p.name, pinned: !p.pinned })
      if (r.ok) refresh(); else toast('操作失败：' + (r.error || '未知错误'))
      return
    }
    if (kind === 'rename') {
      const nn = await askInput({
        title: '重命名项目',
        label: '项目名称',
        defaultValue: p.name,
        placeholder: '给这个项目起个名字',
        maxLength: 40,
        okText: '保存'
      })
      if (nn == null || nn === p.name) return
      const r = await window.flow.projectRename({ name: p.name, newName: nn })
      if (r.ok) { onRenamed(p.name, r.name); refresh(); toast('已重命名为「' + r.name + '」') }
      else toast('重命名失败：' + (r.error || '未知错误'))
      return
    }
    if (kind === 'delete') {
      const okDel = await askConfirm({
        title: `删除项目「${p.name}」？`,
        text: '保存文件将被移除，不可恢复；项目里的节点与生成产物会一并删除。',
        okText: '删除项目', danger: true, icon: 'trash'
      })
      if (!okDel) return
      const r = await window.flow.projectDelete({ name: p.name })
      if (r.ok) { onDeleted(p.name); refresh(); toast('已删除：' + p.name) }
      else toast('删除失败：' + (r.error || '未知错误'))
    }
  }

  const submitPrompt = () => {
    const t = prompt.trim()
    if (!t) return
    setPrompt('')
    /* S17-2：默认走「先规划」——沉浸态里出计划卡；开了「直接生成」才回 v1.0 的一步建图 */
    if (directMode) { onQuickCreate(t); return }
    setIsleMode(true)
    isle.send(t)
  }
  const exitIsle = useCallback(() => setIsleMode(false), [])
  /* Esc 收起沉浸态：输入内容与会话都留在 state 里，不丢 */
  useEffect(() => {
    if (!isleMode) return undefined
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.modal-mask, .menu-mask')) return
      e.stopPropagation()
      setIsleMode(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isleMode])
  /* S16-4：空输入时按钮置灰不可点（此前可点但静默无反应，观感像按钮坏了） */
  const canGo = prompt.trim().length > 0

  /* 回车提交 / Shift+回车换行；中文输入法组词中的回车不算提交 */
  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return
    if (e.shiftKey) return
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return
    e.preventDefault()
    submitPrompt()
  }

  /* S17-1：场景 chip —— 有模板载入模板，没模板给示例并说清楚去哪里存模板 */
  const templateFor = (s) => tpls.find((t) => (s.match || []).some((k) => String(t.name || '').includes(k)))
  const useScene = async (s) => {
    const hit = templateFor(s)
    if (hit && typeof onUseTemplate === 'function') {
      const ok = await onUseTemplate(hit.name)
      if (ok) return
      if (ok === false) return // 用户取消了替换，什么都不做
    }
    if (!prompt.trim()) setPrompt(s.prompt)
    setTimeout(() => {
      const el = taRef.current
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
    }, 0)
    toast(`还没有「${s.label}」模板，已把示例描述填好；可在画布「模板库」把常用流程存成模板`)
  }

  return (
    <div className={'home' + (isleMode ? ' isle-on' : '')}>
      <div className={'home-scroll' + (isleMode ? ' isle' : '')} ref={homeScrollRef} onScroll={onHomeScroll}>
        {/* 上半部：沟通区（S17-1 重排：标题 → 多行输入 → 场景 chips → 任务摘要）
            S17-2：聚焦输入条或提交 brief 进入沉浸态——标题/项目库收起，Isle 会话与计划卡占满主区 */}
        <header className={'home-hero' + (isleMode ? ' isle' : '')}>
          {!isleMode && <h1 className="home-title">让灵感，在这里自由生长。</h1>}
          {!isleMode && (
            <p className="home-sub">一句话说清想法，Isle 拆成步骤给你确认；也可以从常用场景开始。</p>
          )}

          <div className="home-composer">
            <textarea
              ref={taRef}
              rows={1}
              value={prompt}
              placeholder={isleMode
                ? '接着补充：比例、时长、要不要配音…'
                : '描述你的场景，回车让 Isle 拆步骤，Shift + 回车换行…'}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => setIsleMode(true)}
            />
            <div className="composer-ops">
              <button
                className={'composer-direct' + (directMode ? ' on' : '')}
                onClick={() => setDirectMode((v) => !v)}
                aria-pressed={directMode}
                title={directMode
                  ? '当前：直接生成（回车立即建一张图，v1.0 旧行为）——点击改回先规划'
                  : '当前：先规划（回车让 Isle 出计划卡）——点击改为直接生成'}
              >
                <span className="cdot" />直接生成
              </button>
              <button className="composer-go" onClick={submitPrompt} disabled={!canGo}>
                {directMode ? '生成' : '规划'} <IcBolt size={13} />
              </button>
            </div>
          </div>

          {!isleMode && (
          <div className="home-chips" role="group" aria-label="常用场景">
            <span className="chips-label"><IcSparkle size={12} /> 常用场景</span>
            {SCENES.map((s) => {
              const hasTpl = !!templateFor(s)
              return (
                <button
                  key={s.key}
                  className="home-chip"
                  title={hasTpl ? `载入模板并打开画布：${s.label}` : `填入「${s.label}」示例描述`}
                  onClick={() => useScene(s)}
                >
                  {sceneIcon(s.icon)} {s.label}
                  {hasTpl && <span className="chip-tpl">模板</span>}
                </button>
              )
            })}
          </div>
          )}

          {/* 沉浸态：Isle 会话 + 计划卡（会话状态在 useHomeIsle，收起不丢） */}
          {isleMode ? (
            <HomeIsle
              messages={isle.messages}
              busy={isle.busy}
              status={isle.status}
              hasChatModel={hasChatModel}
              onDecide={isle.decide}
              onBudget={isle.setPlanBudget}
              onExit={exitIsle}
              onOpenSettings={onOpenSettings}
            />
          ) : (
            /* S17-3：任务卡（执行中 / 待验收 / 失败重试 + 接管入口）*/
            <TaskCards
              tasks={tasks}
              currentProjectKey={currentProjectKey}
              onOpen={onOpen}
              onResume={onResumeCanvas}
              onTakeover={onTakeover}
              onRetry={onRetry}
              onAccepted={onTaskAccepted}
            />
          )}
        </header>

        {/* 下半部：项目库（固定/排序/重命名/删除/新窗口打开全部保留）；沉浸态整体隐藏 */}
        {!isleMode && (
        <>
        <section className="home-sec">
          <div className="home-sec-head">
            {batchMode ? (
              <>
                <span className="sec-title">已选 {sel.size} 项</span>
                <div className="batch-actions">
                  <button className="home-tpl-btn" onClick={() => setSel(new Set(projects.map((p) => p.name)))}
                    disabled={sel.size === projects.length}>全选</button>
                  <button className="home-tpl-btn" onClick={() => setSel(new Set())} disabled={!sel.size}>清空</button>
                  <button className="home-tpl-btn danger" onClick={batchDelete} disabled={!sel.size} title="删除选中项目"><IcTrash size={13} /> 删除</button>
                  <button className="home-tpl-btn" onClick={exitBatch}>完成</button>
                </div>
              </>
            ) : (
              <>
                <span className="sec-title">项目</span>
                <IcOrganize size={15} />
                <button className="home-tpl-btn home-batch-btn" onClick={() => setBatchMode(true)} title="批量选择项目进行删除">
                  <IcCheck size={13} /> 批量管理
                </button>
                <button className="home-tpl-btn" onClick={() => tplSecRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} title="跳到下方模板库"><IcFolder size={13} /> 模板库</button>
              </>
            )}
          </div>
          <div className="pgrid">
            <button className="pcard new" onClick={onNew}>
              <span className="pcard-new-box"><IcPlus size={20} /></span>
              <span className="pcard-foot"><span className="pcard-name">新建项目</span></span>
            </button>
            {projects.slice(0, batchMode ? projects.length : projLimit).map((p) => (
              <div key={p.name} className={'pcard' + (batchMode && sel.has(p.name) ? ' batch-sel' : '')}>
                <div className="pcard-cover" onClick={() => (batchMode ? toggleSel(p.name) : onOpen(p.name))}>
                  {p.thumbs?.[0]
                    ? <img src={p.thumbs[0]} alt="" draggable={false} />
                    : <span className="pcard-ph"><IcImage size={26} /></span>}
                  {p.pinned && !batchMode && <span className="pcard-pin"><IcPin size={11} /></span>}
                  {batchMode && (
                    <button
                      type="button"
                      className={'pcard-check' + (sel.has(p.name) ? ' on' : '')}
                      title={sel.has(p.name) ? '取消选中' : '选中项目'}
                      onClick={(e) => { e.stopPropagation(); toggleSel(p.name) }}
                    >{sel.has(p.name) && <IcCheck size={12} />}</button>
                  )}
                  {!batchMode && (
                    <button
                      className="pcard-more"
                      title="更多操作"
                      onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === p.name ? null : p.name) }}
                    ><IcMore size={15} /></button>
                  )}
                </div>
                <div className="pcard-foot" onClick={() => (batchMode ? toggleSel(p.name) : onOpen(p.name))}>
                  <div className="pcard-name" title={p.name}>{p.name}</div>
                  <div className="pcard-meta">
                    更新于 {fmtDate(p.savedAt)}
                  </div>
                </div>
                {menuFor === p.name && (
                  <>
                    <div className="menu-mask" onClick={() => setMenuFor(null)} />
                    <div className="pcard-menu">
                      <button onClick={() => act('window', p)}><IcExternal size={14} /> 在新窗口打开</button>
                      <button onClick={() => act('pin', p)}><IcPin size={14} /> {p.pinned ? '取消固定' : '固定'}</button>
                      <button onClick={() => act('rename', p)}><IcPencil size={14} /> 编辑</button>
                      <button className="danger" onClick={() => act('delete', p)}><IcTrash size={14} /> 删除</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
          {/* 项目只露一行：还有剩余时给「加载更多」，点一次全部展开 */}
          {!batchMode && projects.length > projLimit && (
            <div className="load-more-wrap">
              <button className="load-more" onClick={() => setProjLimit(projects.length)}>
                加载更多（还有 {projects.length - projLimit} 个）
              </button>
            </div>
          )}
        </section>

        {/* D-3 模板库：与项目区同款卡片网格常驻页面底部，滑到底自动续加载 */}
        <section className="home-sec home-tpl-sec" ref={tplSecRef}>
          <div className="home-sec-head">
            <span className="sec-title">模板库</span>
            <span className="sec-sub">{tpls.length ? `${tpls.length} 个模板` : '把常用画布存成模板，随时复用'}</span>
          </div>
          {tpls.length === 0 ? (
            <div className="tpl-inline-empty">
              <IcFolder size={20} />
              <span>还没有模板：在画布的「模板库」里把常用流程保存为模板后，这里会显示</span>
            </div>
          ) : (
            <>
              <div className="pgrid">
                {tpls.slice(0, tplLimit).map((t) => (
                  <div key={t.name} className={'pcard' + (t.broken ? ' tpl-broken' : '')}>
                    <div className="pcard-cover" onClick={() => tplAct('load', t)} title={t.broken ? '文件损坏，无法载入' : '载入这个模板'}>
                      <span className="pcard-ph"><IcFolder size={26} /></span>
                      {!t.broken && (
                        <button
                          className="pcard-more"
                          title="更多操作"
                          onClick={(e) => { e.stopPropagation(); setTplMenuFor(tplMenuFor === t.name ? null : t.name) }}
                        ><IcMore size={15} /></button>
                      )}
                      {t.broken && <span className="tpl-broken-tag"><IcAlert size={11} /> 文件损坏</span>}
                    </div>
                    <div className="pcard-foot" onClick={() => tplAct('load', t)}>
                      <div className="pcard-name" title={t.name}>{t.name}</div>
                      <div className="pcard-meta">
                        {t.broken ? '无法载入' : `${fmtDate(t.savedAt)} · ${t.nodeCount ?? 0} 个节点`}
                      </div>
                    </div>
                    {tplMenuFor === t.name && (
                      <>
                        <div className="menu-mask" onClick={() => setTplMenuFor(null)} />
                        <div className="pcard-menu">
                          <button onClick={() => tplAct('load', t)}><IcArrowRight size={14} /> 载入模板</button>
                          <button onClick={() => tplAct('rename', t)}><IcPencil size={14} /> 重命名</button>
                          <button className="danger" onClick={() => tplAct('delete', t)}><IcTrash size={14} /> 删除</button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {tplLimit < tpls.length && (
                <div className="load-more-wrap">
                  <button className="load-more" onClick={() => setTplLimit((n) => n + TPL_ROW)}>
                    加载更多（还剩 {tpls.length - tplLimit} 个）
                  </button>
                </div>
              )}
            </>
          )}
        </section>
        </>)}
      </div>
    </div>
  )
}

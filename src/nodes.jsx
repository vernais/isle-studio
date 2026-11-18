import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Handle, Position, NodeToolbar, useStore, useReactFlow, getBezierPath, BaseEdge, EdgeLabelRenderer } from '@xyflow/react'
import { IcClose, IcCopy, IcCaret, IcBolt, IcFit, IcTrash, IcText, IcImage, IcVideo, IcAudio, IcComposeGlyph, NodeGlyph, IcDownload, IcLock, IcUnlock, IcAlert, IcRefresh } from './icons.jsx'
import ModelLogo from './modelLogos.jsx'
import { explainError } from './errors.js'
import ThumbImg from './ThumbImg.jsx'
import RolePicker from './components/RolePicker.jsx'
import { ratioOf, cardWidthOf, cardWidthFor } from './lib/cardSize.js'
import { AUDIO_MODELS } from './lib/audioModels.js'
import { isKlingV4, klingModeOf, KLING_MODE_LABEL } from './lib/klingVideo.js'

/* 模块桥：App 注册跨节点动作与数据更新 */
let nodeActions = { duplicate: () => {}, remove: () => {}, preview: () => {}, download: () => {}, retry: () => {}, queryTask: () => {} }
export function setNodeActions(a) { nodeActions = a }
let nodeUpdater = (id, patch) => {}
export function setNodeUpdater(fn) { nodeUpdater = fn }

/* 节点内浮层（模型下拉）统一关闭入口：Esc 由 App 调度，避免各处自建监听 */
export function closeNodeMenus() { window.dispatchEvent(new Event('flow:close-menus')) }
export function hasOpenNodeMenu() { return !!document.querySelector('.mmenu') }

const STATUS_TEXT = {
  idle: '', queued: '排队中', submitted: '生成中', running: '生成中',
  done: '完成', failed: '失败'
}

/* 空态水印：统一线性图标 + 一行引导文案，按节点类型换形 */
const EmptyGlyph = ({ kind = 'image' }) => (
  <span className="empty-glyph">
    {kind === 'video'
      ? <IcVideo size={44} strokeWidth={1.2} />
      : kind === 'audio'
        ? <IcAudio size={44} strokeWidth={1.2} />
        : kind === 'compose'
          ? <IcComposeGlyph size={44} strokeWidth={1.2} />
          : <IcImage size={44} strokeWidth={1.2} />}
    <span className="empty-hint">
      {kind === 'video' ? '输入提示词后生成视频'
        : kind === 'audio' ? '输入台词后生成配音'
          : kind === 'compose' ? '连入视频与配音后运行合成'
            : '输入提示词后生成'}
    </span>
  </span>
)

function useModels(kind) {
  const fallback = kind === 'audio' ? AUDIO_MODELS : []
  const [models, setModels] = useState(fallback)
  useEffect(() => {
    let alive = true
    window.flow.getSettings().then((s) => {
      if (!alive) return
      const list = (s.models?.[kind] || []).map((m) => m.model)
      /* P2：设置里没有 audio 分类时用内置兜底，保证配音节点开箱可用 */
      setModels(list.length ? list : fallback)
    })
    return () => { alive = false }
  }, [kind])
  return models
}

/* ---------- 圆形挂点：悬在卡片外侧，top 为卡片高度百分比；有连线时常亮 ---------- */
function Port({ type, position, top, left, right, id, nodeId, children }) {
  const connected = useStore((s) =>
    s.edges.some((e) => (type === 'source'
      ? e.source === nodeId && (e.sourceHandle || null) === (id || null)
      : e.target === nodeId && (e.targetHandle || null) === (id || null))))
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      className={'hport ' + (type === 'source' ? 'hport-out' : 'hport-in') + (connected ? ' port-on' : '')}
      style={{
        width: 28, height: 28, borderRadius: '50%',
        background: 'var(--hport-bg, #202024)', border: '1px solid var(--hport-line, #2c2c31)',
        top, left, right,
        transform: 'translateY(-50%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: 'var(--hport-sh, 0 2px 10px rgba(0,0,0,.45))'
      }}
    >
      <span style={{ pointerEvents: 'none', lineHeight: 1, display: 'flex' }}>{children}</span>
    </Handle>
  )
}

/* 状态覆盖层：进行中显示进度，失败时给出「重试 / 查看详情」并保留完整报错（UI-006） */
function StatusOverlay({ id, data }) {
  const [detail, setDetail] = useState(false)
  if (['queued', 'submitted', 'running'].includes(data.status)) {
    return (
      <div className="node-overlay">
        <div className="spinner" />
        <div className="overlay-text">{Math.round(data.progress || 0)}%</div>
        <div className="overlay-sub">{data.status === 'queued' ? '排队中…' : '生成中…'}</div>
      </div>
    )
  }
  if (data.status === 'failed') {
    const info = explainError(data.error)
    /* 1.2.0：能找回结果的失败（有任务 ID / 有远端地址 / 提交结果未知）多给一个入口，
       避免用户直接点「重试」造成重复扣费 */
    const canRefetch = !!(data.taskId || (data.remoteUrls || []).length)
    const el = Number(data.submitElapsedMs) || 0
    return (
      <div className="node-overlay fail">
        <div className="fail-inner">
          <div className="fail-head"><IcAlert size={13} /> {info.head}</div>
          <div className={'fail-raw' + (detail ? ' open' : '')}>{info.raw}</div>
          {el > 0 && (
            <div className="fail-meta">提交耗时 {(el / 1000).toFixed(0)} 秒{data.submitDetail ? ` · ${String(data.submitDetail).slice(0, 90)}` : ''}</div>
          )}
          {detail && (
            <div className="fail-why">
              <p><b>可能原因</b>{info.cause}</p>
              <p><b>下一步</b>{info.next}</p>
            </div>
          )}
          <div className="fail-actions">
            <button
              className="fail-btn primary" title="重新生成该节点"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); nodeActions.retry(id) }}
            ><IcRefresh size={11} /> 重试</button>
            {canRefetch && (
              <button
                className="fail-btn" title={data.taskId ? '查询这个任务是否已完成并取回产物' : '按远端地址重新取回产物'}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); nodeActions.queryTask(id) }}
              >{data.taskId ? '查询已有任务' : '重新取回'}</button>
            )}
            <button
              className="fail-btn" title={detail ? '收起完整报错' : '展开完整报错'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setDetail((v) => !v) }}
            >{detail ? '收起' : '查看详情'}</button>
          </div>
        </div>
      </div>
    )
  }
  return null
}

/* 卡片等比例缩放：拖四角点调整宽度，高度按画面比例自动跟随；
   左侧角向左拖 = 放大，右侧角向右拖 = 放大 */
function startResize(e, id, data, side) {
  e.stopPropagation(); e.preventDefault()
  const startX = e.clientX
  const startW = data.cardWidth || 340
  const dir = side === 'left' ? -1 : 1
  const move = (ev) => {
    const w = Math.max(160, Math.min(900, Math.round(startW + dir * (ev.clientX - startX))))
    nodeUpdater(id, { cardWidth: w })
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/* 目标高度（与图片 1:1 卡片总高一致）下，按画面比例反推卡片宽度
   （实现已抽到 lib/cardSize.js，供引擎回写与参数面板共用；此处 re-export 保持既有引用） */
export { CARD_TARGET_H, cardWidthFor, uploadedWidth } from './lib/cardSize.js'

/* 画面宽高比：优先用真实比例 data.ar，其次按 size 预设；
   size 为 Auto 时保持初始比例（图片 1:1 / 视频 16:9），不再塌成内容高度 */
export function arOf(data) {
  return ratioOf(data)
}

/* 卡片内输入框的本地草稿（打包验收修复 A）：React Flow 的节点 store 落后一帧，
   受控 value 会在输入瞬间被上一帧的旧数据回写一次，光标记被重置到末尾。
   聚焦期间以本地草稿为准（与 DOM 完全一致，React 不再回写），
   失焦或外部变更（撤销/载入项目/Agent 改参数）时再同步外部值。 */
function useDraftInput(value, commit) {
  const prop = value ?? ''
  const [draft, setDraft] = useState(prop)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current && draft !== prop) setDraft(prop)
  }, [prop])
  return {
    value: draft,
    onFocus: () => { focused.current = true },
    onBlur: () => { focused.current = false; if (draft !== prop) setDraft(prop) },
    onChange: (e) => { const v = e.target.value; setDraft(v); commit(v) }
  }
}

/* ---------- Higgsfield 三态卡片 ---------- */
function Card({ id, data, selected, models, children, placeholder }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const taRef = useRef(null)
  const menuRef = useRef(null)
  const hasContent = !!(data.prompt || data.urls?.length)
  const uploaded = !!data.uploaded // 上传内容卡片：无生成器内部控件
  const width = cardWidthOf(data)
  const promptInput = useDraftInput(data.prompt, (v) => nodeUpdater(id, { prompt: v }))

  const autoGrow = (el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }
  useEffect(() => { autoGrow(taRef.current) }, [data.prompt])

  // 模型菜单打开时拦截滚轮：否则滚动事件冒泡到画布会变成缩放
  useEffect(() => {
    const el = menuRef.current
    if (!menuOpen || !el) return
    const stop = (e) => e.stopPropagation()
    el.addEventListener('wheel', stop)
    return () => el.removeEventListener('wheel', stop)
  }, [menuOpen])

  // 参数区（提示词/模型行/菜单）整体拦截滚轮，避免画布缩放
  const extraRef = useRef(null)
  useEffect(() => {
    const el = extraRef.current
    if (!el) return
    const stop = (e) => e.stopPropagation()
    el.addEventListener('wheel', stop)
    return () => el.removeEventListener('wheel', stop)
  }, [])

  // Esc 关闭模型下拉：由 App 统一广播（避免每个节点各自绑定 window 监听）
  useEffect(() => {
    if (!menuOpen) return undefined
    const h = () => setMenuOpen(false)
    window.addEventListener('flow:close-menus', h)
    return () => window.removeEventListener('flow:close-menus', h)
  }, [menuOpen])

  // 角点必须用原生 mousedown：React Flow 的 d3-drag 在节点上原生监听并 stopPropagation，
  // React 合成事件收不到；角点自身监听在冒泡到节点之前拦截，才能禁用节点拖拽、启动缩放
  const cornerRef = (side) => (el) => {
    if (el) el.onmousedown = (e) => { e.stopPropagation(); e.preventDefault(); startResize(e, id, data, side) }
  }

  /* UI-017：角点可聚焦，方向键调整卡片宽度（Shift = 40px 大步进） */
  const resizeByKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault(); e.stopPropagation()
    const step = e.shiftKey ? 40 : 10
    const w0 = data.cardWidth || 340
    const next = Math.max(160, Math.min(900, Math.round(w0 + (e.key === 'ArrowRight' ? step : -step))))
    nodeUpdater(id, { cardWidth: next })
  }

  return (
    <>
      {/* 选中时浮在卡片上方的工具条：预览 / 复制 / 下载 / 锁定 / 删除 */}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={10} className="node-toolbar">
        <button className="tb-btn" title="放大预览" disabled={!data.urls?.[0]}
          onClick={() => nodeActions.preview(data.urls[0])}><IcFit size={14} /></button>
        <button className="tb-btn" title="复制节点" onClick={() => nodeActions.duplicate()}><IcCopy size={14} /></button>
        <button className="tb-btn" title={data.urls?.[0] ? '下载保存' : '暂无可保存的内容'} disabled={!data.urls?.[0]}
          onClick={() => nodeActions.download(data.urls[0], data.kind)}><IcDownload size={14} /></button>
        <RefRolesEditor id={id} data={data} />
        <button className="tb-btn" title={data.locked ? '解锁节点' : '锁定节点'}
          onClick={() => nodeUpdater(id, { locked: !data.locked })}>
          {data.locked ? <IcUnlock size={14} /> : <IcLock size={14} />}
        </button>
        <span className="tb-sep" />
        <button className="tb-btn danger" title="删除节点" onClick={() => nodeActions.remove()}><IcTrash size={14} /></button>
      </NodeToolbar>
      <div className="node-wrap" style={{ width }}>
        <div className="node-label">{data.label}{data.locked ? <IcLock size={10} className="lock-flag" /> : null}</div>
        <div className={'hfnode' + (selected ? ' sel' : '') + (hasContent ? ' has-content' : '') + (data.locked ? ' locked' : '') + (data.dupFlash ? ' dup-flash' : '')}>
          {selected && !data.locked && <>
            <span className="corner c-tl" ref={cornerRef('left')} role="slider" tabIndex={0}
              title="拖动调整尺寸（方向键微调）" aria-label="调整节点尺寸"
              aria-valuemin={160} aria-valuemax={900} aria-valuenow={Math.round(width)}
              onKeyDown={resizeByKey} />
            <span className="corner c-tr" ref={cornerRef('right')} role="slider" tabIndex={0}
              title="拖动调整尺寸（方向键微调）" aria-label="调整节点尺寸"
              aria-valuemin={160} aria-valuemax={900} aria-valuenow={Math.round(width)}
              onKeyDown={resizeByKey} />
            <span className="corner c-bl" ref={cornerRef('left')} role="slider" tabIndex={0}
              title="拖动调整尺寸（方向键微调）" aria-label="调整节点尺寸"
              aria-valuemin={160} aria-valuemax={900} aria-valuenow={Math.round(width)}
              onKeyDown={resizeByKey} />
            <span className="corner c-br" ref={cornerRef('right')} role="slider" tabIndex={0}
              title="拖动调整尺寸（方向键微调）" aria-label="调整节点尺寸"
              aria-valuemin={160} aria-valuemax={900} aria-valuenow={Math.round(width)}
              onKeyDown={resizeByKey} />
          </>}

          {children}

        {/* 参数层：常驻可见（UI-005 / UI-023）——不移动鼠标即可读到参数摘要与状态，
            提示词框始终在 DOM / Tab 序列内；上传素材卡无生成参数，故不渲染 */}
        {!uploaded && (
        <div className="hf-params" ref={extraRef}>
          {data.kind === 'compose' ? (
            /* 合成卡没有提示词和模型：只显示输入源摘要，避免留空输入框 */
            <div className="compose-row">
              <span className="compose-title"><IcComposeGlyph size={12} /> 本地合成</span>
              <span className="compose-meta">
                {data.composeSummary || '左侧连入视频与配音后运行'}
              </span>
            </div>
          ) : (
          <>
          <textarea
            ref={taRef}
            className="hf-prompt nodrag"
            rows={1}
            placeholder={placeholder || '描述你想生成的画面…'}
            {...promptInput}
            onInput={(e) => autoGrow(e.target)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="hf-sum">
            <div className="model-pick" onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}>
              <span className="micon">{data.model ? <ModelLogo model={data.model} size={13} /> : <NodeGlyph kind={data.kind} size={11} />}</span>
              <span className="mname">{data.model || '选择模型'}</span>
              <i className="mcaret"><IcCaret size={11} /></i>
              {menuOpen && (
                <div className="mmenu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
                  {models.length
                    ? models.map((m) => (
                      <div key={m} className={'mitem' + (m === data.model ? ' on' : '')}
                        onClick={() => { nodeUpdater(id, { model: m }); setMenuOpen(false) }}>
                        <ModelLogo model={m} size={15} />
                        <span className="mitem-name">{m}</span>
                      </div>
                    ))
                    : <div className="mitem dim">请先在设置中添加模型</div>}
                </div>
              )}
            </div>
            <div className="hf-sum-right">
              {data.lastCost ? <span className="price-pill"><IcBolt size={10} />{data.lastCost}</span> : null}
              <button className="pv-expand" title="放大预览"
                onClick={(e) => { e.stopPropagation(); nodeActions.preview(data.urls?.[0]) }}>
                <IcFit size={13} />
              </button>
            </div>
          </div>
          </>
          )}
          {/* 摘要行：分辨率 · 比例 · 批量/时长 + 状态徽标，静置不悬停也可见 */}
          <div className="hf-meta">
            <div className="hf-chips">
              {data.kind === 'audio' ? (
                <>
                  <span className="cap">{data.voice || 'alloy'}</span>
                  {data.seconds ? <span>{Number(data.seconds).toFixed(1)}s</span> : null}
                  <span>{String(data.format || 'mp3').toUpperCase()}</span>
                </>
              ) : data.kind === 'compose' ? (
                <>
                  <span className="cap">{!data.size || data.size === 'auto' ? '跟随原片' : data.size}</span>
                  {data.subtitles ? <span>字幕</span> : null}
                  {data.seconds ? <span>{Number(data.seconds).toFixed(1)}s</span> : null}
                </>
              ) : (
                <>
                  <span>{String(data.resolution || '').toLowerCase()}</span>
                  <span>{data.size}</span>
                  {/* 1.2.0：Kling-v4 的模式决定参考图语义，卡片上常驻显示 */}
                  {data.kind === 'video' && isKlingV4(data.model)
                    ? <span className="cap-mode">{KLING_MODE_LABEL[klingModeOf(data)]}</span>
                    : null}
                  {data.kind === 'image'
                    ? (data.n > 1 ? <span>×{data.n}</span> : null)
                    : <span>{data.duration}s</span>}
                </>
              )}
            </div>
            <span className={'hf-status ' + (data.status || 'idle')}>
              <i className="st-dot" />{STATUS_TEXT[data.status] || '待生成'}
            </span>
            {data.sourceLost && <span className="hf-lost" title="原链接已过期且本地无缓存，建议重新生成">源已失效</span>}
          </div>
        </div>
        )}
      </div>
      </div>
    </>
  )
}

/* Q1-1（REQ-004）节点工具条上的参考角色编辑器：
   与参数面板参考栏共用同一份 data.refRoles（键：本地=local:<i>，连线参考=上游 nodeId），双向同步 */
function RefRolesEditor({ id, data }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const edges = useStore((s) => s.edges)
  const nodes = useStore((s) => s.nodes)
  const items = useMemo(() => {
    const out = []
    ;(data.refImages || []).forEach((url, i) => out.push({ key: `local:${i}`, url, label: '本地上传' }))
    for (const e of edges) {
      if (e.target !== id || (e.targetHandle || '') !== 'in-img') continue
      const src = nodes.find((n) => n.id === e.source)
      const url = src?.data?.urls?.[0]
      if (!src || !url) continue
      out.push({ key: src.id, url, label: src.data?.label || src.id })
      if (out.length >= 4) break
    }
    return out
  }, [edges, nodes, data.refImages, id])
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])
  if (!items.length) return null
  const setRole = (key, role) => {
    const next = { ...(data.refRoles || {}) }
    if (role) next[key] = role
    else delete next[key]
    nodeUpdater(id, { refRoles: next })
  }
  return (
    <span className="tb-roles-wrap" ref={wrapRef}>
      <button className="tb-btn" title="参考角色：为主角 / 场景 / 产品 / 风格参考标注每张参考图"
        onClick={() => setOpen((v) => !v)}><IcImage size={14} /></button>
      {open && (
        <div className="tb-roles" onPointerDown={(e) => e.stopPropagation()}>
          <div className="tb-roles-head">参考角色</div>
          {items.map((it) => (
            <div key={it.key} className="tb-role-row">
              <span className="tb-role-thumb"><ThumbImg src={it.url} alt="" /></span>
              <span className="tb-role-name" title={it.label}>{it.label}</span>
              <RolePicker role={(data.refRoles || {})[it.key] || ''} compact onPick={(v) => setRole(it.key, v)} />
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

export function ImageNode({ id, data, selected }) {
  const models = useModels('image')
  const ratio = ratioOf(data)
  /* B-6：批量生成（n>1）的所有产物都存在 urls 里，卡上可翻看——
     默认显示第 1 张，缩略条点选切换，双击放大的是当前选中张 */
  const urls = data.urls || []
  const [batchIdx, setBatchIdx] = useState(0)
  const idx = Math.min(batchIdx, Math.max(0, urls.length - 1))
  const cur = urls[idx] || urls[0]
  return (
    <Card id={id} data={data} selected={selected} models={models}>
      <>
        <div
          className="hf-preview"
          style={{ aspectRatio: ratio }}
          onDoubleClick={() => cur && nodeActions.preview(cur)}
        >
          {cur
            // REF-002：卡片读缩略图（长边≤512 WebP），双击预览/下载仍走原图
            ? <ThumbImg src={cur} alt="" draggable={false} />
            : <EmptyGlyph kind="image" />}
          <StatusOverlay id={id} data={data} />
          {urls.length > 1 && (
            <div className="batch-strip" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              {urls.map((u, i) => (
                <button key={i} type="button" title={`第 ${i + 1} / ${urls.length} 张`}
                  className={'batch-thumb' + (i === idx ? ' on' : '')}
                  onDoubleClick={(e) => { e.stopPropagation(); nodeActions.preview(u) }}
                  onClick={(e) => { e.stopPropagation(); setBatchIdx(i) }}
                ><ThumbImg src={u} alt="" draggable={false} /></button>
              ))}
            </div>
          )}
        </div>
        {/* 挂点悬在卡片外侧：T / 参考图在左，输出在右，垂直居中 */}
        {/* 挂点悬在卡片外侧：T / 参考图在左，输出在右；上传素材卡只保留输出 */}
        {!data.uploaded && <Port type="target" position={Position.Left} top="calc(50% - 27px)" left={-33} id="in-text" nodeId={id}><IcText size={12} strokeWidth={2.6} /></Port>}
        {!data.uploaded && <Port type="target" position={Position.Left} top="calc(50% + 27px)" left={-33} id="in-img" nodeId={id}><IcImage size={12} strokeWidth={2.4} /></Port>}
        <Port type="source" position={Position.Right} top="50%" right={-33} id="out" nodeId={id}>{data.kind === 'video' ? <IcVideo size={12} strokeWidth={2.4} /> : <IcImage size={12} strokeWidth={2.4} />}</Port>
      </>
    </Card>
  )
}

export function VideoNode({ id, data, selected }) {
  const models = useModels('video')
  const ratio = ratioOf(data)
  return (
    <Card id={id} data={data} selected={selected} models={models}>
      <>
        <div
          className="hf-preview"
          style={{ aspectRatio: ratio }}
          onDoubleClick={() => data.urls?.[0] && nodeActions.preview(data.urls[0])}
        >
          {data.urls?.[0]
            ? <video src={data.urls[0]} controls loop muted />
            : <EmptyGlyph kind="video" />}
          <StatusOverlay id={id} data={data} />
        </div>
        {!data.uploaded && <Port type="target" position={Position.Left} top="calc(50% - 27px)" left={-33} id="in-text" nodeId={id}><IcText size={12} strokeWidth={2.6} /></Port>}
        {!data.uploaded && <Port type="target" position={Position.Left} top="calc(50% + 27px)" left={-33} id="in-img" nodeId={id}><IcImage size={12} strokeWidth={2.4} /></Port>}
        <Port type="source" position={Position.Right} top="50%" right={-33} id="out" nodeId={id}>{data.kind === 'video' ? <IcVideo size={12} strokeWidth={2.4} /> : <IcImage size={12} strokeWidth={2.4} />}</Port>
      </>
    </Card>
  )
}

/* ---------- P2 音频/配音节点：文本 → TTS 语音，卡片内直接试听 ----------
   产物为本地 mp3 资产（file://），可单独作为旁白交付，也是后续合成口播的声轨来源。
   注意：网关没有音频托管端点，音频不能反向作为参考音频送视频模型（面板会说明）。 */
export function AudioNode({ id, data, selected }) {
  const models = useModels('audio')
  return (
    <Card id={id} data={data} selected={selected} models={models} placeholder="输入要配音的台词…">
      <>
        <div className="audio-body" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          {data.urls?.[0]
            ? (
              <audio className="audio-player" src={data.urls[0]} controls preload="metadata"
                onDoubleClick={() => nodeActions.preview(data.urls[0])} />
            )
            : <EmptyGlyph kind="audio" />}
          <StatusOverlay id={id} data={data} />
        </div>
        {!data.uploaded && <Port type="target" position={Position.Left} top="calc(50% - 27px)" left={-33} id="in-text" nodeId={id}><IcText size={12} strokeWidth={2.6} /></Port>}
        <Port type="source" position={Position.Right} top="50%" right={-33} id="out" nodeId={id}><IcAudio size={12} strokeWidth={2.4} /></Port>
      </>
    </Card>
  )
}

/* ---------- 提示词文本节点：右侧 T 输出挂点，可连图片/视频卡片的 T 输入 ---------- */
export function TextNode({ id, data, selected }) {
  const taRef = useRef(null)
  const textInput = useDraftInput(data.text, (v) => nodeUpdater(id, { text: v }))
  /* C-4：随内容自动增高，直到接近画布高度的 62%（贴边留白），超出后改为内部滚动 */
  const autoGrow = (el) => {
    if (!el) return
    const pane = document.querySelector('.react-flow')
    const maxH = Math.max(180, Math.round((pane?.clientHeight || window.innerHeight) * 0.62))
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px'
  }
  useEffect(() => { autoGrow(taRef.current) }, [data.text])
  return (
    <div className="node-wrap" style={{ width: 250 }}>
      {/* 选中时工具条：复制 / 锁定 / 删除（文本节点无内容可下载，故省去下载） */}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={10} className="node-toolbar">
        <button className="tb-btn" title="复制节点" onClick={() => nodeActions.duplicate()}><IcCopy size={14} /></button>
        <button className="tb-btn" title={data.locked ? '解锁节点' : '锁定节点'}
          onClick={() => nodeUpdater(id, { locked: !data.locked })}>
          {data.locked ? <IcUnlock size={14} /> : <IcLock size={14} />}
        </button>
        <span className="tb-sep" />
        <button className="tb-btn danger" title="删除节点" onClick={() => nodeActions.remove()}><IcTrash size={14} /></button>
      </NodeToolbar>
      <div className="node-label">{data.label}{data.locked ? <IcLock size={10} className="lock-flag" /> : null}</div>
      <div className={'hfnode tnode' + (selected ? ' sel' : '') + (data.locked ? ' locked' : '')}>
        <textarea
          ref={taRef}
          className="tnode-ta nodrag nowheel"
          placeholder="输入提示词…"
          rows={3}
          {...textInput}
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          readOnly={!!data.locked}
        />
        <Port type="source" position={Position.Right} top="45%" right={-33} id="out" nodeId={id}><IcText size={12} strokeWidth={2.6} /></Port>
      </div>
    </div>
  )
}

/* ---------- P3 成片合成节点：两个输入挂点（视频 in-video / 配音 in-audio），一个输出 ---------- */
export function ComposeNode({ id, data, selected }) {
  const ratio = ratioOf({ ...data, kind: 'video' })
  return (
    <Card id={id} data={data} selected={selected} models={[]}>
      <>
        <div
          className="hf-preview"
          style={{ aspectRatio: ratio }}
          onDoubleClick={() => data.urls?.[0] && nodeActions.preview(data.urls[0])}
        >
          {data.urls?.[0]
            ? <video src={data.urls[0]} controls loop muted />
            : <EmptyGlyph kind="compose" />}
          <StatusOverlay id={id} data={data} />
        </div>
        <Port type="target" position={Position.Left} top="calc(50% - 27px)" left={-33} id="in-video" nodeId={id}><IcVideo size={12} strokeWidth={2.4} /></Port>
        <Port type="target" position={Position.Left} top="calc(50% + 27px)" left={-33} id="in-audio" nodeId={id}><IcAudio size={12} strokeWidth={2.4} /></Port>
        <Port type="source" position={Position.Right} top="50%" right={-33} id="out" nodeId={id}><IcComposeGlyph size={12} strokeWidth={2.4} /></Port>
      </>
    </Card>
  )
}

export const nodeTypes = { image: ImageNode, video: VideoNode, text: TextNode, audio: AudioNode, compose: ComposeNode }

/* ---------- 连线：悬停时“移除连接”按钮跟随鼠标，点击断开 ---------- */
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }) {
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState(null)
  const keepRef = useRef(false)
  const { screenToFlowPosition } = useReactFlow()
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const track = (e) => setPos(screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  const hideLater = () => setTimeout(() => { if (!keepRef.current) setHover(false) }, 90)
  return (
    <>
      <BaseEdge id={id} path={path} />
      {/* 自带宽交互路径：BaseEdge 把事件绑在 1px 可见线上收不到，这里独立渲染 24px 命中区 */}
      <path
        className="react-flow__edge-interaction"
        d={path} fill="none" stroke="transparent" strokeOpacity={0} strokeWidth={24}
        onMouseEnter={(e) => { keepRef.current = false; track(e); setHover(true) }}
        onMouseMove={track}
        onMouseLeave={hideLater}
      />
      <EdgeLabelRenderer>
        {hover && pos && (
          <div
            className="edge-remove-wrap"
            style={{ transform: `translate(${pos.x}px,${pos.y}px) translate(-50%, calc(-100% + 11px))` }}
            onMouseEnter={() => { keepRef.current = true }}
            onMouseLeave={() => { keepRef.current = false; setHover(false) }}
          >
            <div className="edge-tip">移除连接</div>
            <button
              className="edge-remove" title="移除连接"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); nodeActions.removeEdge(id) }}
            ><IcClose size={12} /></button>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  )
}

export const edgeTypes = { flow: FlowEdge }

export function makeTextNode(pos) {
  return {
    type: 'text',
    position: pos,
    data: { kind: 'text', label: '提示词', text: '', status: 'idle', progress: 0, urls: [], lastCost: 0, cost: '', error: '' }
  }
}

/* REF-006：新建节点取设置里的生成偏好默认值，单节点之后可自行覆盖
   Q1-2 REF-008：prefs.model 取该分类默认模型（调用方已做回落，空串=保持未选） */
export function makeImageNode(pos, prefs = {}) {
  const p = { resolution: '2K', size: '1:1', n: 1, model: '', ...(prefs || {}) }
  return {
    type: 'image',
    position: pos,
    data: {
      kind: 'image', label: '图片生成', prompt: '', model: p.model || '',
      size: p.size, resolution: p.resolution, n: p.n, refImages: [],
      status: 'idle', progress: 0, urls: [], lastCost: 0, cost: '', error: '',
      cardWidth: 340
    }
  }
}

export function makeVideoNode(pos, prefs = {}) {
  const p = { resolution: '720p', size: '16:9', duration: 5, model: '', ...(prefs || {}) }
  return {
    type: 'video',
    position: pos,
    data: {
      kind: 'video', label: '视频生成', prompt: '', model: p.model || '',
      size: p.size, resolution: p.resolution, duration: p.duration, audio: true, refImages: [],
      /* 1.2.0：Kling-v4 模式。旧节点没有该字段时按 frames 处理（见 lib/klingVideo.js） */
      klingMode: 'frames', refAudioUrl: '',
      status: 'idle', progress: 0, urls: [], lastCost: 0, cost: '', error: '',
      cardWidth: cardWidthFor('video', p.size) // 高度对齐图片 1:1 卡片，宽度等比
    }
  }
}

/* P2：配音节点。台词写在 prompt 里，音色/语速/格式走 TTS 参数 */
export function makeComposeNode(pos, prefs = {}) {
  return {
    type: 'compose',
    position: pos,
    data: {
      kind: 'compose', label: '成片合成', prompt: '', model: '',
      size: prefs.size || 'auto', subtitles: false, keepOriginalSound: false, loopAudio: true,
      seconds: 0, composeSummary: '',
      status: 'idle', progress: 0, urls: [], lastCost: 0, cost: '', error: '',
      cardWidth: 360
    }
  }
}

export function makeAudioNode(pos) {
  return {
    type: 'audio',
    position: pos,
    data: {
      kind: 'audio', label: '配音', prompt: '', model: 'gpt-4o-mini-tts',
      voice: 'alloy', speed: 1, format: 'mp3', seconds: 0,
      status: 'idle', progress: 0, urls: [], lastCost: 0, cost: '', error: '',
      cardWidth: 340
    }
  }
}

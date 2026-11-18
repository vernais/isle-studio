import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  IcSettings, IcClose, IcPlus, IcTrash, IcImage, IcVideo, IcSparkle, IcRefresh, IcCheck,
  IcSearch, IcAlert, IcSliders, IcFolder, IcMinus, IcExternal
} from './icons.jsx'
import { classifyModel, mergeCatalog, CAT_META } from './modelCatalog.js'

const CATS = [
  { key: 'image', name: '图片模型', short: '图片', Icon: IcImage },
  { key: 'video', name: '视频模型', short: '视频', Icon: IcVideo },
  { key: 'chat', name: 'Agent 模型', short: 'Agent', Icon: IcSparkle }
]
const CAT_ORDER = CATS.map((c) => c.key)
const EMPTY_MODELS = { image: [], video: [], chat: [] }

/* REF-007：设置分区。每区职责单一，共用同一份草稿态（切 Tab 不丢修改） */
const TABS = [
  { key: 'api', name: '接口', Icon: IcSettings },
  { key: 'gen', name: '生成偏好', Icon: IcSliders },
  { key: 'data', name: '数据', Icon: IcFolder },
  { key: 'isle', name: 'Isle', Icon: IcSparkle }
]

const IMG_RES = ['1K', '2K', '4K']
const VID_RES = ['480p', '720p', '1080p', '4k']
const SIZES = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9', '4:5', '5:4']

const GEN_DEFAULT = {
  image: { resolution: '2K', size: '1:1', n: 1 },
  video: { resolution: '720p', size: '16:9', duration: 5 },
  regenerate: 'new'
}
const genOf = (v) => ({
  image: { ...GEN_DEFAULT.image, ...(v?.generation?.image || {}) },
  video: { ...GEN_DEFAULT.video, ...(v?.generation?.video || {}) },
  regenerate: v?.generation?.regenerate === 'inplace' ? 'inplace' : 'new'
})

/* 判脏只看「会被保存的字段」，避免 catalog 临时态误报未保存 */
const snapOf = (v) => JSON.stringify({
  apiKey: v?.apiKey || '',
  baseUrl: v?.baseUrl || '',
  outputDir: v?.outputDir || '',
  autoRunAgent: !!v?.autoRunAgent,
  models: v?.models || EMPTY_MODELS,
  modelKeys: v?.modelKeys || {},
  catalog: v?.catalog || [],
  catalogBase: v?.catalogBase || '',
  generation: genOf(v),
  defaultModels: v?.defaultModels || { image: '', video: '', chat: '' },
  personaNote: v?.personaNote || '',
  agentSlogan: v?.agentSlogan || ''
})

/* 分段按钮组（设置页通用） */
function Seg({ value, options, onChange, label }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.v}
          className={value === o.v ? 'on' : ''}
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
        >{o.name}</button>
      ))}
    </div>
  )
}

/* 设置行：标签在上，控件在下（与参数面板同语汇） */
function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

function NumStepper({ value, min, max, onChange, suffix = '' }) {
  return (
    <div className="stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))}><IcMinus size={12} /></button>
      <span>{value}{suffix}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))}><IcPlus size={12} /></button>
    </div>
  )
}

export default function SettingsModal({ open, onClose, initialTab = null, sessionKey = 'global' }) {
  const [s, setS] = useState(null)
  const [orig, setOrig] = useState('')          // 打开时的快照（判脏基准）
  const [tab, setTab] = useState('api')         // REF-007 分区
  /* S16-2：initialTab 只在「打开那一刻」生效（手动打开传 null → 保留上次 Tab 记忆） */
  const initialTabRef = useRef(initialTab)
  initialTabRef.current = initialTab
  const [cat, setCat] = useState('image')       // 接口 Tab 内的模型分类
  const [catalog, setCatalog] = useState([])    // [{ id, cat }]
  const [q, setQ] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState(null)          // { kind, text }
  const [saved, setSaved] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [keyShown, setKeyShown] = useState(false) // IR-005：全站 Key 默认掩码，显示/隐藏切换
  const [askLeave, setAskLeave] = useState(false) // 有未保存修改时关闭确认
  const [draft, setDraft] = useState({ model: '', baseUrl: 'https://api.apib.ai', apiKey: '' })
  const [memEntries, setMemEntries] = useState([]) // S20-3：项目记忆（独立于设置保存，操作即时生效）
  const [memKey, setMemKey] = useState('')         // 当前记忆列表对应的 key（防切项目串列表）

  useEffect(() => {
    if (!open || tab !== 'isle') return
    let cancelled = false
    window.flow.memoryLoad?.({ key: sessionKey })?.then?.((r) => {
      if (!cancelled) { setMemEntries(Array.isArray(r?.entries) ? r.entries : []); setMemKey(sessionKey) }
    })?.catch?.(() => {})
    return () => { cancelled = true }
  }, [open, tab, sessionKey])

  const memDelete = async (i) => {
    try { await window.flow.memoryDelete?.({ key: memKey, index: i }) } catch { }
    const r = await window.flow.memoryLoad?.({ key: memKey })?.catch?.(() => null)
    setMemEntries(Array.isArray(r?.entries) ? r.entries : [])
  }
  const memClear = async () => {
    try { await window.flow.memoryClear?.({ key: memKey }) } catch { }
    setMemEntries([])
  }

  /* ---------- S21-1/2：存储占用 + 配置导入导出 ---------- */
  const [usage, setUsage] = useState(null)
  const [clearingThumbs, setClearingThumbs] = useState(false)
  const [askIncludeKey, setAskIncludeKey] = useState(false) // 含 Key 导出的二次确认
  const fmtSize = (n) => {
    if (!n) return '0 B'
    if (n < 1024) return n + ' B'
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
    return (n / 1073741824).toFixed(2) + ' GB'
  }
  const refreshUsage = () => {
    window.flow.storageUsage?.()?.then?.((r) => setUsage(r?.ok ? r.usage : null))?.catch?.(() => {})
  }
  /* 数据位置（v1.1.3）：程序与用户数据分离，指针文件决定数据在哪 */
  const [dh, setDh] = useState(null)
  const [dhBusy, setDhBusy] = useState(false)
  const refreshDataHome = () => {
    window.flow.dataHomeInfo?.()?.then?.((r) => setDh(r?.ok ? r : null))?.catch?.(() => {})
  }
  const relocateData = async () => {
    const dir = await window.flow.dataHomePick?.()
    if (!dir) return
    setDhBusy(true)
    try {
      const r = await window.flow.dataHomeRelocate?.(dir)
      if (r?.ok) {
        setMsg({ kind: 'storage', text: `已搬到 ${r.to}（${r.copied?.files || 0} 个文件），应用即将重启` })
      } else if (!r?.canceled) {
        setMsg({ kind: 'storage', text: '搬家失败：' + (r?.error || '未知错误') })
      }
    } catch (err) {
      setMsg({ kind: 'storage', text: '搬家失败：' + String(err?.message || err).slice(0, 120) })
    } finally { setDhBusy(false) }
  }
  useEffect(() => {
    if (!open || tab !== 'data') return
    refreshUsage()
    refreshDataHome()
  }, [open, tab])
  const clearThumbs = async () => {
    setClearingThumbs(true)
    try {
      const r = await window.flow.storageClearThumbs?.()
      if (r?.ok) {
        setMsg({ kind: 'storage', text: `已清理缩略图缓存（释放 ${(r.freed / 1048576).toFixed(1)} MB），打开画廊时自动重建` })
        refreshUsage()
      } else setMsg({ kind: 'storage', text: '清理失败：' + (r?.error || '未知错误') })
    } catch { } finally { setClearingThumbs(false) }
  }
  const exportConfig = async (includeKeys = false) => {
    try {
      const r = await window.flow.configExportFile?.({ includeKeys })
      if (r?.ok) setMsg({ kind: 'storage', text: `已导出到 ${r.file}${includeKeys ? '（含明文 Key，注意保管）' : '（Key 已脱敏）'}` })
      else if (!r?.canceled) setMsg({ kind: 'storage', text: '导出失败：' + (r?.error || '未知错误') })
    } catch { }
  }
  const importConfig = async (overwrite = false) => {
    try {
      const r = await window.flow.configImportFile?.({ overwrite })
      if (r?.ok) {
        setMsg({ kind: 'storage', text: `导入完成：新增 ${r.added} 项、跳过 ${r.skipped} 项、覆盖 ${r.overwritten} 项。重启应用后全部生效；跨机器导入的 Key 若解密异常，请在「接口」页重新保存` })
        window.flow.getSettings().then((v) => { setS(v); setOrig(snapOf(v)) }).catch(() => {})
      } else if (!r?.canceled) setMsg({ kind: 'storage', text: '导入失败：' + (r?.error || '未知错误') })
    } catch { }
  }

  useEffect(() => {
    if (!open) return
    /* S16-2：引导打开时强制落到指定 Tab；手动打开保持上次停留位置 */
    if (initialTabRef.current) setTab(initialTabRef.current)
    window.flow.getSettings().then((v) => {
      setS(v)
      setOrig(snapOf(v))
      setKeyShown(false) // 每次打开设置重新回到掩码态
      setCatalog(Array.isArray(v.catalog) ? v.catalog : [])
      setDraft((d) => ({ ...d, baseUrl: v.baseUrl || d.baseUrl }))
      setMsg(Array.isArray(v.catalog) && v.catalog.length
        ? { kind: 'info', text: `上次拉取：${v.catalog.length} 个模型${v.catalogBase ? '（' + v.catalogBase + '）' : ''}` }
        : null)
    })
    setSaved(false)
    setQ('')
    setAskLeave(false)
  }, [open])

  const models = s?.models || EMPTY_MODELS
  const gen = genOf(s)
  const selectedOf = (c) => models?.[c] || []

  const candidates = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return catalog
      .filter((m) => m.cat === cat)
      .filter((m) => !kw || m.id.toLowerCase().includes(kw))
      .filter((m) => !selectedOf(cat).some((x) => x.model === m.id))
  }, [catalog, cat, q, s])

  if (!open || !s) return null

  const dirty = snapOf(s) !== orig

  /* 关闭入口统一走这里：有未保存修改先问一句，避免「调了半天参数被 Esc 吃掉」 */
  const requestClose = () => { if (dirty) setAskLeave(true); else onClose() }

  /* 拉取全站模型列表 */
  const sync = async () => {
    setSyncing(true)
    setMsg({ kind: 'info', text: '正在从 APIMart 拉取模型列表…' })
    const r = await window.flow.modelsSync({ apiKey: s.apiKey, baseUrl: s.baseUrl })
    setSyncing(false)
    if (!r.ok) { setMsg({ kind: 'err', text: r.error }); return }
    // BUG-1：拉取成功后按分类给出分布计数。模型名五花八门，自动分类可能把新模型
    // 全归到某一类；用户若只看当前分类发现列表「没有模型名」，需要能自诊自救。
    const merged = mergeCatalog(catalog, r.models)
    const dist = { image: 0, video: 0, chat: 0 }
    merged.forEach((m) => { dist[m.cat] = (dist[m.cat] || 0) + 1 })
    setCatalog(merged)
    setS((cur) => ({ ...cur, catalogBase: r.base }))
    setMsg({
      kind: 'ok',
      text: `已拉取 ${r.models.length} 个模型：图片 ${dist.image} / 视频 ${dist.video} / Isle ${dist.chat}（来源 ${r.base}）。某个分类下没看到想要的模型时，先切到其他分类找，或在行内下拉里改分类；分类错了不影响手动勾选`
    })
  }

  const isSelIn = (c, id) => selectedOf(c).some((m) => m.model === id)

  /* 取该模型已知的独立 Key（取消再勾选时不丢 key），否则用全站 Key */
  const keyFor = (id, cur) => (cur.modelKeys || {})[id] || cur.apiKey || ''

  /* 勾选 / 取消（跨分类唯一：勾上即从其他分类移走） */
  const toggle = (id, c) => {
    setS((cur) => {
      const m = { ...EMPTY_MODELS, ...(cur.models || {}) }
      const adding = !(m[c] || []).some((x) => x.model === id)
      for (const k of CAT_ORDER) m[k] = (m[k] || []).filter((x) => x.model !== id)
      if (adding) {
        m[c] = [...(m[c] || []), { model: id, baseUrl: cur.baseUrl || 'https://api.apib.ai', apiKey: keyFor(id, cur) }]
      }
      return { ...cur, models: m }
    })
  }

  /* Q1-2：行内下拉直改分类（替换循环 chip）。跨分类唯一：搬走时从所有分类移除，仅保留目标分类 */
  const setCatOf = (id, next) => {
    setCatalog((prev) => prev.map((x) => (x.id === id ? { ...x, cat: next } : x)))
    setS((cur) => {
      const m = { ...EMPTY_MODELS, ...(cur.models || {}) }
      let entry = null
      for (const k of CAT_ORDER) {
        const hit = (m[k] || []).find((x) => x.model === id)
        if (hit) { entry = hit; m[k] = (m[k] || []).filter((x) => x.model !== id) }
      }
      if (entry) m[next] = [...(m[next] || []), entry]
      return { ...cur, models: m }
    })
  }

  const selectAllVisible = () => {
    setS((cur) => {
      const m = { ...EMPTY_MODELS, ...(cur.models || {}) }
      const add = candidates
        .filter((c) => !(m[cat] || []).some((x) => x.model === c.id))
        .map((c) => ({ model: c.id, baseUrl: cur.baseUrl || 'https://api.apib.ai', apiKey: keyFor(c.id, cur) }))
      m[cat] = [...(m[cat] || []), ...add]
      return { ...cur, models: m }
    })
  }

  const clearTab = () => setS((cur) => ({ ...cur, models: { ...EMPTY_MODELS, ...(cur.models || {}), [cat]: [] } }))

  /* REF-008：默认模型下拉的当前值——默认值已不在该分类已启用列表里时显示「自动」，消费端会回落首个可用 */
  const defModelOf = (c) => {
    const d = (s.defaultModels || {})[c] || ''
    return selectedOf(c).some((m) => m.model === d) ? d : ''
  }
  const setDefModel = (c, id) =>
    setS((cur) => ({ ...cur, defaultModels: { ...(cur.defaultModels || {}), [c]: id } }))

  const removeModel = (c, i) => {
    setS((cur) => {
      const m = { ...EMPTY_MODELS, ...(cur.models || {}) }
      m[c] = (m[c] || []).filter((_, j) => j !== i)
      return { ...cur, models: m }
    })
  }

  const addManual = () => {
    const name = draft.model.trim()
    if (!name) return
    setS((cur) => {
      const m = { ...EMPTY_MODELS, ...(cur.models || {}) }
      if ((m[cat] || []).some((x) => x.model === name)) return cur
      m[cat] = [...(m[cat] || []), {
        model: name,
        baseUrl: draft.baseUrl.trim() || cur.baseUrl || 'https://api.apib.ai',
        apiKey: draft.apiKey.trim() || cur.apiKey || ''
      }]
      return { ...cur, models: m }
    })
    setDraft({ ...draft, model: '', apiKey: '' })
  }

  const setGen = (kind, patch) => setS((cur) => ({
    ...cur,
    generation: { ...genOf(cur), [kind]: { ...genOf(cur)[kind], ...patch } }
  }))

  const save = async () => {
    const out = {}
    const modelKeys = { ...(s.modelKeys || {}) }
    for (const k of CAT_ORDER) {
      out[k] = (models[k] || []).map((m) => ({
        ...m,
        apiKey: (m.apiKey || '').trim() || s.apiKey || '',
        baseUrl: m.baseUrl || s.baseUrl || 'https://api.apib.ai'
      }))
      for (const m of out[k]) if (m.apiKey && m.apiKey !== s.apiKey) modelKeys[m.model] = m.apiKey
    }
    const payload = {
      apiKey: s.apiKey,
      baseUrl: s.baseUrl,
      outputDir: s.outputDir,
      autoRunAgent: !!s.autoRunAgent,
      models: out,
      modelKeys,
      catalog,
      catalogBase: s.catalogBase || '',
      generation: genOf(s),
      defaultModels: s.defaultModels || { image: '', video: '', chat: '' },
      personaNote: (s.personaNote || '').slice(0, 2000),
      agentSlogan: (s.agentSlogan || '').slice(0, 200)
    }
    await window.flow.setSettings(payload)
    setOrig(snapOf({ ...s, models: out, modelKeys }))
    setSaved(true)
    window.dispatchEvent(new CustomEvent('settings:saved'))
    setTimeout(onClose, 500)
  }

  const total = CAT_ORDER.reduce((n, k) => n + (models[k] || []).length, 0)
  const catMeta = CAT_META[cat]

  return (
    <div className="modal-mask" onClick={requestClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="panel-title"><IcSettings size={15} /> 设置</span>
          <button className="icon-btn" onClick={requestClose} aria-label="关闭设置"><IcClose size={15} /></button>
        </div>

        {/* REF-007 分区导航 */}
        <div className="set-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key} role="tab" aria-selected={tab === t.key}
              className={'set-tab' + (tab === t.key ? ' on' : '')}
              onClick={() => setTab(t.key)}
            ><t.Icon size={13} /> {t.name}</button>
          ))}
        </div>

        {/* S16-2：无模型常驻提示条——先讲清「为什么不能生成」，再给一个直达入口 */}
        {total === 0 && (
          <div className="set-empty-tip">
            <IcAlert size={13} />
            <span>尚未配置任何模型，配置后才能生成</span>
            <button type="button" className="set-empty-go" onClick={() => setTab('api')}>去配置</button>
          </div>
        )}

        <div className="set-body">
          {/* ---------------- 接口 ---------------- */}
          {tab === 'api' && (
            <>
              <div className="mkey">
                <div className="mkey-label">全站 API Key<span>填一个能调用全站模型的 Key，拉取后勾选要用的</span></div>
                <div className="mkey-row">
                  {(() => {
                    // IR-005：默认掩码（sk-dchC••••••••），「显示」切换为明文可编辑，「隐藏」收回
                    const key = s.apiKey || ''
                    const masked = key.length > 10 ? key.slice(0, 7) + '••••••••' : (key ? '••••••••' : '')
                    if (!keyShown && key) {
                      return (
                        <>
                          <input type="text" readOnly value={masked} title="已加密保存；点「显示」查看完整 Key" aria-label="API Key（掩码）" />
                          <button className="ghost-btn" style={{ width: 'auto', padding: '9px 12px' }} onClick={() => setKeyShown(true)}>显示</button>
                        </>
                      )
                    }
                    return (
                      <>
                        <input
                          type="text"
                          spellCheck={false}
                          placeholder={keyShown ? '粘贴新的全站 API Key（覆盖旧值）' : '粘贴全站 API Key，如 sk-...'}
                          value={s.apiKey || ''}
                          onChange={(e) => setS({ ...s, apiKey: e.target.value.trim() })}
                        />
                        {key && <button className="ghost-btn" style={{ width: 'auto', padding: '9px 12px' }} onClick={() => setKeyShown(false)}>隐藏</button>}
                      </>
                    )
                  })()}
                  <button className="primary-btn small" onClick={sync} disabled={syncing}>
                    <IcRefresh size={13} className={syncing ? 'spin' : ''} /> {syncing ? '拉取中…' : '拉取模型'}
                  </button>
                </div>
                <div className="mkey-row">
                  <input
                    placeholder="API 地址"
                    value={s.baseUrl || ''}
                    onChange={(e) => setS({ ...s, baseUrl: e.target.value })}
                  />
                  <span className="mkey-total">已启用 {total}</span>
                </div>
                {msg && (
                  <div className={'msync-msg ' + msg.kind}>
                    {msg.kind === 'err' ? <IcAlert size={12} /> : <IcCheck size={12} />} {msg.text}
                  </div>
                )}
              </div>

              {/* 分类标签 */}
              <div className="tabs">
                {CATS.map((c) => (
                  <button key={c.key} className={'tab' + (cat === c.key ? ' on' : '')} onClick={() => setCat(c.key)}>
                    <c.Icon size={13} /> {c.name} <span className="tab-count">{(models[c.key] || []).length}</span>
                  </button>
                ))}
              </div>

              {/* 已选 */}
              <div className="mlib-block">
                <div className="mlib-head">
                  <span>已启用 · {catMeta.full}</span>
                  <button className="mlib-link" onClick={clearTab} disabled={!selectedOf(cat).length}>清空</button>
                </div>
                <div className="model-list">
                  {selectedOf(cat).length === 0 && <div className="hint" style={{ padding: '4px 2px' }}>还没有启用任何{catMeta.short}模型</div>}
                  {selectedOf(cat).map((m, i) => (
                    <div key={m.model} className="model-row on">
                      <span className="mrow-check"><IcCheck size={11} /></span>
                      <div className="model-info">
                        <b>{m.model}</b>
                        <span className="model-url">{(m.apiKey ? '独立 Key' : '全站 Key')} · {m.baseUrl}</span>
                      </div>
                      <button className="icon-btn" title="移除" onClick={() => removeModel(cat, i)}><IcTrash size={13} /></button>
                    </div>
                  ))}
                </div>
                              {/* Q1-2 REF-008：每分类默认模型，新建节点预选；置空或模型被删时回落该分类首个可用 */}
                <div className="def-model">
                  <span className="field-label">默认{CATS.find((c) => c.key === cat)?.short || ''}模型</span>
                  <select
                    aria-label={`默认${CATS.find((c) => c.key === cat)?.short || ''}模型`}
                    value={defModelOf(cat)}
                    disabled={!selectedOf(cat).length}
                    onChange={(e) => setDefModel(cat, e.target.value)}
                  >
                    <option value="">自动（首个可用）</option>
                    {selectedOf(cat).map((m) => <option key={m.model} value={m.model}>{m.model}</option>)}
                  </select>
                  <span className="hint">新建{CATS.find((c) => c.key === cat)?.short || ''}节点预选此模型；模型被删或置空时自动落到首个可用</span>
                </div>
              </div>

              {/* 可选（来自拉取结果） */}
              <div className="mlib-block">
                <div className="mlib-head">
                  <span>可添加 · {catMeta.full}（{candidates.length}）</span>
                  <div className="mlib-acts">
                    <button className="mlib-link" onClick={selectAllVisible} disabled={!candidates.length}>全选可见</button>
                  </div>
                </div>
                <div className="msearch">
                  <IcSearch size={13} />
                  <input placeholder="搜索模型名，如 seedream / veo / claude" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <div className="cand-list">
                  {!catalog.length && (
                    <div className="hint" style={{ padding: '8px 2px' }}>
                      点上方「拉取模型」从 APIMart 获取全部可用模型，再勾选需要的
                    </div>
                  )}
                  {catalog.length > 0 && candidates.length === 0 && (
                    <div className="hint" style={{ padding: '8px 2px' }}>
                      {q
                        ? '没有匹配的模型'
                        : selectedOf(cat).length
                          ? '此类别的模型都已启用'
                          : '此分类下没有自动识别到的模型——切到其他分类查看，或用行内下拉改分类'}
                    </div>
                  )}
                  {candidates.map((c) => (
                    <div key={c.id} className="cand-row">
                      <button className="cand-check" onClick={() => toggle(c.id, cat)} title="启用"><IcPlus size={12} /></button>
                      <span className="cand-name" title={c.id}>{c.id}</span>
                      <select
                        className={'cat-select cat-' + c.cat}
                        value={c.cat}
                        title="选择分类"
                        aria-label={`模型 ${c.id} 的分类`}
                        onChange={(e) => setCatOf(c.id, e.target.value)}
                      >
                        {CATS.map((cc) => <option key={cc.key} value={cc.key}>{cc.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              {/* 手动添加 */}
              <div className="manual">
                <button className="manual-toggle" onClick={() => setManualOpen((v) => !v)}>
                  <IcPlus size={12} /> 手动添加单个模型（不同 Key / 自建网关）
                </button>
                {manualOpen && (
                  <div className="add-form" style={{ marginTop: 8 }}>
                    <div className="add-grid">
                      <input placeholder="模型名称，如 gpt-image-2" value={draft.model}
                        onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
                      <input placeholder="API 地址，如 https://api.apimart.ai" value={draft.baseUrl}
                        onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
                      <input type="password" placeholder="API Key（留空用全站 Key）" value={draft.apiKey}
                        onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
                      <button className="tool-btn" onClick={addManual}>添加到{catMeta.short}</button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ---------------- 生成偏好 ---------------- */}
          {tab === 'gen' && (
            <div className="gen-prefs">
              <div className="set-group">
                <div className="set-group-title">图片默认值</div>
                <div className="set-grid">
                  <Field label="分辨率">
                    <select aria-label="默认图片分辨率" value={gen.image.resolution}
                      onChange={(e) => setGen('image', { resolution: e.target.value })}>
                      {IMG_RES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </Field>
                  <Field label="画面比例">
                    <select aria-label="默认图片比例" value={gen.image.size}
                      onChange={(e) => setGen('image', { size: e.target.value })}>
                      {SIZES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </Field>
                  <Field label="出图数量">
                    <NumStepper value={gen.image.n} min={1} max={4}
                      onChange={(v) => setGen('image', { n: v })} suffix=" 张" />
                  </Field>
                </div>
                <span className="hint">新建图片节点默认用这组参数；单个节点仍可在右侧面板单独改</span>
              </div>

              <div className="set-group">
                <div className="set-group-title">视频默认值</div>
                <div className="set-grid">
                  <Field label="清晰度">
                    <select aria-label="默认视频清晰度" value={gen.video.resolution}
                      onChange={(e) => setGen('video', { resolution: e.target.value })}>
                      {VID_RES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </Field>
                  <Field label="画面比例">
                    <select aria-label="默认视频比例" value={gen.video.size}
                      onChange={(e) => setGen('video', { size: e.target.value })}>
                      {SIZES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </Field>
                  <Field label="时长">
                    <NumStepper value={gen.video.duration} min={4} max={15}
                      onChange={(v) => setGen('video', { duration: v })} suffix=" 秒" />
                  </Field>
                </div>
              </div>

              <div className="set-group">
                <div className="set-group-title">已有内容的节点再次生成时</div>
                <Seg
                  label="再生成行为"
                  value={gen.regenerate}
                  options={[{ v: 'new', name: '新建节点' }, { v: 'inplace', name: '原地覆盖' }]}
                  onChange={(v) => setS((cur) => ({ ...cur, generation: { ...genOf(cur), regenerate: v } }))}
                />
                <span className="hint">
                  {gen.regenerate === 'inplace'
                    ? '原地覆盖：产物直接替换该节点的图片（旧图不会作为参考图）'
                    : '新建节点：生成结果落在新卡片上，原节点保持不变'}
                </span>
              </div>

              <div className="set-group">
                <div className="set-group-title">Isle 免审直跑</div>
                <Seg
                  label="Isle 免审直跑"
                  value={!!s.autoRunAgent}
                  options={[{ v: true, name: '开' }, { v: false, name: '关' }]}
                  onChange={(v) => setS({ ...s, autoRunAgent: v })}
                />
                <span className="hint">默认关：Isle 每次生成前会弹审批卡请你确认；开启后跳过审批直接运行（会消耗积分）</span>
              </div>
            </div>
          )}

          {/* ---------------- 数据 ---------------- */}
          {tab === 'data' && (
            <div className="gen-prefs">
              {/* 数据位置：程序与数据分离，升级只换程序 */}
              <div className="set-group">
                <div className="set-group-title">数据位置</div>
                <div className="dh-path" title={dh?.dir || ''}>
                  <IcFolder size={13} />
                  <span>{dh?.dir || '读取中…'}</span>
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="ghost-btn" style={{ width: 'auto', padding: '8px 12px' }}
                    disabled={dhBusy} onClick={relocateData}>
                    <IcExternal size={13} /> {dhBusy ? '正在搬家…' : '更改位置'}
                  </button>
                  <button className="ghost-btn" style={{ width: 'auto', padding: '8px 12px' }}
                    onClick={() => window.flow.openDataDir()}>
                    <IcFolder size={13} /> 打开文件夹
                  </button>
                </div>
                <span className="hint">
                  项目、生成物、资产库、模板与 API Key 全部存在这里；安装目录只有程序文件，
                  覆盖安装/升级新版本不会动它们。更改位置会把整份数据复制到新盘并校验，完成后自动重启，旧目录核心数据保留。
                </span>
              </div>

              <div className="set-group">
                <div className="set-group-title">生成结果保存目录</div>
                <div className="row">
                  <input value={s.outputDir || ''} placeholder="默认：图片文件夹/IsleStudio"
                    onChange={(e) => setS({ ...s, outputDir: e.target.value })} />
                  <button className="ghost-btn" style={{ width: 'auto', padding: '9px 14px' }} onClick={async () => {
                    const d = await window.flow.pickOutputDir()
                    if (d) setS({ ...s, outputDir: d })
                  }}>选择</button>
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="ghost-btn" style={{ width: 'auto', padding: '8px 12px' }}
                    onClick={() => window.flow.openOutputs()}>
                    <IcFolder size={13} /> 打开输出目录
                  </button>
                  <button className="ghost-btn" style={{ width: 'auto', padding: '8px 12px' }}
                    onClick={() => window.flow.openDataDir()}>
                    <IcExternal size={13} /> 打开数据目录
                  </button>
                </div>
                <span className="hint">生成链接 24 小时过期，作品会自动下载到输出目录；项目与资产存在数据目录</span>
              </div>

              {/* S21-1：本地存储占用统计（REF-010） */}
              <div className="set-group">
                <div className="set-group-title">本地存储占用</div>
                {usage ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 16px', fontSize: 12.5 }}>
                    {[
                      ['项目', usage.projects],
                      ['资产（不含缩略图）', usage.assets],
                      ['缩略图缓存', usage.thumbs],
                      ['模板', usage.templates],
                      ['未命名草稿', usage.drafts],
                      ['Isle 会话与记忆', usage.sessions]
                    ].map(([label, v]) => (
                      <React.Fragment key={label}>
                        <span>{label}</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtSize(v)}</span>
                      </React.Fragment>
                    ))}
                    <span style={{ fontWeight: 600 }}>总计</span>
                    <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtSize(usage.total)}</span>
                  </div>
                ) : (
                  <div className="hint">统计中…</div>
                )}
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="ghost-btn" style={{ width: 'auto', padding: '8px 12px' }} onClick={refreshUsage}>刷新</button>
                  <button className="ghost-btn" style={{ width: 'auto', padding: '8px 12px' }} onClick={clearThumbs} disabled={clearingThumbs}>
                    {clearingThumbs ? '清理中…' : '清理缩略图缓存'}
                  </button>
                </div>
                <span className="hint">清理后下次打开画廊会自动重建缩略图；项目、资产与配置不受影响</span>
              </div>

              {/* S21-2：配置导入导出（REF-009）。Key 默认脱敏为占位符；含 Key 导出必须二次确认 */}
              <div className="set-group">
                <div className="set-group-title">配置导入导出</div>
                <div className="row">
                  <button className="ghost-btn" style={{ width: 'auto', padding: '8px 12px' }} onClick={exportConfig}>导出配置（Key 脱敏）</button>
                  <button className="ghost-btn danger" style={{ width: 'auto', padding: '8px 12px' }} onClick={() => setAskIncludeKey(true)} disabled={askIncludeKey}>导出配置（包含 Key）</button>
                </div>
                {askIncludeKey && (
                  <div style={{ marginTop: 8, padding: '10px 12px', border: '1px solid var(--danger, #e5484d)', borderRadius: 8 }}>
                    <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>⚠️ 导出文件将包含<b>明文 API Key</b>：文件泄露等于 Key 泄露，请勿通过网盘/聊天工具传输。跨机器导入后若解密异常，需在「接口」页重新保存 Key。</div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="ghost-btn danger" style={{ width: 'auto', padding: '6px 14px' }} onClick={() => { setAskIncludeKey(false); exportConfig(true) }}>确认导出</button>
                      <button className="ghost-btn" style={{ width: 'auto', padding: '6px 14px' }} onClick={() => setAskIncludeKey(false)}>取消</button>
                    </div>
                  </div>
                )}
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="ghost-btn" style={{ width: 'auto', padding: '8px 12px' }} onClick={() => importConfig(false)}>导入配置（跳过已存在）</button>
                  <button className="ghost-btn" style={{ width: 'auto', padding: '8px 12px' }} onClick={() => importConfig(true)}>导入配置（覆盖同名）</button>
                </div>
                <span className="hint">导出不含任何系统加密材料（os_crypt key）；含明文 Key 的文件泄露等于 Key 泄露，务必妥善保管。导入的明文 Key 会按本机加密方式重新加密存储</span>
                {msg?.kind === 'storage' && <div className="hint" style={{ color: 'var(--ok, #46a758)' }}>{msg.text}</div>}
              </div>
            </div>
          )}

          {/* ---------------- Isle ---------------- */}
          {tab === 'isle' && (
            <div className="gen-prefs">
              <div className="set-group">
                <div className="set-group-title">当前人设</div>
                <div className="set-readonly">你是 Isle，Isle Studio 的创作助理……</div>
                {/* S21-3（NF-01）：人设补充说明——追加在系统提示词末尾，随项目记忆一起生效 */}
                <textarea
                  className="persona-note"
                  style={{ width: '100%', minHeight: 96, marginTop: 10, resize: 'vertical' }}
                  maxLength={2000}
                  placeholder="补充 Isle 的说话习惯与偏好，例如：回答保持简短、默认使用中文、生成图片偏好胶片质感…（最多 2000 字）"
                  value={s.personaNote || ''}
                  onChange={(e) => setS({ ...s, personaNote: e.target.value.slice(0, 2000) })}
                />
                <span className="hint">
                  人设首句与工具协议段受保护、不对外开放改写；上方补充说明会追加在 Isle 系统提示词末尾（≤2000 字），与项目记忆一起生效。{(s.personaNote || '').length}/2000
                </span>
              </div>
              <div className="set-group">
                <div className="set-group-title">Isle 标语</div>
                <input
                  style={{ width: '100%' }}
                  maxLength={200}
                  placeholder="显示在 Isle 输入框上方的一句话，留空则不显示。例如：Isle 会读取画布内容，帮你搭建并运行工作流"
                  value={s.agentSlogan || ''}
                  onChange={(e) => setS({ ...s, agentSlogan: e.target.value.slice(0, 200) })}
                />
                <span className="hint">自定义标语，保存后立即生效，可随时回来更改（≤200 字）。{(s.agentSlogan || '').length}/200</span>
              </div>
              <div className="set-group">
                <div className="set-group-title">审批门控</div>
                <div className="hint" style={{ lineHeight: 1.9 }}>
                  · 生成动作默认要审批：Isle 发起运行前会给你一张审批卡<br />
                  · 结构类操作（新建/连线/改参数）免审<br />
                  · 免审直跑开关在「生成偏好」里
                </div>
              </div>
              {/* S20-3：项目记忆管理（列表 + 单条删除 + 全部清除；不放画布，避免面板拥挤） */}
              <div className="set-group">
                <div className="set-group-title">项目记忆{memKey && memKey !== 'global' ? <span className="hint"> · {memKey.replace(/^proj:/, '')}</span> : <span className="hint"> · 全局</span>}</div>
                {memEntries.length === 0 ? (
                  <div className="hint">还没有记忆条目。在会话里对 Isle 说「记住…」，或完成一次委托执行后会自动沉淀。</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {memEntries.map((m, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: '1px solid var(--line, #2a2f3a)', borderRadius: 8 }}>
                        <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, wordBreak: 'break-all' }}>{m.text}</span>
                        <span className="hint" style={{ flexShrink: 0 }}>{m.source === 'delegate' ? '委托' : '用户'}</span>
                        <button className="ghost-btn" style={{ width: 'auto', padding: '4px 10px', flexShrink: 0 }} onClick={() => memDelete(i)}>删除</button>
                      </div>
                    ))}
                    <button className="ghost-btn danger" style={{ width: 'auto', padding: '7px 14px', alignSelf: 'flex-start' }} onClick={memClear}>全部清除（{memEntries.length} 条）</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底部：未保存提示 / 保存 */}
        {askLeave ? (
          <div className="set-foot ask">
            <span>有未保存的修改</span>
            <div className="set-foot-btns">
              <button className="ghost-btn" style={{ width: 'auto', padding: '8px 14px' }} onClick={() => setAskLeave(false)}>继续编辑</button>
              <button className="ghost-btn danger" style={{ width: 'auto', padding: '8px 14px' }} onClick={onClose}>放弃并关闭</button>
            </div>
          </div>
        ) : (
          <div className="set-foot">
            <span className={'set-dirty' + (dirty ? ' on' : '')}>{dirty ? '有未保存的修改' : saved ? '已保存' : ''}</span>
            <button className="primary-btn" style={{ width: 'auto', padding: '9px 24px' }} onClick={save} disabled={saved}>
              {saved ? '✓ 已保存' : '保存设置'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

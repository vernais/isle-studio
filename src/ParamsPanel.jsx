import React, { useEffect, useRef, useState } from 'react'
import { cardWidthFor } from './nodes.jsx'
import { isAutoSize } from './lib/cardSize.js'
import { estimateNodeCost } from './costEstimate.js'
import ThumbImg from './ThumbImg.jsx'
import { IcClose, IcPlus, IcMinus, IcSettings, IcBolt, IcArrowRight, NodeGlyph, IcSearch, IcCopy, IcImage } from './icons.jsx'
import { matchVideoSpec, sanitizeVideoParams, specSummary } from './lib/modelSpecs.js'
import { needsRefVideo, isMotionModel } from './lib/mediaRef.js'
import { AUDIO_MODELS, VOICES, VOICE_LABEL } from './lib/audioModels.js'
import ModelLogo from './modelLogos.jsx'
import RolePicker from './components/RolePicker.jsx'
import { isKlingV4, klingModeOf, KLING_MODES, KLING_MODE_LABEL, refCapFor, MAX_UI_REFS } from './lib/klingVideo.js'
import { matchImageSpec, imageResOptions, pixelHint, sanitizeImageParams } from './lib/imageSpecs.js'

const SIZES = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9', '4:5', '5:4']
const SIZES_IMG = ['Auto', ...SIZES]

const VID_RES = ['480p', '720p', '1080p', '4k']

/* REF-004 参考角色标签（REQ-004 / Q1-1）：下拉直改，空 = 不标注 */
export const REF_ROLES = ['', '主角', '场景', '产品', '风格参考']

/* 两行式行卡（label 上 / 粗体值下 / › 垂直居中）+ 内嵌选项列表。
   拆成 DropHead / DropList 两个栅格子项：并排行对在上，列表占满整行展开在下方（Higgsfield 布局） */
function DropHead({ label, value, open, onToggle, placeholder, gear, logo }) {
  return (
    <button type="button" className={'prow drop-head' + (open ? ' open' : '')} onClick={onToggle}>
      <span className="drop-stack">
        <span className="prow-label">{label}</span>
        <span className={'drop-val' + (value ? '' : ' ph')}>
          {/* D-8：模型行收起态也显示品牌 logo（与展开列表、卡片头部一致） */}
          {logo && value ? <ModelLogo model={value} size={14} /> : null}
          {value || placeholder || '选择'}
          {gear && value ? <i className="gear"><IcSettings size={11} /></i> : null}
        </span>
      </span>
      <span className="prow-arrow"><IcArrowRight size={14} /></span>
    </button>
  )
}

function DropList({ label, value, options, onPick, lower, search = false, logo = false, labelFor }) {
  const [q, setQ] = useState('')
  const searchable = search && options.length > 8 // 模型多时给搜索框
  const kw = q.trim().toLowerCase()
  const list = searchable && kw ? options.filter((o) => String(o).toLowerCase().includes(kw)) : options
  return (
    <div className="drop-list">
      <div className="drop-title">{label}{searchable ? ` · ${options.length}` : ''}</div>
      {searchable && (
        <div className="drop-search">
          <IcSearch size={12} />
          <input placeholder="搜索模型" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {list.map((o) => (
        <button key={o} type="button"
          className={'drop-item' + (o === value ? ' on' : '')}
          onClick={() => onPick(o)}>
          {logo && <ModelLogo model={o} size={15} />}
          <span>{labelFor ? labelFor(o) : (lower ? o.toLowerCase() : o)}</span>
        </button>
      ))}
      {!list.length && <div className="drop-empty">没有匹配的模型</div>}
    </div>
  )
}

export default function ParamsPanel({
  node, onChange, onClose, onRunNode, running, upstreamImages = [], toast = () => {},
  refs = [], onRemoveRef = () => {}, onPickRefs = () => {}, pickingRefs = false
}) {
  const d = node.data
  /* P3 成片合成：本地 FFmpeg 管线，不选模型、不填提示词，参数只有画幅/字幕/混音 */
  const isCompose = d.kind === 'compose'
  const [models, setModels] = useState([])
  const [openDrop, setOpenDrop] = useState(null) // 'model' | 'resolution' | 'size' | null
  const [advOpen, setAdvOpen] = useState(true)
  const fileRef = useRef(null)

  useEffect(() => {
    let alive = true
    const load = () => window.flow.getSettings().then((s) => {
      if (!alive) return
      const list = (s.models?.[d.kind] || []).map((m) => m.model)
      /* P2：音频模型设置里通常没有 audio 分类，用内置兜底保证配音节点可用 */
      setModels(list.length ? list : (d.kind === 'audio' ? AUDIO_MODELS : []))
    })
    load()
    // 设置里保存后立刻刷新，不用重新选中卡片
    window.addEventListener('settings:saved', load)
    return () => { alive = false; window.removeEventListener('settings:saved', load) }
  }, [d.kind])

  if (!node) return null
  /* 问题3：按所选模型裁参数——面板只给该模型支持的选项，选不出的组合就不会提交报错 */
  const spec = d.kind === 'video' ? matchVideoSpec(d.model) : null
  const imgSpec = d.kind === 'image' ? matchImageSpec(d.model) : null
  /* 1.2.0：图片模型的档位/比例口径各不相同（4K 不是每个模型都有），按能力表给选项 */
  const resOptions = d.kind === 'image'
    ? imageResOptions(d.model)
    : (spec?.resolutions || VID_RES)
  const imgNoSize = d.kind === 'image' && imgSpec?.sizeMode === 'none'
  const sizeOptions = d.kind === 'image'
    ? (imgSpec?.pixelSizes ? Object.keys(imgSpec.pixelSizes) : SIZES_IMG)
    : (spec?.sizes || SIZES)
  const pxHint = d.kind === 'image' ? pixelHint(d.model, d.size, d.resolution) : ''
  const durEnum = spec && Array.isArray(spec.durations) ? spec.durations : null
  const durRange = spec && !Array.isArray(spec.durations) && spec.durations
    ? [spec.durations.min, spec.durations.max]
    : (d.kind === 'video' ? [4, 15] : null)
  const audioSupported = spec ? spec.audio !== false : true
  /* P1：动作控制/视频编辑类模型的时长、分辨率、画幅都由参考视频决定，面板不再暴露 */
  const refVideoMode = d.kind === 'video' && needsRefVideo(d.model)
  /* 1.2.0：Kling-v4 模式决定参考图上限（首尾帧 2 / 多图参考 4）与音色入口 */
  const kling = d.kind === 'video' && isKlingV4(d.model)
  const kmode = klingModeOf(d)
  const refLimit = kling ? refCapFor(kmode) : MAX_UI_REFS

  /* 切模型时按新模型能力修正当前值（一次 onChange 带回，避免提交时才报错） */
  const pickModel = (v) => {
    const patch = { model: v }
    let notes = []
    if (d.kind === 'video') {
      const { params, notes: n } = sanitizeVideoParams(v, {
        size: d.size, duration: d.duration, resolution: d.resolution, audio: d.audio
      })
      patch.size = params.size; patch.duration = params.duration; patch.resolution = params.resolution
      notes = n
    } else if (d.kind === 'image') {
      /* 1.2.0：切到「只到 2K」或「固定像素」的模型时，把 4K / 比例值一并修正 */
      const { params, notes: n } = sanitizeImageParams(v, { size: d.size, resolution: d.resolution })
      patch.size = params.size; patch.resolution = params.resolution
      notes = n
    }
    onChange(node.id, patch)
    if (notes.length) toast('已按模型能力调整：' + notes.join('；'))
    setOpenDrop(null)
  }

  const pick = (k, v) => {
    if (k === 'size') {
      /* 切换画面比例：清掉上一轮产物留下的真实比例（否则会盖住用户新选的比例）。
         Auto：回到初始卡片比例与初始宽度，不压缩、也不沿用上次产物尺寸；
         视频给具体比例时保持卡片总高一致，宽度等比缩放。 */
      const patch = { size: v, ar: undefined }
      if (isAutoSize(v)) {
        patch.cardWidth = undefined
      } else if (d.kind === 'video') {
        patch.cardWidth = cardWidthFor('video', v)
      }
      return onChange(node.id, patch)
    }
    onChange(node.id, { [k]: v })
  }
  const toggleDrop = (key) => setOpenDrop((cur) => (cur === key ? null : key))

  /* Q1-1：设/清参考角色；清空时删除键，保持 refRoles 只含有值条目 */
  const setRole = (key, role) => {
    const next = { ...(d.refRoles || {}) }
    if (role) next[key] = role
    else delete next[key]
    onChange(node.id, { refRoles: next })
  }

  const addRef = (e) => {
    const files = [...e.target.files].slice(0, refLimit)
    for (const f of files) {
      const reader = new FileReader()
      reader.onload = () => onChange(node.id, { refImages: [...(d.refImages || []), reader.result].slice(0, refLimit) })
      reader.readAsDataURL(f)
    }
    e.target.value = ''
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title"><NodeGlyph kind={d.kind} size={14} /> {d.label}</span>
        <button className="icon-btn" onClick={onClose}><IcClose size={15} /></button>
      </div>

      {/* 顶部容器：参考栏 + 描述 + 生成任务 chip */}
      <div className={'top-card' + (d.kind === 'audio' ? ' is-audio' : '') + (isCompose ? ' is-compose' : '')}>
        {isCompose && (
          <div className="compose-note">
            <b>合成方式</b>：把「视频生成」节点连到左侧上方入口（多段按画布从上到下拼接），
            把「配音」节点连到下方入口。本地 FFmpeg 完成拼接、混音与字幕，不消耗积分。
          </div>
        )}
        {/* REF-004 参考栏：连线来的参考项（缩略图 + 来源 + 角色标签 + 单项移除）；
            无参考时收成一行「+ 添加参考」，不占版面 */}
        {!isCompose && <div className={'ref-bar' + (refs.length || (d.refImages || []).length ? '' : ' empty')}>
          {/* 显示顺序与 engine 编号顺序一致：本地参考在前、连线参考在后（Q1-1） */}
          {(d.refImages || []).map((r, i) => {
            const role = (d.refRoles || {})[`local:${i}`] || ''
            return (
              <div key={'loc' + i} className="ref-item local" title="本地添加的参考图">
                <ThumbImg src={r} alt="" />
                <button type="button" className="ref-x" title="移除"
                  onClick={() => {
                    // 移除本地参考时同步清掉其角色键，并把后续 local:<i> 键前移补位
                    const nextRoles = { ...(d.refRoles || {}) }
                    delete nextRoles[`local:${i}`]
                    const remap = {}
                    for (const [k, v] of Object.entries(nextRoles)) {
                      const m = /^local:(\d+)$/.exec(k)
                      if (!m) { remap[k] = v; continue }
                      const idx = Number(m[1])
                      remap[idx > i ? `local:${idx - 1}` : k] = v
                    }
                    onChange(node.id, { refImages: d.refImages.filter((_, j) => j !== i), refRoles: remap })
                  }}><IcClose size={9} /></button>
                <RolePicker role={role} compact onPick={(v) => setRole(`local:${i}`, v)} />
              </div>
            )
          })}
          {refs.length === 0 ? (
            <button type="button" className="ref-empty" onClick={onPickRefs} title="从画布点选节点加入参考">
              <IcPlus size={12} /> 添加参考
            </button>
          ) : (
            <>
              {refs.map((r) => {
                const role = (d.refRoles || {})[r.nodeId] || ''
                return (
                  <div key={r.edgeId} className="ref-item" title={r.label || ''}>
                    <ThumbImg src={r.url} alt="" />
                    <button type="button" className="ref-x" title="移除参考（断开连线）"
                      onClick={() => onRemoveRef(r.edgeId)}><IcClose size={9} /></button>
                    <RolePicker role={role} compact onPick={(v) => setRole(r.nodeId, v)} />
                    <span className="ref-src">{r.model || r.label || '上游'}</span>
                  </div>
                )
              })}
              {refs.length + (d.refImages || []).length < refLimit && (
                <button type="button" className={'ref-add' + (pickingRefs ? ' on' : '')}
                  title="继续从画布点选节点" onClick={onPickRefs}><IcPlus size={14} /></button>
              )}
            </>
          )}
          <button type="button" className="ref-add" title="从本地上传参考图" onClick={() => fileRef.current?.click()}>
            <IcImage size={13} />
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={addRef} />
        </div>
        }
        {pickingRefs && (
          <div className="ref-picking">
            <i className="st-dot" /> 点选画布上的节点加入参考（可连续点选），Esc 结束
          </div>
        )}
        {!isCompose && <div className="prompt-wrap">
          <textarea
            className="prompt-area"
            rows={3}
            placeholder={d.kind === 'audio' ? '输入要配音的台词…' : '描述你想创建的内容......'}
            value={d.prompt}
            onChange={(e) => onChange(node.id, { prompt: e.target.value })}
          />
          {d.prompt ? (
            <button type="button" className="prompt-copy" title="复制提示词"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(d.prompt)
                  toast('提示词已复制')
                } catch {
                  toast('复制失败：请手动选择文本复制')
                }
              }}
            ><IcCopy size={13} /></button>
          ) : null}
        </div>
        }
        {refs.length + (d.refImages || []).length >= refLimit && !isCompose && (
          <div className="ref-hint">
            参考图已达 {refLimit} 张上限{refs.length ? `（含连线参考 ${refs.length} 张）` : ''}
            {kling && kmode === 'frames' ? '；首尾帧只取前两张（第 1 张首帧、第 2 张尾帧）' : ''}
          </div>
        )}
        {kling && kmode === 'frames' && (refs.length + (d.refImages || []).length) > 2 && (
          <div className="ref-hint warn">首尾帧模式最多 2 张图，提交前会拦下。多图请切到「多图参考」。</div>
        )}
      </div>

      {/* 模型（两行式） */}
      {!isCompose && <DropHead
        label="模型" value={d.model} open={openDrop === 'model'} gear logo
        onToggle={() => toggleDrop('model')} placeholder="选择模型"
      />}
      {!isCompose && openDrop === 'model' && (
        <DropList label="模型" value={d.model} options={models} search logo
          onPick={pickModel} />
      )}
      {!isCompose && models.length === 0 && <div className="hint" style={{ margin: '4px 2px 10px' }}>尚无已配置模型，请到设置里添加</div>}

      {/* P2 配音参数：音色 / 语速 / 输出格式（音频节点没有分辨率、比例、时长、参考图） */}
      {d.kind === 'audio' && (
        <>
          <DropHead
            label="音色" value={d.voice || 'alloy'} open={openDrop === 'voice'}
            onToggle={() => toggleDrop('voice')}
          />
          {openDrop === 'voice' && (
            <DropList
              label="音色" value={d.voice || 'alloy'} options={VOICES}
              labelFor={(v) => VOICE_LABEL[v] || v}
              onPick={(v) => { onChange(node.id, { voice: v }); setOpenDrop(null) }}
            />
          )}
          <div className="prow">
            <span className="prow-label lt">语速</span>
            <div className="seg" role="group" aria-label="语速">
              {[0.8, 1, 1.2, 1.5].map((v) => (
                <button key={v} className={Number(d.speed || 1) === v ? 'on' : ''}
                  onClick={() => onChange(node.id, { speed: v })}>{v}×</button>
              ))}
            </div>
          </div>
          <div className="prow">
            <span className="prow-label lt">格式</span>
            <div className="seg" role="group" aria-label="输出格式">
              {['mp3', 'wav'].map((v) => (
                <button key={v} className={(d.format || 'mp3') === v ? 'on' : ''}
                  onClick={() => onChange(node.id, { format: v })}>{v.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div className="audio-note">
            台词 {(d.prompt || '').length} 字 · 单次上限 4000 字
            {d.seconds ? ` · 上次 ${Number(d.seconds).toFixed(1)} 秒` : ''}
          </div>
        </>
      )}

      {/* P3 成片合成参数：画幅 / 字幕 / 原声 / 配音循环（本地 FFmpeg，无模型无提示词） */}
      {isCompose && (
        <>
          <div className="prow">
            <span className="prow-label lt">输出画幅</span>
            <div className="seg seg-wrap" role="group" aria-label="输出画幅">
              {['auto', '16:9', '9:16', '1:1', '4:3'].map((v) => (
                <button key={v} className={(d.size || 'auto') === v ? 'on' : ''}
                  onClick={() => onChange(node.id, { size: v })}>{v === 'auto' ? '跟随' : v}</button>
              ))}
            </div>
          </div>
          <div className="prow">
            <span className="prow-label lt">烧字幕</span>
            <div className="seg">
              <button className={d.subtitles ? 'on' : ''} onClick={() => onChange(node.id, { subtitles: true })}>开</button>
              <button className={!d.subtitles ? 'on' : ''} onClick={() => onChange(node.id, { subtitles: false })}>关</button>
            </div>
          </div>
          <div className="prow">
            <span className="prow-label lt">保留视频原声</span>
            <div className="seg">
              <button className={d.keepOriginalSound ? 'on' : ''} onClick={() => onChange(node.id, { keepOriginalSound: true })}>开</button>
              <button className={!d.keepOriginalSound ? 'on' : ''} onClick={() => onChange(node.id, { keepOriginalSound: false })}>关</button>
            </div>
          </div>
          <div className="prow">
            <span className="prow-label lt">配音循环填满</span>
            <div className="seg">
              <button className={d.loopAudio ? 'on' : ''} onClick={() => onChange(node.id, { loopAudio: true })}>开</button>
              <button className={!d.loopAudio ? 'on' : ''} onClick={() => onChange(node.id, { loopAudio: false })}>关</button>
            </div>
          </div>
          <div className="audio-note">
            多段视频按画布从上到下顺序拼接；字幕文案自动取配音卡台词，按语速摊到时间轴上。
            {d.keepOriginalSound && ' 若连入配音，配音会覆盖原声。'}
          </div>
        </>
      )}

      {/* 问题3：模型能力摘要（只有收录了规格的模型显示） */}
      {d.kind === 'video' && spec && (
        <div className="spec-note">{specSummary(spec)}</div>
      )}

      {/* 1.2.0：Kling-v4 模式。首尾帧（文生视频/首帧/首尾帧）与多图参考是两套语义，
          显式切换而不是靠猜图数；多图参考才有多图音色入口 */}
      {kling && (
        <div className="kling-panel">
          <div className="prow">
            <span className="prow-label lt">生成模式</span>
            <div className="seg" role="group" aria-label="Kling 生成模式">
              {KLING_MODES.map((m) => (
                <button key={m} className={kmode === m ? 'on' : ''}
                  title={m === 'frames' ? '0~2 张图：首帧 / 尾帧，0 张即文生视频' : '多张参考图（最多 4 张）：空镜、人物三视图、人物分镜'}
                  onClick={() => onChange(node.id, { klingMode: m })}>{KLING_MODE_LABEL[m]}</button>
              ))}
            </div>
          </div>
          <div className="kling-tip">
            {kmode === 'frames'
              ? '首尾帧：第 1 张为首帧、第 2 张为尾帧，不连图即文生视频。构图要严格锁定就走这里。'
              : '多图参考：参考图是「引导」不是锁帧；可给每张图标主角/场景/分镜/三视图，模型按图序理解。'}
          </div>
          {kmode === 'reference' && (
            <div className="audio-ref">
              <div className="audio-ref-head">
                <span className="audio-ref-title">音色参考</span>
                <span className="audio-ref-tip">公网 HTTP/HTTPS · 建议 5–30 秒清晰说话声</span>
              </div>
              <input
                className="motion-ref-input"
                placeholder="https://…/voice.mp3（可选）"
                value={d.refAudioUrl || ''}
                onChange={(e) => onChange(node.id, { refAudioUrl: e.target.value })}
              />
              <div className="motion-ref-hint">
                提交时按 @Audio1 说明为音色参考。网关没有音频上传通道，本地音频需先放到公网。
              </div>
            </div>
          )}
        </div>
      )}

      {/* P1：参考视频（动作控制 / 视频编辑类模型必填）。网关只认公网直链，
          本地视频请先放到可公开访问的地址；生成产物会自带公网地址可直接复用 */}
      {d.kind === 'video' && needsRefVideo(d.model) && (
        <div className="motion-ref">
          <div className="motion-ref-head">
            <span className="motion-ref-title">参考视频</span>
            <span className="motion-ref-tip">
              公网直链 · mp4/mov · {d.motionOrientation === 'video' ? '3–30 秒' : '3–10 秒'}
            </span>
          </div>
          <input
            className="motion-ref-input"
            placeholder="https://…/reference.mp4"
            value={d.refVideoUrl || ''}
            onChange={(e) => onChange(node.id, { refVideoUrl: e.target.value })}
          />
          <div className="motion-ref-row">
            {isMotionModel(d.model) && (
              <>
                <span className="motion-ref-label">人物朝向</span>
                <div className="seg" role="group" aria-label="人物朝向">
                  <button className={d.motionOrientation === 'video' ? '' : 'on'}
                    onClick={() => onChange(node.id, { motionOrientation: 'image' })}>以参考图</button>
                  <button className={d.motionOrientation === 'video' ? 'on' : ''}
                    onClick={() => onChange(node.id, { motionOrientation: 'video' })}>以参考视频</button>
                </div>
                <span className="motion-ref-label">模式</span>
                <div className="seg" role="group" aria-label="生成模式">
                  <button className={d.motionMode === 'pro' ? '' : 'on'}
                    onClick={() => onChange(node.id, { motionMode: 'std' })}>标准</button>
                  <button className={d.motionMode === 'pro' ? 'on' : ''}
                    onClick={() => onChange(node.id, { motionMode: 'pro' })}>高质量</button>
                </div>
              </>
            )}
          </div>
          <div className="motion-ref-hint">
            连入的视频卡片若由本应用生成，会自动带上它的公网地址；本地视频需先传到公网存储。
          </div>
        </div>
      )}

      {/* Resolution + 画面比例：行对并排在上，列表全宽展开在下方（参考视频类模型、配音节点不显示）
          1.2.0：固定像素模型没有档位、部分模型不接受比例 → 该行自动收起，避免给不存在的选项 */}
      {!refVideoMode && d.kind !== 'audio' && !isCompose && (resOptions.length > 0 || !imgNoSize) && (
        <div className={'prow-grid' + (resOptions.length === 0 || imgNoSize ? ' single' : '')}>
        {resOptions.length > 0 && (
          <DropHead
            label="分辨率" value={d.resolution} open={openDrop === 'resolution'}
            onToggle={() => toggleDrop('resolution')}
          />
        )}
        {!imgNoSize && (
          <DropHead
            label="画面比例" value={d.size} open={openDrop === 'size'}
            onToggle={() => toggleDrop('size')}
          />
        )}
        {openDrop === 'resolution' && resOptions.length > 0 && (
          <DropList label="分辨率" value={d.resolution} lower
            options={resOptions}
            onPick={(v) => { pick('resolution', v); setOpenDrop(null) }} />
        )}
        {openDrop === 'size' && !imgNoSize && (
          <DropList label="画面比例" value={d.size}
            options={sizeOptions}
            onPick={(v) => { pick('size', v); setOpenDrop(null) }} />
        )}
        </div>
      )}
      {/* 1.2.0：把「实际输出像素」写在面板上——用户才知道 4K 档究竟出多大图。
          有 note（含实测尺寸说明）时只显示 note，避免和 pxHint 重复。 */}
      {d.kind === 'image' && (imgSpec?.note || (pxHint && !imgSpec?.note)) && (
        <div className="px-hint">{imgSpec?.note || pxHint}</div>
      )}

      {/* 批量（图片） */}
      {d.kind === 'image' && (
        <div className="prow">
          <span className="prow-label lt">批量大小</span>
          <div className="stepper">
            <button onClick={() => onChange(node.id, { n: Math.max(1, d.n - 1) })}><IcMinus size={12} /></button>
            <span>{d.n} / 4</span>
            <button onClick={() => onChange(node.id, { n: Math.min(4, d.n + 1) })}><IcPlus size={12} /></button>
          </div>
        </div>
      )}

      {/* 时长（视频）：枚举型模型（如 veo 4/6/8、Hailuo 6/10）用按钮组；范围型用滑杆 */}
      {d.kind === 'video' && !refVideoMode && durEnum && (
        <div className="prow">
          <span className="prow-label lt">时长</span>
          <div className="seg" role="group" aria-label="时长">
            {durEnum.map((t) => (
              <button key={t} className={d.duration === t ? 'on' : ''} onClick={() => onChange(node.id, { duration: t })}>{t}s</button>
            ))}
          </div>
        </div>
      )}
      {d.kind === 'video' && !refVideoMode && !durEnum && durRange && (
        <div className="prow">
          <span className="prow-label lt">时长</span>
          <div className="slider-wrap">
            <input type="range" min={durRange[0]} max={durRange[1]} step="1" value={d.duration}
              onChange={(e) => onChange(node.id, { duration: Number(e.target.value) })} />
            <div className="ticks">
              {[4, 6, 8, 10, 12, 15].filter((t) => t >= durRange[0] && t <= durRange[1]).map((t) => {
                const left = `${((t - durRange[0]) / (durRange[1] - durRange[0])) * 100}%`
                return (
                  <React.Fragment key={t}>
                    <i style={{ left }} />
                    <span style={{ left }}>{t}s</span>
                  </React.Fragment>
                )
              })}
            </div>
          </div>
          <span className="prow-value">{d.duration}</span>
        </div>
      )}

      {/* 高级设置：仅视频节点有可折叠内容，图片节点不渲染空展开区（UI-011） */}
      {d.kind === 'video' && (
        <>
          <button type="button" className="prow drop-head adv-row" onClick={() => setAdvOpen((v) => !v)}>
            <span className="drop-stack"><span className="adv-label"><IcSettings size={13} /> 高级设置</span></span>
            <span className={'prow-arrow' + (advOpen ? ' up' : '')}><IcArrowRight size={14} /></span>
          </button>
          {advOpen && (
            <div className="prow">
              <span className="prow-label lt">AI 音频</span>
              {audioSupported ? (
                <div className="seg">
                  <button className={d.audio ? 'on' : ''} onClick={() => onChange(node.id, { audio: true })}>开</button>
                  <button className={!d.audio ? 'on' : ''} onClick={() => onChange(node.id, { audio: false })}>关</button>
                </div>
              ) : (
                <span className="spec-note" style={{ margin: 0 }}>该模型不支持 AI 音频，输出为无声视频</span>
              )}
            </div>
          )}
        </>
      )}

      {/* 底部生成按钮：只运行当前节点。
          REQ-001：模型未选时置灰（点击无效而非提交后报错）；
          预估积分内嵌按钮（用户口径 v2：数字取整 1 位小数，不带「积分（预估）」字样），
          随模型/分辨率/出图数量实时联动；无定价模型时按钮外显示「计费未知」 */}
      <div className="panel-run">
        <button
          className="primary-btn" disabled={running || (!d.model && !isCompose)}
          title={isCompose ? '本地 FFmpeg 合成（拼接+混音+字幕），不消耗积分' : d.model ? '预估积分按 APIMart 现价估算，实际以运行后账单为准' : '请先选择模型'}
          onClick={() => onRunNode(node.id)}
        >
          {isCompose ? '开始合成' : '生成 '}{!isCompose && d.model && (() => {
            const est = estimateNodeCost(node)
            // 1 位小数，标准四舍五入（避免 0.15.toFixed(1) 因二进制误差得 0.1）
            return est.known
              ? <span className="btn-est"><IcBolt size={11} /> {(Math.round(Number(est.credits) * 10) / 10).toFixed(1)}</span>
              : null
          })()}
        </button>
        {d.model && d.kind !== 'audio' && !isCompose && !estimateNodeCost(node).known && (
          <span className="chip est-chip unknown" title="该模型暂无定价数据，实际消耗以运行为准">计费未知</span>
        )}
        <div className="hint" style={{ textAlign: 'center', marginTop: 6 }}>
          {isCompose
            ? '先把视频节点与配音节点连到卡片左侧两个入口，再点开始合成'
            : !d.model
            ? '请先选择模型'
            : d.kind === 'audio'
              ? '台词会直接合成为语音，产物保存在项目资产里'
              : '上游连线的图片会作为本节点的参考图自动传入'}
        </div>
      </div>
    </div>
  )
}

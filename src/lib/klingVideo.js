/* Kling-v4 视频能力（1.2.0）
 *
 * 背景：kling-v4 与 v2/v3 的入参语义不同，且官方分两种模式：
 *   - frames（首尾帧）：0~2 张图，第 1 张=首帧、第 2 张=尾帧；0 张即文生视频
 *   - reference（多图参考）：omni_reference_task_type=reference + image_urls（最多 10 张）
 *     + 可选 audio_urls（音色参考，只认公网 HTTP/HTTPS 直链）
 * 旧节点没有 klingMode 字段 → 默认 frames，保证历史项目行为不变。
 *
 * 本文件只放纯函数：模式识别、图序去重、本地校验、提示词角色块、请求体构造。
 * 面板（ParamsPanel）、执行入口（engine/api）与离线测试共用同一份逻辑，
 * 「面板选不出非法组合」之外，历史数据里的非法值也会在提交前被兜住。
 */

export const KLING_V4_RE = /kling[-_ ]?v4/i

/** 是否 Kling-v4 系（kling-v4 / kling-v4-* / Kling V4） */
export const isKlingV4 = (model) => KLING_V4_RE.test(String(model || ''))

/** 模式 */
export const KLING_MODES = ['frames', 'reference']
export const KLING_MODE_LABEL = { frames: '首尾帧', reference: '多图参考' }

/** 模式归一化：只认 reference，其余一律 frames（旧节点无该字段时的默认值） */
export function klingModeOf(data) {
  return String(data?.klingMode || '').toLowerCase() === 'reference' ? 'reference' : 'frames'
}

/** 面板参考图上限（界面口径）；底层校验上限（服务端口径） */
export const MAX_UI_REFS = 4
export const MAX_API_REFS = 10
export const MAX_FRAMES_REFS = 2

/** 当前模式下面板允许的参考图张数 */
export function refCapFor(mode) {
  return klingModeOf({ klingMode: mode }) === 'frames' ? MAX_FRAMES_REFS : MAX_UI_REFS
}

/** 按 url 去重、保序（同一次多选里偶发的重复文件不该占两个图位） */
export function dedupeUrls(list) {
  const out = []
  const seen = new Set()
  for (const u of Array.isArray(list) ? list : []) {
    const s = String(u || '')
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/* 参考角色 → 提示词含义。前三项为 1.2.0 新增的「人物分镜」语义：
   主角约束身份、场景约束空间、分镜约束构图与动作；三视图按同一人处理。 */
const ROLE_HINT = {
  主角: '人物身份以此为准，保持与参考图同一人物（五官、发型、体型一致）',
  场景: '空间与环境以此为准，保持场景结构、材质与光线一致',
  分镜: '构图与动作以此为准，参考机位、景别与动作节奏',
  三视图: '同一人物的三视图，按同一个人处理，不要当成多个人物',
  产品: '产品外观以此为准，保持造型、配色与材质细节一致',
  风格参考: '仅参考风格，不复制其中的具体人物与场景'
}

/** 角色提示词块：按「实际提交顺序」编号，未标角色的图不写说明 */
export function rolePromptBlock(entries) {
  const lines = []
  const list = Array.isArray(entries) ? entries : []
  list.forEach((ent, i) => {
    const role = ent?.role
    if (!role) return
    const hint = ROLE_HINT[role] || ''
    lines.push(`@Image${i + 1}（${role}）：${hint}`)
  })
  return lines.length ? `参考图说明：\n${lines.join('\n')}` : ''
}

/** 音色说明块：audio_urls 存在时补一行，让模型知道音频是音色参考 */
export function audioPromptBlock(count) {
  if (!count) return ''
  return `音色说明：@Audio1 为音色参考，只沿用音色与说话方式，不要复述其中的内容。`
}

const isHttpUrl = (u) => /^https?:\/\//i.test(String(u || ''))

/**
 * 提交前本地校验（不花积分）。返回 { ok, error?, notes?, mode, imageUrls, audioUrls, duration, resolution, size }
 * - frames：>2 张图直接拦（提示切多图参考）
 * - reference：至少 1 张图；超过 10 张截断并提示；audio 只认 http(s)
 * - 时长必须是整数秒（Kling 按整秒计费，非整数会被服务端拒）
 */
export function validateKlingInput({
  model, mode, imageUrls, audioUrls, duration, resolution, size,
  maxRefs = MAX_API_REFS, keepAudio = true
} = {}) {
  const notes = []
  const m = mode === 'reference' ? 'reference' : 'frames'
  const imgs = dedupeUrls(imageUrls)
  const auds = keepAudio ? dedupeUrls(audioUrls).filter(isHttpUrl) : []

  if (!isKlingV4(model)) {
    return { ok: true, mode: m, imageUrls: imgs, audioUrls: auds, duration, resolution, size, notes }
  }

  if (m === 'frames') {
    if (imgs.length > MAX_FRAMES_REFS) {
      return {
        ok: false,
        error: `首尾帧模式最多 2 张参考图（当前 ${imgs.length} 张）。想用多张图请把模式切到「多图参考」，或断开多余的参考。`
      }
    }
    if (auds.length) notes.push('首尾帧模式不使用音色参考，已忽略音频地址')
  } else {
    if (!imgs.length) {
      return { ok: false, error: '多图参考模式至少需要 1 张参考图：连入图片卡片或在面板里添加参考。' }
    }
    if (imgs.length > maxRefs) {
      notes.push(`参考图超过 ${maxRefs} 张，只提交前 ${maxRefs} 张`)
    }
  }

  const badAudio = dedupeUrls(audioUrls).filter((u) => !isHttpUrl(u))
  if (badAudio.length) notes.push('音色参考只认公网 HTTP/HTTPS 直链，已忽略非公网地址')

  let dur = Number(duration)
  if (!Number.isFinite(dur) || dur <= 0) dur = 5
  const rounded = Math.round(dur)
  if (rounded !== dur) notes.push(`时长 ${dur}s → ${rounded}s（按整秒提交）`)
  const clamped = Math.max(3, Math.min(30, rounded))
  if (clamped !== rounded) notes.push(`时长 ${rounded}s → ${clamped}s（该模型支持 3–30 秒）`)

  const imgsFinal = m === 'reference' ? imgs.slice(0, maxRefs) : imgs
  return {
    ok: true,
    mode: m,
    imageUrls: imgsFinal,
    audioUrls: m === 'reference' ? auds : [],
    duration: clamped,
    resolution,
    size,
    notes
  }
}

/**
 * 构造 Kling-v4 请求体。
 * frames：aspect_ratio + image_urls(0~2)；
 * reference：omni_reference_task_type=reference + image_urls(1~N) + audio_urls(可选)。
 * 画幅用 aspect_ratio（v4 不接受 size 字段）。
 */
export function buildKlingBody({
  model, prompt, mode, imageUrls, audioUrls, duration, resolution, size
} = {}) {
  const m = mode === 'reference' ? 'reference' : 'frames'
  const body = {
    model,
    prompt: String(prompt || ''),
    duration: Number(duration) || 5,
    resolution: resolution || '720p'
  }
  if (size && size !== 'Auto') body.aspect_ratio = size
  const imgs = dedupeUrls(imageUrls)
  if (imgs.length) body.image_urls = m === 'reference' ? imgs.slice(0, MAX_API_REFS) : imgs.slice(0, MAX_FRAMES_REFS)
  if (m === 'reference') {
    body.omni_reference_task_type = 'reference'
    const auds = dedupeUrls(audioUrls).filter(isHttpUrl)
    if (auds.length) body.audio_urls = auds.slice(0, 3)
  }
  return body
}

/** 面板/卡片显示用的模式摘要 */
export function klingModeSummary(data) {
  const m = klingModeOf(data)
  return KLING_MODE_LABEL[m]
}

/* API 封装：请求经主进程代理；每个模型可携带独立的 baseUrl/apiKey */

import { sanitizeVideoParams } from './lib/modelSpecs.js'
import { isVideoUrl } from './lib/mediaRef.js'
import { isKlingV4, buildKlingBody, validateKlingInput } from './lib/klingVideo.js'
import { matchImageSpec, requestSizeFor } from './lib/imageSpecs.js'

const req = (path, opts = {}) => {
  // 测试钩子（review 验收用）：设置 window.__capReq 后拦截请求体，不发真实网络请求
  if (typeof window.__capReq === 'function') return window.__capReq({ path, ...opts })
  return window.flow.request({ path, ...opts })
}

const bodyOf = (r) => {
  const j = r.json
  if (r.status !== 200) {
    const msg = j?.error?.message || j?.message || JSON.stringify(j).slice(0, 200)
    const err = new Error(`请求失败 (HTTP ${r.status}): ${msg}`)
    /* 提交结果未知：主进程已判定「请求发出但响应丢失」。带上底层原因/耗时/
       可能的任务 ID，供卡片显示与「查询已有任务」使用；绝不能当成普通失败直接重试。 */
    if (j?.error?.code === 'submit_unknown') {
      err.unknownSubmit = true
      err.detail = j.error.detail || ''
      err.elapsedMs = j.error.elapsedMs || 0
      err.submitStartedAt = j.error.startedAt || 0
      err.possibleTaskId = j.error.taskId || ''
    }
    throw err
  }
  return j
}

/* OpenAI 风格同步响应 → URL 列表（url 或 b64_json） */
function syncUrls(json) {
  return (json?.data || [])
    .map((x) => x.url || (x.b64_json ? 'data:image/png;base64,' + x.b64_json : null))
    .filter(Boolean)
}

/* P1：参考图公网化。
   网关自 2026-10 起不再接受 base64 直传（官方文档），参考视频更是只认公网直链。
   本地素材（data: / file://）先经主进程上传 /v1/uploads/images 换 URL，进程内缓存 6 小时
   （网关侧 72 小时有效）。视频网关无托管通道 → 原样返回，由上层给出明确提示。 */
const publicUrlCache = new Map()
const PUBLIC_URL_TTL = 6 * 60 * 60 * 1000

async function toPublicUrl(src, creds) {
  const s = String(src || '')
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (isVideoUrl(s)) return s // 视频无上传通道，交给上层判定
  const hit = publicUrlCache.get(s)
  if (hit && Date.now() - hit.ts < PUBLIC_URL_TTL) return hit.url
  if (!window.flow?.mediaUpload) return s
  let r
  try {
    r = await window.flow.mediaUpload({ src: s, baseUrl: creds?.baseUrl, apiKey: creds?.apiKey })
  } catch (err) {
    return s // 上传通道异常时退回原样，不阻断生成（旧网关仍可能接受 data URL）
  }
  if (!r?.ok || !r.url) return s
  publicUrlCache.set(s, { url: r.url, ts: Date.now() })
  return r.url
}

/**
 * 提交图片任务。p: {baseUrl, apiKey, model, prompt, size, resolution, n}
 * 返回 {kind:'task', id} 或 {kind:'sync', urls}
 */
async function submitImage(p) {
  const body = { model: p.model, prompt: p.prompt, n: p.n }
  /* 1.2.0：各模型对 size / resolution 的口径不同（比例型 / 像素型 / 不接收），
     统一交给 imageSpecs 决定发什么，避免「传像素给比例型模型」直接 400 白报错 */
  const size = requestSizeFor(p.model, p.size)
  const spec = matchImageSpec(p.model)
  const noTier = spec && Array.isArray(spec.resolutions) && spec.resolutions.length === 0
  if (size && size !== 'Auto') body.size = size
  if (p.resolution && p.resolution !== 'Auto' && !noTier) body.resolution = p.resolution
  if (p.imageUrls?.length) {
    const refs = await Promise.all(p.imageUrls.map((u) => toPublicUrl(u, p)))
    body.image_urls = refs.filter(Boolean)
  }
  /* 带Key实测（2026-11-01）：dall-e-3 网关只接受像素尺寸 1024x1024 / 1024x1792 / 1792x1024
     （422 报错信息明示允许值），而节点参数是宽高比口径（1:1、16:9 等）。
     按宽高比就近映射到允许档；像素值也归一到最近档。仅 dall-e-3 定点映射 */
  if (/^dall-e-3$/i.test(p.model) && body.size) {
    const m = /(\d+(?:\.\d+)?)\s*[:xX]\s*(\d+(?:\.\d+)?)/.exec(String(body.size))
    if (m) {
      const w = +m[1], h = +m[2]
      const r = w / h
      body.size = r > 1.2 ? '1792x1024' : r < 0.833 ? '1024x1792' : '1024x1024'
    }
  }
  const j = bodyOf(await req('/v1/images/generations', {
    method: 'POST',
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    body
  }))
  if (Array.isArray(j.data) && j.data[0]?.task_id) return { kind: 'task', id: j.data[0].task_id }
  const urls = syncUrls(j)
  if (urls.length) return { kind: 'sync', urls }
  throw new Error('响应格式无法识别: ' + JSON.stringify(j).slice(0, 150))
}

/** 提交视频任务（异步）。p 含 baseUrl/apiKey
 *  P1：动作控制（motion-control）与视频编辑（videoedit）需要参考视频，字段与普通
 *  文生/图生视频完全不同（官方文档 2026-11 核对）：
 *   - motion-control：video_url + image_url + character_orientation + mode（时长由服务端探测）
 *   - videoedit：video_urls 数组
 */
async function submitVideo(p) {
  const motion = /motion-control/i.test(p.model)
  const videoEdit = /videoedit|video-edit/i.test(p.model)
  const imageUrls = p.imageUrls?.length
    ? (await Promise.all(p.imageUrls.map((u) => toPublicUrl(u, p)))).filter(Boolean)
    : []
  const videoUrls = (p.videoUrls || []).filter((u) => /^https?:\/\//i.test(u))

  /* Kling-v4（1.2.0）：首尾帧 / 多图参考两种模式，字段与通用链路不同。
     模式缺省 frames（旧节点无 klingMode）；多图参考走 omni_reference_task_type。
     本地校验先跑：超过 2 张图的首尾帧、音色非公网直链等在这里就拦下，不花积分。 */
  if (isKlingV4(p.model)) {
    const s = sanitizeVideoParams(p.model, {
      size: p.size, duration: p.duration, resolution: p.resolution, audio: p.audio
    }).params
    const v = validateKlingInput({
      model: p.model, mode: p.klingMode, imageUrls,
      audioUrls: p.audioUrls, duration: s.duration, resolution: s.resolution, size: s.size,
      maxRefs: p.maxRefs || 10
    })
    if (!v.ok) throw new Error(v.error)
    const body = buildKlingBody({
      model: p.model, prompt: p.prompt, mode: v.mode, imageUrls: v.imageUrls,
      audioUrls: v.audioUrls, duration: v.duration, resolution: v.resolution, size: v.size
    })
    const jk = bodyOf(await req('/v1/videos/generations', {
      method: 'POST', baseUrl: p.baseUrl, apiKey: p.apiKey, body
    }))
    if (Array.isArray(jk.data) && jk.data[0]?.task_id) return { kind: 'task', id: jk.data[0].task_id }
    const uk = syncUrls(jk)
    if (uk.length) return { kind: 'sync', urls: uk }
    throw new Error('响应格式无法识别: ' + JSON.stringify(jk).slice(0, 150))
  }

  if (motion) {
    if (!videoUrls.length) {
      throw new Error('该模型需要参考视频：请连入已生成的视频卡片，或在右侧面板「参考视频」填入公网直链（mp4/mov，3–10 秒）')
    }
    if (!imageUrls.length) {
      throw new Error('该模型需要一张参考人物图：请连入上传图片卡片（本地图会自动上传换取公网地址）')
    }
    const body = {
      model: p.model,
      prompt: p.prompt,
      image_url: imageUrls[0],
      video_url: videoUrls[0],
      character_orientation: p.orientation === 'video' ? 'video' : 'image',
      mode: p.mode === 'pro' ? 'pro' : 'std',
      keep_original_sound: p.keepOriginalSound === false ? 'no' : 'yes',
      watermark_info: { enabled: false }
    }
    const jm = bodyOf(await req('/v1/videos/generations', {
      method: 'POST', baseUrl: p.baseUrl, apiKey: p.apiKey, body
    }))
    if (Array.isArray(jm.data) && jm.data[0]?.task_id) return { kind: 'task', id: jm.data[0].task_id }
    const um = syncUrls(jm)
    if (um.length) return { kind: 'sync', urls: um }
    throw new Error('响应格式无法识别: ' + JSON.stringify(jm).slice(0, 150))
  }

  if (videoEdit) {
    if (!videoUrls.length) {
      throw new Error('该模型需要参考视频：请连入已生成的视频卡片，或填入公网直链（mp4/mov）')
    }
    const body = { model: p.model, prompt: p.prompt, video_urls: videoUrls }
    if (imageUrls.length) body.image_urls = imageUrls
    const je = bodyOf(await req('/v1/videos/generations', {
      method: 'POST', baseUrl: p.baseUrl, apiKey: p.apiKey, body
    }))
    if (Array.isArray(je.data) && je.data[0]?.task_id) return { kind: 'task', id: je.data[0].task_id }
    const ue = syncUrls(je)
    if (ue.length) return { kind: 'sync', urls: ue }
    throw new Error('响应格式无法识别: ' + JSON.stringify(je).slice(0, 150))
  }

  /* 问题3：提交前按模型能力裁剪（历史节点/旧数据里的非法值也兜住），面板层同样裁剪 */
  const { params: sp } = sanitizeVideoParams(p.model, {
    size: p.size, duration: p.duration, resolution: p.resolution, audio: p.audio
  })
  const body = {
    model: p.model, prompt: p.prompt, size: sp.size,
    duration: sp.duration, resolution: sp.resolution, generate_audio: sp.audio
  }
  /* 带Key实测（2026-11-01）：grok-imagine 系网关路由不认 `size` 字段，要求 `aspect_ratio`
     （实测发 size:16:9 被忽略 → 网关默认 auto → 422 未知变体）。仅对已实测确认的
     grok 系映射，其余模型维持 size 不动（避免破坏已验证的 seedance/veo/kling 链路） */
  if (/grok-imagine/i.test(p.model) && sp.size && sp.size !== 'Auto') {
    body.aspect_ratio = sp.size
    delete body.size
  }
  if (imageUrls.length) body.image_urls = imageUrls
  const j = bodyOf(await req('/v1/videos/generations', {
    method: 'POST', baseUrl: p.baseUrl, apiKey: p.apiKey, body
  }))
  if (Array.isArray(j.data) && j.data[0]?.task_id) return { kind: 'task', id: j.data[0].task_id }
  const urls = syncUrls(j)
  if (urls.length) return { kind: 'sync', urls }
  throw new Error('响应格式无法识别: ' + JSON.stringify(j).slice(0, 150))
}

/**
 * 轮询任务直到完成/失败/超时。
 * REF-001：所有生成请求必须有上限——超时抛「生成超时」而不是无限等下去。
 * @param {object} opts { timeoutMs }
 */
async function pollTask(taskId, creds, onProgress, opts = {}) {
  const timeoutMs = opts.timeoutMs || 10 * 60 * 1000
  const startedAt = Date.now()
  for (;;) {
    const d = bodyOf(await req(`/v1/tasks/${taskId}?language=zh`, {
      baseUrl: creds?.baseUrl, apiKey: creds?.apiKey
    }))?.data
    if (!d) throw new Error('任务查询响应异常')
    if (onProgress) onProgress(d.progress || 0, d.status)
    if (d.status === 'completed') return d
    if (d.status === 'failed') throw new Error(d.error?.message || '任务失败')
    if (d.status === 'cancelled') throw new Error('任务已取消')
    if (Date.now() - startedAt > timeoutMs) {
      const mins = Math.round(timeoutMs / 60000)
      const err = new Error(`生成超时（超过 ${mins} 分钟未返回），可重试或稍后查询任务状态`)
      err.timeout = true
      throw err
    }
    await new Promise((res) => setTimeout(res, 4000))
  }
}

/* BUG-2/3 修复：不同视频/图片模型的任务完成响应结构差异大（videos[].url 可能是
   字符串或数组；有的模型用 video_url / download_url / output.url 等）。旧实现只认
   result.videos[].url，提取失败会静默返回 []，卡片被置成 done 空态——用户感知
   「生成完视频卡片消失/被清空」。这里改为结构化优先 + 递归兜底扫描，绝不让
   已完成的任务因解析问题丢产物。 */
const isMediaUrl = (s) => typeof s === 'string'
  && /^(https?:\/\/|data:(image|video)\/)/i.test(s)
  && /\.(mp4|webm|mov|m3u8|png|jpe?g|webp|gif)(\?|#|$)/i.test(s)

/* P1 修复（复审报告-凌晨增量 §四，2026-11-01）：签名 CDN 链接常无扩展名（路径裸 +
   query 带签名），结构化路径若沿用扩展名校验会静默丢产物。结构化字段的语义已知是
   媒体（videos[].url / download_url 等），放宽为只验协议前缀；扩展名从严校验只保留
   在 deepCollectUrls 兜底扫描（那里语义未知，从严合理）。 */
const isLooseMediaUrl = (s) => typeof s === 'string'
  && /^(https?:\/\/|data:(image|video)\/)/i.test(s)

function deepCollectUrls(node, out, depth = 0) {
  if (!node || depth > 6 || out.length > 16) return
  if (typeof node === 'string') {
    if (isMediaUrl(node) && !out.includes(node)) out.push(node)
    return
  }
  if (Array.isArray(node)) { node.forEach((x) => deepCollectUrls(x, out, depth + 1)); return }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) deepCollectUrls(v, out, depth + 1)
  }
}

function extractMediaUrls(result, structuredKeys) {
  /* 1) 结构化路径：常见字段名优先（videos/images/video_url/download_url/output…） */
  const out = []
  const push = (u) => { if (isLooseMediaUrl(u) && !out.includes(u)) out.push(u) }
  const walkEntry = (v) => {
    if (typeof v === 'string') push(v)
    else if (Array.isArray(v)) v.forEach((x) => (typeof x === 'string' ? push(x) : walkEntry(x)))
    else if (v && typeof v === 'object') {
      for (const k of ['url', 'video_url', 'download_url', 'uri', 'src']) {
        if (v[k] !== undefined) walkEntry(v[k])
      }
    }
  }
  for (const key of structuredKeys) {
    const v = result?.[key]
    if (v === undefined || v === null) continue
    walkEntry(v)
  }
  if (out.length) return out
  /* 2) 兜底：递归扫描整个 result（深度 6、上限 16 条），保证结构再怪也能捞回产物 */
  deepCollectUrls(result, out)
  return out
}

function extractImageUrls(result) {
  return extractMediaUrls(result, ['images', 'image_urls', 'outputs', 'output', 'data'])
}
function extractVideoUrls(result) {
  return extractMediaUrls(result, ['videos', 'video_urls', 'video_url', 'outputs', 'output', 'data'])
}

/* 生成产物即时入库用的项目上下文：由 App 在项目名/会话变化时写入，
   engine 不关心 UI 状态，只调 adopt() 即可（S18 修复） */
let assetCtx = { projectName: '', sessionId: '' }
export function setAssetContext(ctx) {
  assetCtx = { ...assetCtx, ...(ctx || {}) }
}

/* 把生成产物收进项目资产库，返回等长本地 file:// 列表；
   任何失败都原样返回远端链接（生成主流程绝不因入库失败而失败） */
async function adoptAssets(urls, kind) {
  const list = Array.isArray(urls) ? urls : []
  if (!list.length || typeof window.__capReq === 'function') return list // 测试钩子：不落盘
  if (!window.flow?.assetAdopt) return list
  try {
    const r = await window.flow.assetAdopt({ urls: list, kind, ...assetCtx })
    if (r?.ok && Array.isArray(r.urls) && r.urls.length === list.length) {
      try { window.dispatchEvent(new CustomEvent('isle:assets-changed')) } catch { /* 忽略 */ }
      return r.urls
    }
  } catch { /* 入库失败保留远端链接 */ }
  return list
}

/* ---------- P2 语音合成（配音节点）----------
   p: { model, input, voice, speed, format, baseUrl, apiKey }
   返回 { ok, dataUrl, bytes, mime }；失败抛错（错误文案直接来自网关）。
   之所以不在渲染端 fetch：/v1/audio/speech 返回二进制，主进程 net 栈更稳且能统一走代理设置。
   测试钩子 __capReq 激活时走同一拦截，便于零成本验证请求体。 */
async function submitAudio(p) {
  const payload = {
    model: p.model || 'gpt-4o-mini-tts',
    input: p.input,
    voice: p.voice || 'alloy',
    speed: p.speed,
    format: p.format || 'mp3',
    baseUrl: p.baseUrl,
    apiKey: p.apiKey
  }
  if (typeof window.__capReq === 'function') {
    return window.__capReq({ path: '/v1/audio/speech', body: payload })
  }
  if (!window.flow?.audioSpeech) throw new Error('当前版本不支持语音合成，请更新应用')
  const r = await window.flow.audioSpeech(payload)
  if (!r?.ok) throw new Error(r?.error || '语音合成失败')
  return r
}

/* ---------- P3 成片合成（FFmpeg 本地管线）----------
   p: { clips, voice, opts, projectName, sessionId }；onProgress(0-100) 可选。
   返回 { ok, url, seconds }；失败抛错。 */
async function composeVideo(p, onProgress) {
  if (typeof window.__capReq === 'function') {
    return window.__capReq({ path: 'local://compose', body: p })
  }
  if (!window.flow?.composeVideo) throw new Error('当前版本不支持成片合成，请更新应用')
  const id = `c${Date.now()}${Math.floor(Math.random() * 1e4)}`
  let off
  if (onProgress) {
    off = window.flow.onComposeProgress((d) => { if (d?.id === id) onProgress(d.percent) })
  }
  try {
    /* 产物直接落当前会话的资产目录，与 adopt 同一套定位规则 */
    const r = await window.flow.composeVideo({ ...p, projectName: assetCtx.projectName, sessionId: assetCtx.sessionId, id })
    if (!r?.ok) throw new Error(r?.error || '合成失败')
    return r
  } finally {
    if (off) off()
  }
}

export const api = {
  submitImage,
  submitVideo,
  submitAudio,
  composeVideo,
  pollTask,
  extractImageUrls,
  extractVideoUrls,
  adopt: adoptAssets,
  download: (url, subdir, filename) => typeof window.__capReq === 'function'
    ? Promise.resolve({ ok: true, path: 'fake' }) // 测试钩子激活时不落盘
    : window.flow.download({ url, subdir, filename })
}

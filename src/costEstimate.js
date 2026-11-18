/* REQ-001 / TECH-004 成本预估独立模块（REQ-005/006/008 复用）
   单价来源与维护策略见 docs/PRICING.md（APIMart Gold 档 USD，抓取 2026-10-30）。
   换算口径：应用内「积分」与 APIMart Credit 1:1，1 Credit ≈ $0.1 → 预估积分 = USD × 10。
   匹配规则：模型 id 包含关键词即命中，数组顺序即优先级（越具体越靠前）。
   未命中 → 计费未知（不阻塞生成，UI 显著标识）。 */

import { topoOrder, downstreamOf } from './engine.js'

const USD_TO_CREDIT = 10

/* 图片模型：按张计。usd=1K/默认档，usd2k/usd4k 可选，缺档按倍率兜底（2K×1.8 / 4K×3.5） */
const IMAGE_PRICING = [
  { kw: 'flux-3-image-klein', usd: 0.0072, usd4k: 0.0288 },
  { kw: 'flux-3-image', usd: 0.0384, usd2k: 0.08, usd4k: 0.4856 },
  { kw: 'flux-2-pro', usd: 0.024, usd2k: 0.06 },
  { kw: 'flux-2-flex', usd: 0.04, usd2k: 0.16 },
  { kw: 'flux-2-max', usd: 0.056, usd2k: 0.128 },
  { kw: 'flux-kontext-pro', usd: 0.032 },
  { kw: 'flux-kontext-max', usd: 0.064 },
  { kw: 'gpt-image-2.5-ext', usd: 0.0085, usd2k: 0.03, usd4k: 0.04 },
  { kw: 'gpt-image-2-ext', usd: 0.0085, usd2k: 0.015, usd4k: 0.022 },
  /* 同族普通档（无 -ext 后缀）沿用 ext 价（见 PRICING.md 维护策略） */
  { kw: 'gpt-image-2.5', usd: 0.0085, usd2k: 0.03, usd4k: 0.04 },
  { kw: 'gpt-image-2', usd: 0.0085, usd2k: 0.015, usd4k: 0.022 },
  { kw: 'nano-banana-pro', usd: 0.02, usd4k: 0.03 },
  /* 4K 实测校准（2026-11-18）：gemini-nano-banana-2.1 / 16:9 / 4K 实扣 0.95 积分
     （≈0.095 USD，出图 5504×3072）。旧档 0.018 只有实际价格的 1/5，
     用户看到「0.2 积分」实扣近 1 积分——按实测值改写，宁可略高不再明显偏低。 */
  { kw: 'nano-banana-2', usd: 0.012, usd2k: 0.014, usd4k: 0.0954 },
  { kw: 'nano-banana', usd: 0.008 },
  { kw: 'gemini-3-pro-image', usd: 0.02, usd4k: 0.03 },
  { kw: 'gemini-3.1-flash-image', usd: 0.008 },
  { kw: 'gemini-2.5-flash-image', usd: 0.008 },
  { kw: 'mai-image', usd: 0.008 },
  { kw: 'seedream-5-0-flash', usd: 0.0137 },
  { kw: 'seedream-5-0-pro', usd: 0.0293, usd2k: 0.0585 },
  { kw: 'seedream-5-0-lite', usd: 0.028 },
  { kw: 'seedream', usd: 0.0195, usd2k: 0.026 },
  { kw: 'qwen-image-3.0-pro', usd: 0.0286, usd2k: 0.0571 },
  { kw: 'qwen-image', usd: 0.0206 },
  { kw: 'midjourney', usd: 0.045 },
  { kw: 'mj_', usd: 0.045 },
  { kw: '-mj', usd: 0.045 },
  /* dall-e-3 带Key实测（2026-11-01）：网关返回 500 "ratio or price is not configured"，
     属服务端未配置的不可用模型。移除定价 → 归为计费未知 → 默认模型回落自动跳过它 */
  { kw: 'imagen', usd: 0.04 },
  { kw: 'wan2.7-image', usd: 0.0216 },
  { kw: 'wan2.8-image', usd: 0.0216 },
  { kw: 'wan2.6-image', usd: 0.0216 },
  { kw: 'grok-imagine-image', usd: 0.015 },
  { kw: 'muse-image', usd: 0.0048 },
]

/* 视频模型：按秒计。BUG-6 修复：视频价格必须按分辨率分档——
   实测 seedance-2.5 1080p/5s 实扣 26 积分，旧表统一 0.0576 USD/s 只估 2.88 积分，误差 9 倍。
   分档字段：usd480/usd720/usd1080/usd4k；usd 保留为「未标注分辨率时的兜底档（≈720p）」。
   价目来源：APIMart 官方页/模型页（2026-10-31 抓取，官方档不打会员折）+ 用户实测反推。
   视频按 token 结算，预估仅供参考——UI 提示已在审批卡注明。 */
const VIDEO_PRICING = [
  /* seedance-2.5：480p 0.096 / 720p 0.216（官方博客）；1080p 用用户实测 0.52/s；
     4K 官方不支持该模型，误选按 1080p 计 */
  { kw: 'seedance-2.5', usd: 0.216, usd480: 0.096, usd720: 0.216, usd1080: 0.52, usd4k: 0.52 },
  { kw: 'seedance-2-5', usd: 0.216, usd480: 0.096, usd720: 0.216, usd1080: 0.52, usd4k: 0.52 },
  /* seedance-2.0：官方档 480p 0.0825 / 720p 0.1775 / 1080p 0.443 / 4k 0.9025 */
  { kw: 'seedance-2.0-fast', usd: 0.071, usd480: 0.033, usd720: 0.071, usd1080: 0.1772, usd4k: 0.3616 },
  { kw: 'seedance-2-0-fast', usd: 0.071, usd480: 0.033, usd720: 0.071, usd1080: 0.1772, usd4k: 0.3616 },
  { kw: 'seedance-2.0', usd: 0.1775, usd480: 0.0825, usd720: 0.1775, usd1080: 0.443, usd4k: 0.9025 },
  { kw: 'seedance-2-0', usd: 0.1775, usd480: 0.0825, usd720: 0.1775, usd1080: 0.443, usd4k: 0.9025 },
  /* seedance 1.5 pro：480p 0.0204 / 720p 0.044 / 1080p 0.108（官方博客） */
  { kw: 'seedance-1-5-pro', usd: 0.044, usd480: 0.0204, usd720: 0.044, usd1080: 0.108, usd4k: 0.216 },
  { kw: 'seedance-1-0-pro-fast', usd: 0.0088 },
  /* seedance 兜底：取 2.0 档位（宁高勿低） */
  { kw: 'seedance', usd: 0.1775, usd480: 0.0825, usd720: 0.1775, usd1080: 0.443, usd4k: 0.9025 },
  /* kling v4（1.2.0）：官方分档未公开，暂按 v3 档位上浮 40% 保守估（实测后回填）；
     宁可估高一点，避免「按钮显示 3 积分、实际扣 8 积分」 */
  { kw: 'kling-v4', usd: 0.12, usd480: 0.07, usd720: 0.12, usd1080: 0.24, usd4k: 0.48 },
  /* kling v3：标准 720p 0.084/s、1080p 0.168/s（官方对比 fal 页）；v3 pro 加倍；兜底 0.05 起 */
  { kw: 'kling-v3', usd: 0.084, usd480: 0.05, usd720: 0.084, usd1080: 0.168, usd4k: 0.336 },
  { kw: 'kling', usd: 0.05, usd480: 0.03, usd720: 0.05, usd1080: 0.10, usd4k: 0.20 },
  /* veo3.1：fast 1080p 官方 0.10（无音频）/0.15（有音频）；quality 0.16 起 */
  { kw: 'veo3.1-quality', usd: 0.16, usd480: 0.08, usd720: 0.12, usd1080: 0.16, usd4k: 0.32 },
  { kw: 'veo', usd: 0.10, usd480: 0.06, usd720: 0.10, usd1080: 0.15, usd4k: 0.30 },
  /* hailuo / wan / vidu / pixverse：官方分档数据待补，先按 720p 单档并上浮 720→1080 倍率兜底 */
  { kw: 'minimax-hailuo-2.3-fast', usd: 0.0248 },
  { kw: 'minimax-hailuo', usd: 0.0488 },
  { kw: 'hailuo-2.3-fast', usd: 0.0248 },
  { kw: 'hailuo', usd: 0.0488 },
  { kw: 'minimax-h3', usd: 0.0377 },
  { kw: 'wan', usd: 0.05 },
  { kw: 'vidu', usd: 0.04 },
  { kw: 'pixverse', usd: 0.016 },
  { kw: 'grok-imagine-1.5-video', usd: 0.0102 },
  { kw: 'grok-imagine', usd: 0.0102 },
  { kw: 'sora', unknown: true },
]

/* 分辨率 → 视频单价档位：未标注按 usd（≈720p 兜底）；缺档按相邻档倍率推（宁高勿低） */
function videoUsdFor(r, res) {
  const s = String(res || '').toLowerCase()
  if (s.includes('480')) return r.usd480 ?? (r.usd720 ?? r.usd) * 0.5
  if (s.includes('1080')) return r.usd1080 ?? (r.usd720 ?? r.usd) * 2.5
  /* 2K（MiniMax-H3 等大写档位）：介于 1080p 与 4k 之间按 1.5 倍估 */
  if (s.includes('2k') || s.includes('1440')) return r.usd2k ?? (r.usd1080 ?? r.usd720 ?? r.usd) * 1.5
  if (s.includes('4k') || s.includes('2160')) return r.usd4k ?? (r.usd1080 ?? (r.usd720 ?? r.usd) * 2.5) * 2
  return r.usd720 ?? r.usd
}

const findRule = (list, model) => {
  const s = String(model || '').toLowerCase()
  return list.find((r) => s.includes(r.kw))
}

/**
 * 单节点成本预估。
 * @returns {{applicable:boolean, known?:boolean, credits?:number, detail?:string}}
 *   applicable=false：上传卡/未选模型等不参与计价的节点
 *   known=false：模型无定价数据（计费未知）
 */
export function estimateNodeCost(node) {
  const d = node?.data
  if (!d || d.uploaded || (node.type !== 'image' && node.type !== 'video') || !d.model) {
    return { applicable: false }
  }
  const res = String(d.resolution || '').toLowerCase()
  if (node.type === 'image' || d.kind === 'image') {
    const r = findRule(IMAGE_PRICING, d.model)
    if (!r) return { applicable: true, known: false }
    const n = Math.max(1, Number(d.n) || 1)
    let usd = r.usd
    if (res.includes('2k')) usd = r.usd2k ?? r.usd * 1.8
    /* 4K 缺档按 5 倍估（2026-11-18 实测：nano-banana 2.1 4K ≈ 1K 的 8 倍，
       flux/gpt-image 系多在 4~6 倍）。旧倍率 3.5 明显偏低，宁可估高 */
    else if (res.includes('4k')) usd = r.usd4k ?? r.usd * 5
    const credits = Math.round(usd * n * USD_TO_CREDIT * 100) / 100
    return {
      applicable: true, known: true, credits,
      detail: `${d.model} · ${res || '默认分辨率'}${n > 1 ? ` · ${n} 张` : ''}`
    }
  }
  const r = findRule(VIDEO_PRICING, d.model)
  if (!r || r.unknown) return { applicable: true, known: false }
  const sec = Math.max(1, Number(d.duration) || 5)
  const usd = videoUsdFor(r, d.resolution)
  const credits = Math.round(usd * sec * USD_TO_CREDIT * 100) / 100
  return { applicable: true, known: true, credits, detail: `${d.model} · ${res || '默认分辨率'} · ${sec}s` }
}

/**
 * 流程成本预估（与 engine.runFlow 的目标筛选口径一致）。
 * @param opts.skipDone 与 Agent run_all 的 skipDone 语义一致：跳过已完成节点
 * @returns {{known:boolean, total:number, unknownCount:number, items:Array<{id,known,credits,detail}>}}
 */
export function estimateFlowCost(nodes, edges, { onlyId, fromId, skipDone } = {}) {
  const { order } = topoOrder(nodes, edges)
  let targets = order
  if (onlyId) targets = order.filter((n) => n.id === onlyId)
  else if (fromId) {
    const set = downstreamOf(fromId, edges)
    targets = order.filter((n) => set.has(n.id))
  } else if (skipDone) targets = targets.filter((n) => n.data?.status !== 'done')
  const items = targets.map((n) => {
    const est = estimateNodeCost(n)
    return {
      id: n.id,
      label: n.data?.label || n.type,
      model: n.data?.model || '',
      known: est.known === true,
      credits: est.known ? est.credits : 0,
      detail: est.detail || ''
    }
  })
  const unknownCount = items.filter((x) => !x.known).length
  return {
    known: unknownCount === 0 && items.length > 0,
    total: Math.round(items.reduce((a, x) => a + x.credits, 0) * 100) / 100,
    unknownCount,
    items
  }
}

/**
 * 计费已知判断（默认模型回落用）。
 * 带Key实测（2026-11-01）：网关对未配置定价的模型直接 500（如 dall-e-3
 * "ratio or price is not configured"），默认回落到这类模型=委托必失败。
 * 回落策略：优先选计费已知的模型（有定价规则≈经过验证的可用模型）。
 */
export function modelPricingKnown(model, kind) {
  const r = findRule(kind === 'video' ? VIDEO_PRICING : IMAGE_PRICING, model)
  return !!(r && !r.unknown)
}

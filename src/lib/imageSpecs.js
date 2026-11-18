/* 图片模型尺寸口径表（1.2.0 · 2026-11-18 网关实测）
 *
 * 背景：面板此前对全部图片模型都给同一套 1K/2K/4K，但网关各模型的接受口径完全不同：
 *   - 比例型：size 必须是 "16:9"，档位由 resolution 决定（gemini 系）；
 *              传像素会直接 400：unsupported image aspect ratio "2048x1152"
 *   - 像素型：size 必须是 "1024x1536"，且宽高需为 16 的倍数；传比例会 400
 *   - 不支持型：异步任务不接受 size（grok），或由模型自选尺寸（muse）
 * 并且「4K」并不是每个模型都到得了：qwen/mai 只到 2K、seedream-5-pro 只到 2K、
 * flux-2 上限 4MP、z-image 上限 4MP。用户选了 4K 却拿到 5504×3072（gemini 4K 实际画布）
 * 或直接被网关拒绝，是「4K 图不是 4K」的根因。
 *
 * 本表只收录**实测有依据**的约束；未收录的模型返回 null = 不裁剪（保持 1K/2K/4K 全档）。
 * kw 按 includes 匹配，越靠前越优先（与 modelSpecs / costEstimate 同一套规则表模式）。
 */

/* 默认档位（与面板历史上的 IMG_RES 一致） */
export const IMG_TIERS = ['1K', '2K', '4K']

/* 各档 × 比例的标准像素（与网关/参考实现口径一致，用于「预计输出」提示） */
export const IMG_PIXELS = {
  '1K': { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024', '4:3': '1024x768', '3:4': '768x1024', '16:9': '1536x864', '9:16': '864x1536', '21:9': '2016x864' },
  '2K': { '1:1': '2048x2048', '2:3': '1360x2048', '3:2': '2048x1360', '4:3': '2048x1536', '3:4': '1536x2048', '16:9': '2048x1152', '9:16': '1152x2048', '21:9': '2688x1152' },
  '4K': { '1:1': '2880x2880', '2:3': '2336x3520', '3:2': '3520x2336', '4:3': '3312x2480', '3:4': '2480x3312', '16:9': '3840x2160', '9:16': '2160x3840', '21:9': '3840x1648' }
}

/* gpt-image-1.5 / dall-e-3 这类只认固定像素尺寸的模型 */
const FIXED_GPT_SIZES = {
  '1:1': '1024x1024', '4:3': '1536x1024', '3:2': '1536x1024', '16:9': '1536x1024',
  '21:9': '1536x1024', '3:4': '1024x1536', '2:3': '1024x1536', '9:16': '1024x1536'
}

export const IMAGE_MODEL_SPECS = [
  /* ---- gemini 系：比例型，4K 档实际画布不是 3840×2160（实测 5504×3072） ---- */
  {
    kw: 'nano-banana-2.1', resolutions: ['1K', '2K', '4K'], sizeMode: 'ratio',
    actualAt: { '4K': '5504×3072' },
    note: '4K 档实际输出 5504×3072（约 17MP），不是 3840×2160'
  },
  { kw: 'nano-banana-2', resolutions: ['1K', '2K', '4K'], sizeMode: 'ratio', actualAt: { '4K': '5504×3072' } },
  { kw: 'nano-banana', resolutions: ['1K', '2K'], sizeMode: 'ratio' },
  { kw: 'gemini-3-pro-image', resolutions: ['1K', '2K', '4K'], sizeMode: 'ratio', actualAt: { '4K': '4096×2304' } },
  { kw: 'gemini-3.1-flash-lite-image', resolutions: ['1K', '2K'], sizeMode: 'ratio' },
  { kw: 'gemini-2.5-flash-image', resolutions: ['1K'], sizeMode: 'ratio' },

  /* ---- gpt-image：像素型 ---- */
  {
    kw: 'gpt-image-1.5', resolutions: [], sizeMode: 'pixel', pixelSizes: FIXED_GPT_SIZES,
    note: '该模型只支持 1024×1024 / 1536×1024 / 1024×1536，无法选档位'
  },
  { kw: 'gpt-image-2', resolutions: ['1K', '2K', '4K'], sizeMode: 'ratio' },
  { kw: 'gpt-image-1', resolutions: [], sizeMode: 'pixel', pixelSizes: FIXED_GPT_SIZES },

  /* ---- seedream：pro 只到 2K；总像素上限 4.62MP ---- */
  {
    kw: 'seedream-5-0-pro', resolutions: ['1K', '2K'], sizeMode: 'ratio',
    note: '最高 2K（总像素上限 4.62MP，物理上不到 4K）'
  },
  { kw: 'seedream-5-0-flash', resolutions: ['1K', '2K'], sizeMode: 'ratio' },
  { kw: 'seedream-5-0-lite', resolutions: ['1K', '2K'], sizeMode: 'ratio' },
  { kw: 'seedream-4', resolutions: ['1K', '2K', '4K'], sizeMode: 'ratio' },

  /* ---- flux：2 系按 MP 计（上限 4MP ≈ 2K），3 系才有 4K 档 ---- */
  { kw: 'flux-2', resolutions: ['1K', '2K'], sizeMode: 'ratio', note: '按 MP 计费，上限 4MP，没有 4K 档' },
  { kw: 'flux-3-image', resolutions: ['1K', '2K', '4K'], sizeMode: 'ratio' },
  { kw: 'flux-kontext', resolutions: ['1K'], sizeMode: 'ratio' },

  /* ---- 通义 / MAI / 海艺：只到 2K；hy 有 4K ---- */
  { kw: 'qwen-image', resolutions: ['1K', '2K'], sizeMode: 'ratio', note: '最高 2K（像素上限 2560×2560）' },
  { kw: 'mai-image', resolutions: ['1K', '2K'], sizeMode: 'ratio' },
  { kw: 'hy-image', resolutions: ['1K', '2K', '4K'], sizeMode: 'ratio' },

  /* ---- 特殊：不吃 size / resolution ---- */
  { kw: 'grok-imagine-image', resolutions: ['1K', '2K'], sizeMode: 'none', note: 'xAI 异步任务不接受 size 参数，比例由提示词描述' },
  { kw: 'muse-image', resolutions: [], sizeMode: 'none', note: '尺寸由模型自选，不能指定比例与档位' },
  { kw: 'z-image', resolutions: ['1K', '2K'], sizeMode: 'ratio', note: '像素上限 4MP，最高 2K' }
]

/** 按模型名匹配能力表；无收录 → null（不裁剪） */
export function matchImageSpec(model) {
  const s = String(model || '').toLowerCase()
  if (!s) return null
  return IMAGE_MODEL_SPECS.find((r) => s.includes(r.kw)) || null
}

/** 面板可选档位：无收录 → 全档；收录但为空 → 不给档位（固定尺寸模型） */
export function imageResOptions(model) {
  const spec = matchImageSpec(model)
  if (!spec) return IMG_TIERS
  return spec.resolutions || IMG_TIERS
}

const tierIndex = (t) => {
  const i = IMG_TIERS.indexOf(String(t || '').toUpperCase())
  return i < 0 ? 1 : i
}

/**
 * 按模型能力收敛图片参数。面板切模型时调用一次，提交前 engine 再兜一次，
 * 保证历史节点/旧项目里的非法组合（例如 4K 但模型只到 2K）不会打出去报错扣费。
 * @returns {{params: object, notes: string[]}}
 */
export function sanitizeImageParams(model, params = {}) {
  const spec = matchImageSpec(model)
  if (!spec) return { params: { ...params }, notes: [] }
  const next = { ...params }
  const notes = []
  const tiers = spec.resolutions || IMG_TIERS

  if (tiers.length === 0) {
    if (next.resolution) { notes.push(`分辨率 ${next.resolution} → 不指定`); next.resolution = '' }
  } else {
    const cur = String(next.resolution || '').toUpperCase()
    const hit = tiers.find((t) => t.toUpperCase() === cur)
    if (!hit) {
      /* 就近向下取该模型最高档（4K → 2K 这种降级要明确告诉用户） */
      const target = tiers[Math.min(tierIndex(cur), tiers.length - 1)]
      if (cur && cur !== target) notes.push(`分辨率 ${next.resolution} → ${target}（该模型不支持更高档）`)
      next.resolution = target
    } else {
      next.resolution = hit
    }
  }

  if (spec.sizeMode === 'none') {
    if (next.size && next.size !== 'Auto') { notes.push(`画幅 ${next.size} → 不指定`); next.size = '' }
  } else if (spec.pixelSizes && next.size) {
    const mapped = spec.pixelSizes[next.size]
    if (mapped && mapped !== next.size) {
      next.size = mapped
      notes.push(`画幅 → ${mapped}`)
    }
  }
  return { params: next, notes }
}

/** 提交给网关的 size：固定像素模型做映射，其余原样（比例字符串） */
export function requestSizeFor(model, size) {
  const spec = matchImageSpec(model)
  if (!spec || !size) return size
  if (spec.sizeMode === 'none') return ''
  if (spec.pixelSizes) return spec.pixelSizes[size] || size
  return size
}

/**
 * 「预计输出像素」人话提示，用于面板显示，避免用户以为 4K 一定是 3840×2160。
 * 有实测值的优先用实测值。
 */
export function pixelHint(model, size, resolution) {
  const spec = matchImageSpec(model)
  if (spec?.sizeMode === 'none') return spec.note || '尺寸由模型决定'
  const tier = String(resolution || '').toUpperCase()
  if (spec?.actualAt?.[tier]) return `实际 ${spec.actualAt[tier]}`
  if (!tier || !IMG_PIXELS[tier]) return ''
  const px = IMG_PIXELS[tier][size] || (tier === '1K' ? '' : '')
  if (!px) return ''
  const [w, h] = px.split('x')
  const mp = ((+w * +h) / 1e6).toFixed(1)
  return `约 ${w}×${h}（${mp}MP）`
}

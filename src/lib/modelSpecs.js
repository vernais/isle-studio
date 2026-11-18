/* 问题3：视频模型参数能力表（依据 apimart 官方文档/博客，2026-10 核对）
 *
 * 背景：不同视频模型参数能力差异很大（时长枚举、分辨率档位、是否支持 AI 音频、
 * 支持的画幅比例都不同），而且分辨率大小写也不同（720p vs 768P/1080P/2K）。
 * 面板此前对全部模型给同一套 480p~4k / 4~15s 参数，选到模型不支持的组合直接报错。
 *
 * 原则：只收录有官方依据的约束；没有把握的模型不出现在表里（返回 null = 不裁剪）。
 * kw 按 includes 匹配，越靠前越优先（同 costEstimate 的规则表模式）。
 */

/* 分辨率档位高度（比较用，全部小写；2K≈1440p） */
const RES_H = { '480p': 480, '540p': 540, '720p': 720, '768p': 768, '1080p': 1080, '2k': 1440, '4k': 2160 }

/* 画幅比值（对数距离最近映射用） */
const SIZE_RATIO = {
  '21:9': 21 / 9, '16:9': 16 / 9, '3:2': 1.5, '4:3': 4 / 3, '5:4': 1.25, '1:1': 1,
  '4:5': 0.8, '3:4': 0.75, '2:3': 2 / 3, '9:16': 9 / 16
}

export const VIDEO_MODEL_SPECS = [
  /* Veo 3.1：官方固定 4/6/8 秒，720p/1080p，仅 16:9 / 9:16 */
  { kw: 'veo3.1', durations: [4, 6, 8], resolutions: ['720p', '1080p'], sizes: ['16:9', '9:16'], audio: true },

  /* Kling v2.x：官方 5/10 秒；v3 3~15（官方 4K 模式映射 4k 档）；v4 文档 3~30、720p/1080p */
  { kw: 'kling-v2', durations: [5, 10], resolutions: ['720p', '1080p'], sizes: ['16:9', '9:16', '1:1'], audio: true },
  { kw: 'kling-v3', durations: { min: 3, max: 15 }, resolutions: ['720p', '1080p', '4k'], sizes: ['16:9', '9:16', '1:1', '21:9'], audio: true },
  { kw: 'kling-v4', durations: { min: 3, max: 30 }, resolutions: ['720p', '1080p'], sizes: ['16:9', '9:16', '1:1', '21:9'], audio: true },
  { kw: 'kling', durations: { min: 3, max: 15 }, resolutions: ['720p', '1080p'], sizes: ['16:9', '9:16', '1:1'], audio: true },

  /* Seedance：2.0 fast/mini 只到 720p；2.0 标准到 4k；2.5 官方 4~30s（1080p 有实测计费，保留） */
  { kw: 'seedance-2.0-fast', durations: { min: 4, max: 15 }, resolutions: ['480p', '720p'], sizes: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true },
  { kw: 'seedance-2-0-fast', durations: { min: 4, max: 15 }, resolutions: ['480p', '720p'], sizes: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true },
  { kw: 'seedance-2.0-mini', durations: { min: 4, max: 15 }, resolutions: ['480p', '720p'], sizes: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true },
  { kw: 'seedance-2-0-mini', durations: { min: 4, max: 15 }, resolutions: ['480p', '720p'], sizes: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true },
  { kw: 'seedance-2.5', durations: { min: 4, max: 30 }, resolutions: ['480p', '720p', '1080p'], sizes: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true },
  { kw: 'seedance-2-5', durations: { min: 4, max: 30 }, resolutions: ['480p', '720p', '1080p'], sizes: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true },
  { kw: 'seedance-2.0', durations: { min: 4, max: 15 }, resolutions: ['480p', '720p', '1080p', '4k'], sizes: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true },
  { kw: 'seedance-2-0', durations: { min: 4, max: 15 }, resolutions: ['480p', '720p', '1080p', '4k'], sizes: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true },

  /* MiniMax H3：4~15s，768P/2K（注意大写档位）；Hailuo 2.3 固定 6/10s、768P/1080P、无音频 */
  { kw: 'minimax-h3', durations: { min: 4, max: 15 }, resolutions: ['768P', '2K'], sizes: ['16:9', '9:16'], audio: true },
  { kw: 'minimax-hailuo-2.3', durations: [6, 10], resolutions: ['768P', '1080P'], sizes: ['16:9', '9:16'], audio: false },
  { kw: 'minimax-hailuo-02', durations: [6, 10], resolutions: ['768P', '1080P'], sizes: ['16:9', '9:16'], audio: true },
  { kw: 'hailuo-2.3', durations: [6, 10], resolutions: ['768P', '1080P'], sizes: ['16:9', '9:16'], audio: false },

  /* Wan 2.7 / 3.0：720P/1080P（大写）；2.5/2.6 档位更宽但官方页面未列全，只裁分辨率下限档 */
  { kw: 'wan2.7', durations: { min: 2, max: 15 }, resolutions: ['720P', '1080P'], sizes: ['16:9', '9:16', '1:1'] },
  { kw: 'wan3.0', durations: { min: 2, max: 15 }, resolutions: ['720P', '1080P'], sizes: ['16:9', '9:16', '1:1'] },
  { kw: 'wan2.5', durations: { min: 3, max: 15 }, resolutions: ['480P', '720P', '1080P'], sizes: ['16:9', '9:16', '1:1'] },
  { kw: 'wan2.6', durations: { min: 3, max: 15 }, resolutions: ['480P', '720P', '1080P'], sizes: ['16:9', '9:16', '1:1'] },

  /* Vidu Q3/Q4：3~16s，540p/720p/1080p */
  { kw: 'viduq', durations: { min: 3, max: 16 }, resolutions: ['540p', '720p', '1080p'], sizes: ['16:9', '9:16', '1:1'] },

  /* Grok Imagine：1.5 才有 1080p（官方对比表），1.0 只到 720p */
  { kw: 'grok-imagine-1.5', resolutions: ['480p', '720p', '1080p'] },
  { kw: 'grok-imagine', resolutions: ['480p', '720p'] }
]

/** 按模型名匹配能力表；无收录 → null（不裁剪，面板保持全量） */
export function matchVideoSpec(model) {
  const s = String(model || '').toLowerCase()
  if (!s) return null
  return VIDEO_MODEL_SPECS.find((r) => s.includes(r.kw)) || null
}

/* ---------- 内部工具 ---------- */
const resHeight = (r) => RES_H[String(r || '').toLowerCase()]
function nearestRes(list, cur) {
  const h = resHeight(cur)
  if (!h) return list.find((r) => String(r).toLowerCase() === '720p') || list[0]
  /* 优先不降画质：在 ≥ 当前高度的候选里取最近；全部低于当前才取最高档 */
  const up = list.filter((r) => resHeight(r) >= h)
  const pool = up.length ? up : [list.reduce((a, b) => (resHeight(b) > resHeight(a) ? b : a))]
  return pool.reduce((a, b) => (Math.abs(resHeight(b) - h) < Math.abs(resHeight(a) - h) ? b : a))
}
const ratioOf = (sz) => {
  const [w, h] = String(sz || '').split(':').map(Number)
  return w > 0 && h > 0 ? w / h : null
}
function nearestSize(list, cur) {
  const r = ratioOf(cur)
  if (!r) return list[0]
  return list.reduce((a, b) => (Math.abs(Math.log(ratioOf(b)) - Math.log(r)) < Math.abs(Math.log(ratioOf(a)) - Math.log(r)) ? b : a))
}

/**
 * 按模型能力裁剪视频参数。engine 提交前与参数面板共用同一份逻辑，保证
 * 「面板里选不出非法组合」之外，历史节点/旧数据里的非法值也会被兜住。
 * @returns {{params: object, notes: string[]}} notes 为「原值 → 新值」的人话说明
 */
export function sanitizeVideoParams(model, params = {}) {
  const spec = matchVideoSpec(model)
  if (!spec) return { params: { ...params }, notes: [] }
  const next = { ...params }
  const notes = []

  if (spec.resolutions?.length) {
    const cur = String(next.resolution || '').toLowerCase()
    const hit = spec.resolutions.find((r) => String(r).toLowerCase() === cur)
    if (!hit) {
      const to = nearestRes(spec.resolutions, cur)
      if (String(next.resolution || '').toLowerCase() !== String(to).toLowerCase()) {
        notes.push(`分辨率 ${next.resolution || '（空）'} → ${to}`)
      }
      next.resolution = to
    } else {
      next.resolution = hit // 统一成官方大小写（如 720p → 768P）
    }
  }

  if (spec.durations) {
    const dv = Number(next.duration)
    if (!Number.isFinite(dv) || dv <= 0) {
      next.duration = spec.durations[0]
    } else if (Array.isArray(spec.durations)) {
      const to = spec.durations.reduce((a, b) => (Math.abs(b - dv) < Math.abs(a - dv) ? b : a))
      if (to !== dv) { notes.push(`时长 ${dv}s → ${to}s（该模型仅支持 ${spec.durations.join('/')}s）`); next.duration = to }
    } else {
      const { min: lo, max: hi } = spec.durations
      if (dv < lo || dv > hi) {
        const to = Math.min(hi, Math.max(lo, Math.round(dv)))
        notes.push(`时长 ${dv}s → ${to}s（范围 ${lo}~${hi}s）`); next.duration = to
      }
    }
  }

  if (spec.sizes?.length && next.size) {
    const hit = spec.sizes.find((s) => s === next.size)
    if (!hit) {
      const to = nearestSize(spec.sizes, next.size)
      if (to !== next.size) { notes.push(`画幅 ${next.size} → ${to}`); next.size = to }
    }
  }

  if (spec.audio === false && next.audio !== undefined) {
    delete next.audio
    notes.push('该模型不支持 AI 音频，已忽略开关')
  }
  return { params: next, notes }
}

/** 面板摘要：一句话说明该模型支持什么（无 spec 返回 ''） */
export function specSummary(spec) {
  if (!spec) return ''
  const parts = []
  if (spec.resolutions?.length) parts.push(spec.resolutions.join(' / '))
  if (spec.durations) parts.push(Array.isArray(spec.durations) ? `${spec.durations.join('/')}s` : `${spec.durations.min}~${spec.durations.max}s`)
  if (spec.audio === false) parts.push('不支持 AI 音频')
  return parts.length ? `该模型支持：${parts.join(' · ')}` : ''
}

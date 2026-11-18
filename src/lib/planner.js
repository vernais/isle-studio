/* S17-2 首页规划：brief → 澄清 → 执行计划 → 计划卡
   - 计划只描述「要做几步、每步用什么模型、什么参数」，不直接发任何生成请求；
   - 计划落地成画布由 buildPlanGraph 产出，费用预估走 costEstimate.js（与画布审批卡同一口径）；
   - 对话模型不可用时退回确定性启发式方案，保证首页永远能给出可执行的计划。 */
import { estimateFlowCost, modelPricingKnown } from '../costEstimate.js'
import { makeImageNode, makeVideoNode, makeTextNode } from '../nodes.jsx'
import { mdPlain } from './mdplain.js'

export const PLAN_MAX_ROUNDS = 3
const MAX_STEPS = 6

export const PLANNER_SYSTEM_PROMPT = `你是 Isle 的创作规划助手，负责把用户一句话的想法变成可执行的画布方案。
工作方式：
1. 信息不足时先提问，一次只问一个最关键的缺失信息（画面比例、分辨率/尺寸、视频时长、是否需要配音或字幕、风格参考）。最多 3 轮。
2. 信息足够后直接给出执行计划，不再提问。
3. 你只做规划，不要执行、不要解释工具、不要寒暄。

严格只输出 JSON，不要任何多余文字：
- 需要提问：{"ask":"一句具体的问题"}
- 给出计划：{"title":"计划名（不超过 16 字）","summary":"一句话说明","steps":[步骤对象]}

步骤对象字段：
{"kind":"text|image|video","title":"步骤名（不超过 12 字）","prompt":"交给生成模型的完整提示词","size":"画面比例，如 1:1 / 16:9 / 3:4","resolution":"图片填 1K/2K/4K，视频填 480p/720p/1080p","duration":视频秒数,"n":图片张数,"deps":[依赖的步骤序号，从 1 开始]}

规则：
- 纯文案/提示词用 text；画面用 image；动态成片用 video
- 视频要基于图片时，先写 image 步骤，video 步骤的 deps 指向该图片步骤序号
- 步骤最多 6 个；deps 只能指向更靠前的步骤
- 画面比例、分辨率、时长要与用户要求一致；用户没说时用最通用的取值（图片 1:1 / 2K，视频 720p / 5 秒）
- 提示词要具体、可直接用于生成，不要写"按用户要求"这类空话
- 所有输出（title/summary/prompt）一律纯文本，禁止任何 Markdown 符号（**、#、*、\`）——它们会被原样画到画布上`

/* 从模型回复里抠出 JSON 对象（容忍 ```json 包裹与前后废话） */
export function extractJson(text) {
  const s = String(text || '').replace(/```json/gi, '```').trim()
  const i = s.indexOf('{')
  if (i < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let k = i; k < s.length; k++) {
    const c = s[k]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(s.slice(i, k + 1)) } catch { return null }
      }
    }
  }
  return null
}

const KINDS = new Set(['text', 'image', 'video'])

/* 模型给的计划要做结构校验：错的步骤宁可丢掉，也不能把半成品计划画到画布上 */
export function normalizePlan(raw) {
  const steps = Array.isArray(raw?.steps) ? raw.steps : []
  const out = []
  steps.slice(0, MAX_STEPS).forEach((s, i) => {
    const kind = KINDS.has(s?.kind) ? s.kind : 'image'
    const prompt = mdPlain(s?.prompt) // B-3：模型偶发把 **加粗** 写进提示词，画布上必须纯文本
    if (!prompt) return
    const deps = (Array.isArray(s?.deps) ? s.deps : [])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= out.length)
    out.push({
      kind,
      title: mdPlain(String(s?.title || '')).trim().slice(0, 24) || (kind === 'video' ? '视频生成' : kind === 'text' ? '提示词' : '画面生成'),
      prompt,
      size: typeof s?.size === 'string' ? s.size : '',
      resolution: typeof s?.resolution === 'string' ? s.resolution : '',
      duration: Number(s?.duration) > 0 ? Math.min(20, Number(s.duration)) : undefined,
      n: Number(s?.n) > 0 ? Math.min(4, Math.round(Number(s.n))) : undefined,
      deps: [...new Set(deps)]
    })
  })
  if (!out.length) return null
  return {
    title: mdPlain(String(raw?.title || '')).trim().slice(0, 24) || '执行计划',
    summary: mdPlain(String(raw?.summary || '')).slice(0, 80),
    steps: out,
    source: 'model'
  }
}

/* 模型回复 → { ask } 或 { plan } */
export function parsePlannerReply(text) {
  const obj = extractJson(text)
  if (!obj) return null
  const ask = typeof obj.ask === 'string' ? obj.ask.trim() : ''
  if (ask && !obj.steps) return { ask }
  const plan = normalizePlan(obj)
  return plan ? { plan } : (ask ? { ask } : null)
}

/* 没有对话模型 / 模型回复不可用时的兜底方案：仍然给出可执行的结构，不静默失败 */
export function heuristicPlan(brief) {
  const b = String(brief || '').trim()
  const wantsVideo = /视频|短片|动画|运镜|镜头|动态|mv|广告片|片头|卡点/i.test(b)
  const wantsCopy = /文案|标题|字幕|口号|slogan|卖点|口播|旁白/i.test(b)
  const steps = []
  if (wantsCopy) {
    steps.push({ kind: 'text', title: '提示词 / 文案', prompt: b, deps: [] })
  }
  steps.push({
    kind: 'image',
    title: wantsVideo ? '首帧画面' : '画面生成',
    prompt: b,
    size: '16:9', resolution: '2K', n: 1,
    deps: wantsCopy ? [1] : []
  })
  if (wantsVideo) {
    steps.push({
      kind: 'video',
      title: '视频生成',
      prompt: `${b}，镜头运动自然，画面稳定，光线统一`,
      size: '16:9', resolution: '720p', duration: 5,
      deps: [steps.length]
    })
  }
  return {
    title: b.slice(0, 14) || '新作品',
    summary: wantsVideo ? '先出首帧画面，再生成成片' : '按单张画面的通用结构执行',
    steps,
    source: 'heuristic'
  }
}

/* 选模型：计划里指定的优先，其次优先计费已知（未定价模型大概率网关未配置，
   带Key实测 dall-e-3 直接 500 "ratio or price is not configured"），全部未知才落首个 */
function pickModel(kind, wanted, models, defaults = {}) {
  const pool = kind === 'video' ? (models.video || []) : (models.image || [])
  if (wanted && pool.includes(wanted)) return wanted
  // 设置里的默认模型（仍启用）次优先
  const dm = defaults[kind]
  if (dm && pool.includes(dm)) return dm
  // 回落：计费已知优先（未定价模型大概率网关未配置，实测会 500）
  const known = pool.find((m) => modelPricingKnown(m, kind === 'video' ? 'video' : 'image'))
  return known || pool[0] || ''
}

/* 计划 → 画布节点与连线（纯函数，不碰 React 状态；预览与落地共用同一份实现）
   opts.defaults：设置里的 defaultModels（{image,video}），规划落图同样尊重用户选择 */
export function buildPlanGraph(plan, { models = {}, defaults = {}, nextId } = {}) {
  const steps = plan?.steps || []
  let seq = 0
  const makeId = typeof nextId === 'function' ? nextId : () => 'p' + (++seq)
  const ids = []
  const nodes = steps.map((s, i) => {
    const pos = { x: 80 + i * 460, y: 120 }
    const id = makeId()
    ids.push(id)
    if (s.kind === 'text') {
      const n = makeTextNode(pos)
      return { ...n, id, data: { ...n.data, label: '提示词', text: s.prompt, prompt: s.prompt } }
    }
    if (s.kind === 'video') {
      const n = makeVideoNode(pos, {
        size: s.size || '16:9',
        resolution: s.resolution || '720p',
        duration: s.duration || 5,
        model: pickModel('video', s.model, models, defaults)
      })
      return { ...n, id, data: { ...n.data, prompt: s.prompt, audio: s.audio !== false } }
    }
    const n = makeImageNode(pos, {
      size: s.size || '1:1',
      resolution: s.resolution || '2K',
      n: s.n || 1,
      model: pickModel('image', s.model, models, defaults)
    })
    return { ...n, id, data: { ...n.data, prompt: s.prompt } }
  })

  const edges = []
  steps.forEach((s, i) => {
    for (const d of s.deps || []) {
      const src = ids[d - 1]
      if (!src || !ids[i]) continue
      const targetHandle = steps[i].kind === 'text' ? 'in-text' : 'in-img'
      edges.push({
        id: `e_${src}__${ids[i]}`,
        source: src, sourceHandle: 'out',
        target: ids[i], targetHandle,
        type: 'flow', animated: true
      })
    }
  })
  return { nodes, edges }
}

/* 费用预估：与画布审批卡完全同一口径（costEstimate.estimateFlowCost）
   提示词节点不参与计费，计划卡里不列也不计入「计费未知」，避免虚报未知项 */
export function estimatePlan(plan, { models = {} } = {}) {
  let seq = 0
  const { nodes, edges } = buildPlanGraph(plan, { models, nextId: () => 'preview_' + (++seq) })
  const est = estimateFlowCost(nodes, edges)
  const idxById = new Map(nodes.map((n, i) => [n.id, i]))
  const items = est.items
    .map((it) => {
      const idx = idxById.get(it.id)
      return {
        ...it,
        type: nodes[idx]?.type,
        label: plan?.steps?.[idx]?.title || it.label,
        /* 卡片左侧已并列展示模型名，细节行去掉重复的模型前缀 */
        detail: String(it.detail || '').replace(new RegExp(`^${String(it.model || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*·\\s*`), '')
      }
    })
    .filter((it) => it.type !== 'text')
  return {
    items,
    total: Math.round(items.reduce((a, x) => a + (x.credits || 0), 0) * 100) / 100,
    unknownCount: items.filter((x) => !x.known).length,
    nodeCount: nodes.length
  }
}

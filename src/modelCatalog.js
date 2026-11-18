/* 模型分类器：把 /v1/models 拉回来的 id 自动分到 图片 / 视频 / Agent(LLM)
   规则按「越具体越先判」排序，分类结果在设置里可手动点击改 */

const has = (s, words) => words.some((w) => s.includes(w))

// 视频：模型名里带这些片段一律算视频
const VIDEO_HINTS = [
  'veo', 'sora', 'kling', 'seedance', 'hailuo', 'minimax-h3', 'minimax-hailuo',
  'vidu', 'runway', 'pika', 'luma', 'ray-2', 'cogvideo', 'wan2', 'wan-2', 'wanx',
  't2v', 'i2v', 'text-to-video', 'image-to-video', '-video', 'video-', 'hunyuan-video',
  'ltx', 'mochi', 'seedvideo', 'dream-machine', 'morph-video', 'grok-video'
]

// 图片
const IMAGE_HINTS = [
  'image', 'flux', 'midjourney', 'mj-', '-mj', 'niji', 'seedream', 'seededit',
  'sdxl', 'sd3', 'sd-3', 'sd-1', 'stable-diffusion', 'dall-e', 'dalle', 'imagen',
  'kolors', 'recraft', 'ideogram', 'banana', 'janus', 'hidream', 'playground-v',
  'gpt-4o-image', 'grok-2-image', 'qwen-image', 'doubao-image', 'imagenet', 'picgen',
  'text-to-image', 't2i'
]

// Agent / 通用大模型
const CHAT_HINTS = [
  'gpt', 'chatgpt', 'claude', 'gemini', 'deepseek', 'qwen', 'llama', 'mistral',
  'mixtral', 'grok', 'glm', 'chatglm', 'kimi', 'moonshot', 'doubao', 'minimax',
  'command', 'yi-', 'ernie', 'spark', 'hunyuan', 'step-', 'o1', 'o3', 'o4',
  'sonnet', 'opus', 'haiku', 'reasoner', 'instruct', 'terra', 'fable', 'nova',
  'phi-', 'gemma', 'wizard', 'vicuna', 'baichuan', 'internlm'
]

export function classifyModel(id) {
  const s = String(id || '').toLowerCase()
  if (!s) return 'chat'
  // 明确的视频/图片优先（避免 gpt-image 被 gpt 命中成 chat）
  if (has(s, VIDEO_HINTS)) return 'video'
  if (has(s, IMAGE_HINTS)) return 'image'
  if (has(s, CHAT_HINTS)) return 'chat'
  // 兜底：带 size/resolution 之类命名的生图模型很常见，其余按 Agent 处理
  return 'chat'
}

/* 合并已存目录与最新拉取结果：保留用户手动改过的分类 */
export function mergeCatalog(prev, ids) {
  const byId = new Map((prev || []).map((m) => [m.id, m]))
  return ids.map((id) => {
    const old = byId.get(id)
    return { id, cat: old?.cat || classifyModel(id) }
  })
}

export const CAT_META = {
  image: { name: '图片', full: '图片模型' },
  video: { name: '视频', full: '视频模型' },
  chat: { name: 'Isle', full: 'Isle 模型（LLM）' }
}

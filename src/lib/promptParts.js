/* D-5：运行时提示词拼装。
   C-2 起「上游提示词节点」的文本会被同步进下游 d.prompt（便于卡片/面板可见可改），
   而引擎本身也会沿连线收集上游文本。两者叠加会把同一段文字发送两遍，
   浪费 token 且可能让模型重复理解需求。这里按归一化内容去重：保序、保留首处写法。 */
export function mergePromptParts(parts) {
  const seen = new Set()
  const out = []
  for (const p of parts || []) {
    if (typeof p !== 'string') continue
    const s = p.trim()
    if (!s) continue
    const key = s.replace(/\s+/g, ' ')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out.join('\n')
}

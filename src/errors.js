/* 失败文案解释（UI-006）：把后端/网关的原始报错翻译成
   「发生了什么 + 可能原因 + 下一步」，并保留原文供展开查看。 */

const RULES = [
  {
    /* 1.2.0：必须排在「超时」之前——这条文案里也含“超时”，但处理方式完全不同：
       超时可以重试，提交结果未知不能直接重试（服务端可能已扣费） */
    keys: ['提交结果未知'],
    head: '提交结果未知（可能已扣费）',
    cause: '请求已经发出，但响应在连接超时或中断前没有回来。4K 图片与高分辨率视频的同步提交常要 40–60 秒，服务端很可能已经生成并扣费。',
    next: '先不要点「重试」。等 1–2 分钟后用「查询已有任务」找回；仍取不回就到服务商网页核对任务记录，确认没有生成再重新提交。'
  },
  {
    keys: ['响应流被中断'],
    head: '响应中断',
    cause: '服务端在返回结果前关闭了连接，产物可能已生成',
    next: '先用「查询已有任务」核对，避免重复扣费'
  },
  {
    keys: ['prompt parameter is required', 'prompt is required', 'missing prompt', '`prompt`'],
    head: '提示词为空',
    cause: '该节点的提示词是空的，而接口要求必填',
    next: '在节点卡片上填写提示词后重试'
  },
  {
    keys: ['size must be', 'invalid size', 'unsupported size', 'resolution must', 'invalid resolution'],
    head: '参数不被该模型支持',
    cause: '当前的画面比例 / 分辨率超出该模型允许的范围',
    next: '在参数面板调整画面比例或分辨率后重试'
  },
  {
    keys: ['timeout', 'timed out', '超时', 'etimedout', 'aborted', 'deadline'],
    head: '生成超时',
    cause: '模型响应时间超过上限，任务没有在预期时间内返回',
    next: '可直接重试；若反复超时，换用响应更快的模型或降低分辨率'
  },
  {
    keys: ['401', 'unauthorized', 'invalid api key', 'invalid_api_key', 'incorrect api key', '鉴权', 'apikey'],
    head: '鉴权失败',
    cause: 'API Key 无效、已过期，或与该模型的接口地址不匹配',
    next: '到「设置」检查该模型的 Key 与 baseUrl，保存后重试'
  },
  {
    keys: ['402', 'insufficient', 'quota', 'balance', '余额', '额度', '积分不足', 'not enough'],
    head: '额度不足',
    cause: '账户余额或积分不足，无法提交新任务',
    next: '充值后重试，或换用成本更低的模型/更小的分辨率'
  },
  {
    keys: ['429', 'rate limit', 'too many requests', '频繁', '并发'],
    head: '请求被限流',
    cause: '短时间内提交的任务过多，触发上游限流',
    next: '等待 1 分钟后重试，或减少批量节点数量'
  },
  {
    keys: ['404', 'model not found', 'no such model', 'does not exist', '模型不存在', 'unsupported model'],
    head: '模型不可用',
    cause: '所选模型不存在，或当前接口不支持该模型',
    next: '在设置里重新同步模型列表，然后为节点重新选择模型'
  },
  {
    keys: ['content', 'policy', 'safety', 'moderation', '审核', '违规', 'nsfw', 'blocked'],
    head: '内容被拦截',
    cause: '提示词或参考图触发了内容安全策略',
    next: '调整提示词措辞，或替换参考图后重试'
  },
  {
    keys: ['image', '参考图', 'reference', 'url'],
    head: '参考图无效',
    cause: '上游图片链接失效、格式不支持，或数量超过上限',
    next: '重新生成上游图片，或在参数面板移除该参考图后重试'
  },
  {
    keys: ['network', 'fetch failed', 'econnrefused', 'enotfound', 'socket', '连接', '网络', 'proxy'],
    head: '网络连接失败',
    cause: '无法连接到接口地址，可能是断网、代理异常或服务端不可达',
    next: '检查网络/代理后重试'
  },
  {
    keys: ['未选择模型'],
    head: '未选择模型',
    cause: '该节点还没有绑定生成模型',
    next: '在节点卡片上选择模型后重试'
  }
]

const FALLBACK = {
  head: '生成失败',
  cause: '上游返回了错误，通常是提示词、参数或服务端临时故障',
  next: '可先重试一次；若仍失败，展开详情查看原始报错'
}

/** 返回 { head, cause, next, raw } */
export function explainError(raw) {
  const msg = String(raw == null ? '' : raw).trim()
  const low = msg.toLowerCase()
  const hit = msg
    ? RULES.find((r) => r.keys.some((k) => low.includes(String(k).toLowerCase())))
    : null
  const base = hit || FALLBACK
  return { ...base, raw: msg || '未返回错误信息' }
}

/** 单行摘要（摘要行/状态徽标用），不硬截断语义，只压缩换行 */
export function oneLine(raw, n = 80) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

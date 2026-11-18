/* P2 配音：TTS 能力常量与实测结论（2026-11-02 带 Key 实测）
   - 网关 /v1/audio/speech 走 OpenAI 兼容协议，返回二进制音频（非 JSON）
   - 实测可用：gpt-4o-mini-tts（audio/mpeg）
   - 实测不可用：tts-1 / tts-1-hd（DeploymentNotFound）、gpt-audio-mini（不支持 audioSpeech 操作）
   设置里若同步出更多 audio 模型，面板仍会全部列出，只是提交失败时按原样报网关错误。 */
export const DEFAULT_AUDIO_MODEL = 'gpt-4o-mini-tts'
export const AUDIO_MODELS = [DEFAULT_AUDIO_MODEL]

/* OpenAI 兼容音色：中文内容建议 alloy / nova / shimmer；onyx、echo 偏低沉 */
export const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'sage']
export const VOICE_LABEL = {
  alloy: 'alloy · 中性', echo: 'echo · 男声', fable: 'fable · 叙述', onyx: 'onyx · 低沉',
  nova: 'nova · 女声', shimmer: 'shimmer · 柔和', coral: 'coral · 明亮', sage: 'sage · 沉稳'
}
export const AUDIO_FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac']

/* 语速范围（OpenAI 兼容：0.25–4.0，1.0 为原速） */
export const SPEED_MIN = 0.5
export const SPEED_MAX = 2

export const isAudioKind = (kind) => kind === 'audio'

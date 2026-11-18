/* 跨模块常量：生成偏好兜底值（与主进程 DEFAULT_GENERATION 同源语义） */
export const GEN_FALLBACK = {
  image: { resolution: '2K', size: '1:1', n: 1 },
  video: { resolution: '720p', size: '16:9', duration: 5 },
  regenerate: 'new'
}

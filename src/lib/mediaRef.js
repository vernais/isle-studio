/* P1：素材引用的分类与判定。
   网关的参考视频必须是公网直链（mp4/mov），本地素材卡（data: / file://）无法直接使用；
   参考图则可以经 /v1/uploads/images 上传换 URL。这里集中判定，避免各处重复正则。 */

/** 是否为视频引用（扩展名或 data:video） */
export function isVideoUrl(u) {
  const s = String(u || '')
  return /^data:video\//i.test(s) || /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(s)
}

/** 是否已是公网可访问地址 */
export function isPublicUrl(u) {
  return /^https?:\/\//i.test(String(u || ''))
}

/** 是否本地引用（需要先上传才能给网关用） */
export function isLocalRef(u) {
  const s = String(u || '')
  return !s || /^data:/i.test(s) || /^file:\/\//i.test(s) || s.startsWith('assets:')
}

/** 动作控制类模型：以参考视频驱动动作，参考图定人物 */
export const isMotionModel = (model) => /motion-control/i.test(String(model || ''))

/** 视频编辑类模型：直接重绘参考视频 */
export const isVideoEditModel = (model) => /videoedit|video-edit/i.test(String(model || ''))

/** 需要参考视频入参的模型 */
export const needsRefVideo = (model) => isMotionModel(model) || isVideoEditModel(model)

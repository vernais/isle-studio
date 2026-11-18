import React, { useEffect, useState } from 'react'

/* ---------- REF-002 缩略图体系（渲染端） ----------
   命名规则与主进程一致：assets/<项目>/<资产名>.<ext> → assets/<项目>/thumbs/<资产名>.webp
   缩略图不写进项目 JSON（纯本地缓存）：画布/参考栏/列表读缩略图，
   放大预览、下载、发给模型的参考图仍用原图。缺失时由原图懒重建。 */

const THUMB_MAX = 512
const QUALITY = 0.82

/** 由原图地址推导缩略图地址；非本地资产（外链/dataURL）返回 null，不折腾 */
export function thumbUrlOf(src) {
  if (typeof src !== 'string' || !src.startsWith('file:///')) return null
  if (/\/thumbs\//.test(src)) return null
  const m = /^(.*\/assets\/[^/]+)\/([^/]+)$/.exec(src)
  if (!m) return null
  const base = m[2].replace(/\.[^./]+$/, '')
  return `${m[1]}/thumbs/${base}.webp`
}

const inflight = new Map() // src → Promise，避免同一张图被多个卡片同时重建

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** 原图 → WebP 缩略图（长边 ≤512）写盘，返回缩略图地址 */
export function ensureThumb(src) {
  const tu = thumbUrlOf(src)
  if (!tu) return Promise.resolve(null)
  if (inflight.has(src)) return inflight.get(src)
  const p = (async () => {
    try {
      const img = await loadImage(src)
      const nw = img?.naturalWidth || 0
      const nh = img?.naturalHeight || 0
      if (!nw || !nh) return null
      const scale = Math.min(1, THUMB_MAX / Math.max(nw, nh))
      const w = Math.max(1, Math.round(nw * scale))
      const h = Math.max(1, Math.round(nh * scale))
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, w, h)
      const dataUrl = c.toDataURL('image/webp', QUALITY)
      if (!dataUrl.startsWith('data:image/webp')) return null
      const r = await window.flow.thumbPut({ src, dataUrl })
      return r?.ok ? r.url : null
    } catch {
      return null
    } finally {
      inflight.delete(src)
    }
  })()
  inflight.set(src, p)
  return p
}

/**
 * 图片组件：优先缩略图，缩略图缺失自动回退原图并触发懒重建。
 * 只在本地资产上启用缩略图；外链/dataURL 原样加载。
 */
export default function ThumbImg({
  src, alt = '', className, style, title, draggable = false,
  onClick, onDoubleClick, loading = 'lazy'
}) {
  const tu = thumbUrlOf(src)
  const [useThumb, setUseThumb] = useState(!!tu)
  const [bust, setBust] = useState(0) // 重建后的缓存击穿
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setUseThumb(!!tu)
    setFailed(false)
    setBust(0)
  }, [src, tu])

  if (!src) return null
  return (
    <img
      src={(useThumb && tu ? tu : src) + (useThumb && tu && bust ? `?v=${bust}` : '')}
      alt={alt}
      className={className}
      style={failed ? { ...style, opacity: 0 } : style}
      title={title}
      draggable={draggable}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      loading={loading}
      data-thumb={useThumb && tu ? '1' : '0'}
      onError={() => {
        if (useThumb && tu) {
          // 缩略图文件丢了：先用原图顶上，后台重建好再切回来（REF-002 懒生成）
          setUseThumb(false)
          ensureThumb(src).then((url) => {
            if (url) {
              setBust(Date.now())
              setUseThumb(true)
            }
          })
        } else {
          setFailed(true)
        }
      }}
    />
  )
}

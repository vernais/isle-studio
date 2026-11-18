import React, { useEffect, useRef, useState } from 'react'
import { IcClose, IcDownload, IcFit } from './icons.jsx'

/* REQ-007 图片对比查看器（画布内浮层，非新窗口）
   三模式：并排网格（滚轮同步缩放）/ 双图滑动分割 / 单张逐个切换（←/→）。
   仅图片产物参与；动作（放大预览/下载）与节点右键菜单同一来源（nodeActionMap 透传）。

   S14 交互整改（见《交互整改书 v1》）：
   - IR-010：分割模式改「同尺寸 layer + clip-path」，裁剪基准与 .cmp-divider 的 left 同源（任意 zoom 下误差 ≤2px）
   - IR-011：分割线 pointer capture，拖出容器继续跟手
   - IR-012：zoom 百分比可点复位；zoom>1 可拖拽平移（按 contain 实际显示尺寸夹紧）；头部「适应窗口」
   - IR-013：mode/zoom/splitPos 由 App 层持久（view/onView 受控），同组 items 重开恢复
   - IR-014：方向键仅逐张模式生效 */

const MODES = [
  { key: 'split', label: '滑动分割' },
  { key: 'grid', label: '并排' },
  { key: 'single', label: '逐张' }
]

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/* 可平移视图层（IR-012）
   - zoom>1 时按住拖动平移
   - 拖拽期间 pointermove/pointerup 挂到 window（不依赖 pointer capture 的时序），
     指针快速离开元素或拖出容器都不会失联
   - 平移量按图片 contain 后的真实显示尺寸夹紧，不露空白过界 */
function PanLayer({ className, style, zoom, pan, onPan, children }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const [panning, setPanning] = useState(false)

  const bounds = () => {
    const el = ref.current
    if (!el) return { maxX: 0, maxY: 0 }
    const img = el.querySelector('img')
    const cw = el.clientWidth
    const ch = el.clientHeight
    const nw = img?.naturalWidth || 0
    const nh = img?.naturalHeight || 0
    if (!nw || !nh || !cw || !ch) return { maxX: 0, maxY: 0 }
    const fit = Math.min(cw / nw, ch / nh) // object-fit: contain 的显示比例
    return {
      maxX: Math.max(0, (nw * fit * zoom - cw) / 2),
      maxY: Math.max(0, (nh * fit * zoom - ch) / 2)
    }
  }

  const onPointerDown = (e) => {
    if (zoom <= 1 || e.target.closest('.cmp-divider')) return
    const el = ref.current
    try { el.setPointerCapture(e.pointerId) } catch {}
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
    setPanning(true)
  }

  useEffect(() => {
    if (!panning) return
    const onMove = (e) => {
      const d = drag.current
      if (!d) return
      const { maxX, maxY } = bounds()
      onPan({
        x: clamp(d.px + (e.clientX - d.x), -maxX, maxX),
        y: clamp(d.py + (e.clientY - d.y), -maxY, maxY)
      })
    }
    const onUp = () => { drag.current = null; setPanning(false) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [panning, zoom])

  /* 缩放变化后把已有平移量重新夹紧（避免缩小时留住越界偏移） */
  useEffect(() => {
    if (!pan.x && !pan.y) return
    const { maxX, maxY } = bounds()
    const nx = clamp(pan.x, -maxX, maxX)
    const ny = clamp(pan.y, -maxY, maxY)
    if (nx !== pan.x || ny !== pan.y) onPan({ x: nx, y: ny })
  }, [zoom, pan.x, pan.y])

  return (
    <div ref={ref} className={className + (panning ? ' panning' : '')}
      style={{ ...style, cursor: panning ? 'grabbing' : zoom > 1 ? 'grab' : undefined }}
      onPointerDown={onPointerDown}>
      {children}
    </div>
  )
}

export default function CompareView({ items, view, onView, onClose, onPreview, onDownload }) {
  /* IR-013：视角状态由 App 层持有，关闭重开同一组 items 时恢复 */
  const mode = view.mode
  const zoom = view.zoom
  const splitPos = view.splitPos
  const patch = (p) => onView((v) => (v ? { ...v, ...p } : v))
  const setMode = (m) => patch({ mode: m })
  const setZoom = (z) => patch({ zoom: z })
  const setSplitPos = (p) => patch({ splitPos: p })

  const [idx, setIdx] = useState(0)
  const [panMap, setPanMap] = useState({}) // 各视图平移量，按「模式:节点 id」隔离，互不串扰
  const splitRef = useRef(null)

  const rootRef = useRef(null)
  const panOf = (key) => panMap[key] || { x: 0, y: 0 }
  const setPan = (key, p) => setPanMap((m) => ({ ...m, [key]: p }))
  const resetView = () => { patch({ zoom: 1 }); setPanMap({}) }

  /* 滚轮同步缩放：native listener 才能 preventDefault（React 合成事件是 passive） */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      setZoom(clamp(Math.round(zoom * (e.deltaY < 0 ? 1.15 : 0.87) * 100) / 100, 0.2, 5))
      if (zoom <= 1) setPanMap({})
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [mode, zoom])

  /* 键盘（IR-014）：仅逐张模式响应 ←/→；Esc 由 App 层 Esc 链统一处理，组件内不重复绑定 */
  useEffect(() => {
    if (mode !== 'single') return
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') setIdx((i) => clamp(i - 1, 0, items.length - 1))
      else if (e.key === 'ArrowRight') setIdx((i) => clamp(i + 1, 0, items.length - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, items.length])

  /* 分割线拖拽（IR-011）：拖拽期间 pointermove/pointerup 挂 window——
     指针移出 2px 宽的分割线、甚至拖出容器都不失联；位置夹紧 [0,100] */
  const [splitDragging, setSplitDragging] = useState(false)
  const onSplitDown = (e) => {
    e.stopPropagation()
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    setSplitDragging(true)
  }
  useEffect(() => {
    if (!splitDragging) return
    const onMove = (e) => {
      const r = splitRef.current?.getBoundingClientRect()
      if (!r) return
      setSplitPos(clamp(Math.round(((e.clientX - r.left) / r.width) * 100), 0, 100))
    }
    const onUp = () => setSplitDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [splitDragging])

  const imgStyle = (zoom, pan) => ({ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` })

  const Actions = ({ it }) => (
    <span className="cmp-acts">
      <button title="放大预览" onClick={() => onPreview(it.url)}><IcFit size={12} /></button>
      <button title="下载" onClick={() => onDownload(it.url, 'image')}><IcDownload size={12} /></button>
    </span>
  )
  const Caption = ({ it }) => (
    <div className="cmp-cap">
      <b>{it.label}</b>
      <span>{it.params || '—'}</span>
      <Actions it={it} />
    </div>
  )

  return (
    <div className="cmp-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="cmp-view" ref={rootRef}>
        <div className="cmp-head">
          <span className="cmp-title">对比 · {items.length} 张</span>
          <div className="cmp-modes" role="tablist">
            {MODES.filter((m) => m.key !== 'split' || items.length === 2).map((m) => (
              <button key={m.key} role="tab" aria-selected={mode === m.key}
                className={mode === m.key ? 'on' : ''}
                onClick={() => setMode(m.key)}>{m.label}</button>
            ))}
          </div>
          <button className="cmp-zoom" title="点击复位 100%" onClick={resetView}>{Math.round(zoom * 100)}%</button>
          <button className="icon-btn" title="适应窗口" aria-label="适应窗口" onClick={resetView}><IcFit size={14} /></button>
          <button className="icon-btn" title="关闭对比 (Esc)" aria-label="关闭对比" onClick={onClose}><IcClose size={15} /></button>
        </div>

        <div className="cmp-body">
          {mode === 'grid' && (
            <div className="cmp-grid" style={{ '--cmp-n': items.length }}>
              {items.map((it) => (
                <figure key={it.id} className="cmp-cell">
                  <PanLayer className="cmp-img-wrap" zoom={zoom} pan={panOf('grid:' + it.id)}
                    onPan={(p) => setPan('grid:' + it.id, p)}>
                    <img src={it.url} alt={it.label} draggable={false}
                      style={imgStyle(zoom, panOf('grid:' + it.id))} />
                  </PanLayer>
                  <Caption it={it} />
                </figure>
              ))}
            </div>
          )}

          {mode === 'split' && items.length === 2 && (
            <div className="cmp-split-wrap">
              <div ref={splitRef} className="cmp-split">
                {/* IR-010：两张图各占一层与容器同尺寸的 layer，裁剪百分比与 .cmp-divider 的 left 同源 */}
                <PanLayer className="cmp-layer" zoom={zoom} pan={panOf('split:' + items[0].id)}
                  onPan={(p) => setPan('split:' + items[0].id, p)}>
                  <img src={items[0].url} alt={items[0].label} draggable={false}
                    style={imgStyle(zoom, panOf('split:' + items[0].id))} />
                </PanLayer>
                <PanLayer className="cmp-layer cmp-clip" style={{ clipPath: `inset(0 0 0 ${splitPos}%)` }}
                  zoom={zoom} pan={panOf('split:' + items[1].id)}
                  onPan={(p) => setPan('split:' + items[1].id, p)}>
                  <img src={items[1].url} alt={items[1].label} draggable={false}
                    style={imgStyle(zoom, panOf('split:' + items[1].id))} />
                </PanLayer>
                <div className={'cmp-divider' + (splitDragging ? ' dragging' : '')} style={{ left: splitPos + '%' }}
                  onPointerDown={onSplitDown}>
                  <i />
                </div>
              </div>
              <div className="cmp-split-caps">
                <Caption it={items[0]} />
                <Caption it={items[1]} />
              </div>
            </div>
          )}

          {mode === 'single' && (
            <div className="cmp-single">
              <figure className="cmp-cell">
                <PanLayer className="cmp-img-wrap" zoom={zoom} pan={panOf('single:' + items[idx].id)}
                  onPan={(p) => setPan('single:' + items[idx].id, p)}>
                  <img src={items[idx].url} alt={items[idx].label} draggable={false}
                    style={imgStyle(zoom, panOf('single:' + items[idx].id))} />
                </PanLayer>
                <Caption it={items[idx]} />
              </figure>
              <div className="cmp-single-nav">
                <button disabled={idx === 0} onClick={() => setIdx(idx - 1)} aria-label="上一张">←</button>
                <span>{idx + 1} / {items.length}</span>
                <button disabled={idx === items.length - 1} onClick={() => setIdx(idx + 1)} aria-label="下一张">→</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

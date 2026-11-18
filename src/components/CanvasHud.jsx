import React from 'react'
import { MiniMap, useReactFlow, useStore } from '@xyflow/react'
import { IcMinus, IcPlus, IcFit, IcMap } from '../icons.jsx'

export default function CanvasHud({ minimapOpen, onToggleMinimap }) {
  const rf = useReactFlow()
  const zoom = useStore((s) => Math.round(s.transform[2] * 100))
  return (
    <>
      {minimapOpen && (
        <MiniMap
          className="hf-minimap"
          pannable
          zoomable
          nodeColor="#c5ccda"
          nodeStrokeColor="transparent"
          maskColor="rgba(245,246,249,.78)"
          bgColor="#ffffff"
          style={{ width: 210, height: 140 }}
        />
      )}
      <div className="canvas-hud">
        <button title="缩小" onClick={() => rf.zoomOut({ duration: 150 })}><IcMinus size={14} /></button>
        <button className="hud-zoom" title="重置为 100%" onClick={() => rf.zoomTo(1, { duration: 200 })}>{zoom}%</button>
        <button title="放大" onClick={() => rf.zoomIn({ duration: 150 })}><IcPlus size={14} /></button>
        <span className="hud-sep" />
        <button title="最大化现有内容" onClick={() => rf.fitView({ duration: 300, padding: 0.18, maxZoom: 1 })}><IcFit size={14} /></button>
        <button
          title={minimapOpen ? '隐藏小地图' : '显示小地图'}
          className={minimapOpen ? 'active' : ''}
          onClick={onToggleMinimap}
        ><IcMap size={14} /></button>
      </div>
    </>
  )
}

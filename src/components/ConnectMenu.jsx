import React from 'react'
import { IcMenu } from '../icons.jsx'
import { itemsForHandle } from '../lib/flowGraph.js'

export default function ConnectMenu({ info, onPick, onClose }) {  const items = itemsForHandle(info.handleType, info.handleId)
  const W = 190, H = 44 * items.length + 16
  const left = Math.max(8, Math.min(info.x, window.innerWidth - W - 8))
  const top = Math.max(8, Math.min(info.y, window.innerHeight - H - 8))
  return (
    <>
      <div className="menu-mask" onClick={onClose} />
      <div className="add-menu connect-menu" style={{ left, top }}>
        {items.map((it) => (
          <button key={it.key} className="add-item" onClick={() => onPick(it.key)}>
            <span className="add-ico">{React.createElement(IcMenu[it.key], { size: 17 })}</span>
            {it.label}
          </button>
        ))}
      </div>
    </>
  )
}

import React from 'react'

export default function NodeContextMenu({ menu, items, onPick, onHover, onClose }) {
  const W = 208
  const H = items.reduce((h, it) => h + (it.sep ? 9 : 32), 12)
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - W - 8))
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - H - 8))
  return (
    <>
      <div
        className="menu-mask"
        onMouseDown={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div className="node-menu" style={{ left, top }} role="menu" aria-label="节点操作">
        {items.map((it, i) => (it.sep
          ? <div key={'sep' + i} className="nm-sep" />
          : (
            <button
              key={it.key} role="menuitem" type="button"
              className={(it.danger ? 'danger' : '') + (menu.idx === i ? ' on' : '')}
              disabled={it.disabled}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(it)}
            >
              <span className="nm-ico">{React.createElement(it.icon, { size: 13 })}</span>
              {it.label}
              {it.hint ? <span className="nm-key">{it.hint}</span> : null}
            </button>
          )))}
      </div>
    </>
  )
}

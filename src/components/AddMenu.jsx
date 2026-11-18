import React, { useState } from 'react'
import { IcMenu, IcSearch } from '../icons.jsx'

export default function AddMenu({ onClose, onAdd, onUpload, pos }) {
  const [q, setQ] = useState('')
  const items = [
    { key: 'text', label: '提示词', show: '提示词'.includes(q) || 'prompt text'.includes(q.toLowerCase()) },
    { key: 'image', label: '图片生成器', show: '图片生成器'.includes(q) || 'image'.includes(q.toLowerCase()) },
    { key: 'video', label: '视频生成器', show: '视频生成器'.includes(q) || 'video'.includes(q.toLowerCase()) },
    { key: 'audio', label: '配音', show: '配音'.includes(q) || 'audio tts voice'.includes(q.toLowerCase()) },
    { key: 'compose', label: '成片合成', show: '成片合成'.includes(q) || 'compose merge 合成 剪辑'.includes(q.toLowerCase()) },
    { key: 'upload', label: '上传', show: '上传'.includes(q) || 'upload'.includes(q.toLowerCase()) }
  ].filter((i) => i.show)
  const W = 250, H = 300
  const style = pos
    ? {
        left: Math.max(8, Math.min(pos.x, window.innerWidth - W - 8)),
        top: Math.max(8, Math.min(pos.y, window.innerHeight - H - 8)),
        bottom: 'auto', transform: 'none'
      }
    : undefined
  return (
    <>
      <div className="menu-mask" onClick={onClose} />
      <div className="add-menu" style={style}>
        <div className="add-search">
          <IcSearch size={13} style={{ color: '#8a8a92', flex: 'none' }} />
          <input autoFocus placeholder="搜索" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {items.map((it) => (
          <button key={it.key} className="add-item" onClick={() => onAdd(it.key, pos)}>
            <span className="add-ico">{React.createElement(IcMenu[it.key], { size: 17 })}</span>
            {it.label}
          </button>
        ))}
        {!items.length && <div className="add-empty">无匹配项</div>}
      </div>
    </>
  )
}

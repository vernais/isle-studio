import React, { useEffect, useRef, useState } from 'react'

/* Q1-1（REQ-004）参考角色选择器：点击弹小下拉（未指定 + 角色），
   替代旧的点击循环（5 态循环可点击性差）。参考栏与节点工具条共用。
   1.2.0：新增「分镜」「三视图」——Kling-v4 多图参考里分别约束构图/动作与同一人物三视图。 */
export const ROLE_OPTIONS = ['主角', '场景', '分镜', '三视图', '产品', '风格参考']

export default function RolePicker({ role, onPick, compact = false }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    window.addEventListener('pointerdown', close, true)
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <span className={'rp-wrap' + (compact ? ' compact' : '')} ref={ref}>
      <button
        type="button"
        className={'ref-role' + (role ? ' on' : '')}
        title="参考角色标签：主角 / 场景 / 分镜 / 三视图 / 产品 / 风格参考"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
      >{role || '角色'}</button>
      {open && (
        <span className="rp-menu" onPointerDown={(e) => e.stopPropagation()}>
          {['', ...ROLE_OPTIONS].map((r) => (
            <button key={r || 'none'} type="button"
              className={'rp-item' + (r === (role || '') ? ' on' : '')}
              onClick={(e) => { e.stopPropagation(); setOpen(false); onPick(r) }}>
              {r || '未指定'}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

import React from 'react'
import { IcKeyboard, IcClose } from '../icons.jsx'
import { SHORTCUT_GROUPS } from '../lib/shortcuts.js'

export default function ShortcutsModal({ onClose }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal kbd-modal" onClick={(e) => e.stopPropagation()}>
        <div className="kbd-head">
          <span className="panel-title"><IcKeyboard size={16} /> 键盘快捷键</span>
          <button className="icon-btn" title="关闭（Esc）" aria-label="关闭快捷键说明" onClick={onClose}><IcClose size={15} /></button>
        </div>
        <div className="kbd-grid">
          {SHORTCUT_GROUPS.map((grp) => (
            <div key={grp.g} className="kbd-group">
              <div className="kbd-gname">{grp.g}</div>
              {grp.items.map(([k, d]) => (
                <div key={k} className="kbd-row">
                  <span className="kbd-keys">{k.split(' + ').map((s, i) => (
                    <React.Fragment key={s}>
                      {i > 0 && <em>+</em>}<kbd>{s}</kbd>
                    </React.Fragment>
                  ))}</span>
                  <span className="kbd-desc">{d}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="kbd-foot">输入框获得焦点时，删除 / 方向键 / Ctrl+A 交还给文本编辑，不会误删节点。</div>
      </div>
    </div>
  )
}

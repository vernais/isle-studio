import React, { useRef, useState } from 'react'
import { IcFolder, IcSave, IcOrganize, IcDownload, IcPlus, IcCopy } from '../icons.jsx'
import ProjectAssetsPanel from './ProjectAssetsPanel.jsx'

/* S18：「我的项目」升级为「项目资产」——上区项目列表（原逻辑不动），下区资产网格。
   资产相关回调由 App 注入（onInsert/onDelete 走主进程 IPC，本组件不碰文件）。
   D-4：顶栏项目名点击即内联改名（onRename 由 App 注入），不必回首页。 */
export default function ProjectBar({ name, dirty, open, projects, onToggle, onLoad, onNew, onSave, onOrganize, onDownloadAll, onTemplates, onRename, assets }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  /* 全局 Esc 热键（useHotkeys）会对浮层外输入框做 activeElement.blur()，晚于本组件 onKeyDown
     触发 onBlur → commit，会误提交。cancelRef 让 Esc 之后的失焦提交失效。 */
  const cancelRef = useRef(false)
  const startEdit = () => { cancelRef.current = false; setDraft(name || ''); setEditing(true) }
  const cancel = () => { cancelRef.current = true; setDraft(name || ''); setEditing(false) }
  const commit = () => {
    setEditing(false)
    if (cancelRef.current) return
    const v = draft.trim()
    if (v && v !== name && onRename) onRename(v)
  }
  return (
    <div className="projbar">
      <button className={'proj-btn' + (open ? ' on' : '')} onClick={onToggle}>
        <IcFolder size={14} /> 项目资产
      </button>
      <span className="proj-sep" />
      {editing ? (
        <input
          className="proj-name-input"
          value={draft}
          maxLength={80}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur()
            if (e.key === 'Escape') cancel()
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="proj-name editable" title="点击修改项目名" onClick={startEdit}>
          {name || '未命名项目'}{dirty && <i className="dirty-dot" />}
        </span>
      )}
      <span className="proj-sep" />
      <button className={'proj-btn save' + (dirty ? ' accent' : '')} onClick={onSave}>
        <IcSave size={14} /> 保存项目
      </button>
      <button className="proj-btn" onClick={onTemplates} title="模板库：保存/载入工作流模板（REQ-002）">
        <IcCopy size={14} /> 模板
      </button>
      <button className="proj-btn" onClick={onOrganize} title="按连线依赖自动分层排列">
        <IcOrganize size={14} /> 整理画布
      </button>
      <button className="proj-btn" onClick={onDownloadAll} title="把所有生成产物保存到输出目录">
        <IcDownload size={14} /> 下载全部
      </button>
      {open && (
        <>
          <div className="menu-mask" onClick={onToggle} />
          <div className="proj-menu wide">
            <button className="proj-new" onClick={onNew}><IcPlus size={13} /> 新建项目</button>
            {!projects.length && <div className="proj-empty">还没有保存过的项目</div>}
            <div className="proj-list">
              {projects.map((p) => (
                <button key={p.name} className="proj-item" onClick={() => onLoad(p.name)}>
                  <span className="proj-item-name">{p.name}</span>
                  <span className="proj-item-meta">
                    {new Date(p.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · {p.nodeCount} 节点
                  </span>
                </button>
              ))}
            </div>
            <ProjectAssetsPanel currentProject={name} onToast={assets?.onToast} onInsert={assets?.onInsert} onDelete={assets?.onDelete} />
          </div>
        </>
      )}
    </div>
  )
}

import React, { useCallback, useEffect, useState } from 'react'
import { IcClose, IcPlus, IcTrash, IcPencil, IcFolder, IcAlert, IcArrowRight } from '../icons.jsx'

/* REQ-002 模板库：画布与首页共用同一个浮层
   - 上半部「保存当前画布为模板」；下半部模板列表（载入 / 重命名 / 删除）
   - 模板文件损坏时行内标「文件损坏」并禁用载入，不影响其它模板与当前画布 */
export default function TemplateModal({ onClose, onSaveCurrent, onLoad, toast, askInput, askConfirm, canSave }) {
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => {
    window.flow.templateList().then(setList).catch(() => setList([]))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const save = async () => {
    if (!canSave) return toast('当前画布还没有节点，无法保存为模板')
    const name = await askInput({
      title: '保存为模板', label: '模板名称', defaultValue: '我的工作流',
      placeholder: '如：电商主图三步流', maxLength: 40, okText: '保存'
    })
    if (!name) return
    setBusy(true)
    const r = await onSaveCurrent(name)
    setBusy(false)
    if (r?.ok) { toast('已保存模板：' + r.name); refresh() }
    else toast('保存模板失败：' + (r?.error || '未知错误'))
  }

  const rename = async (t) => {
    const nn = await askInput({
      title: '重命名模板', label: '模板名称', defaultValue: t.name,
      maxLength: 40, okText: '保存'
    })
    if (!nn || nn === t.name) return
    const r = await window.flow.templateRename({ name: t.name, newName: nn })
    if (r.ok) { toast('已重命名为「' + r.name + '」'); refresh() }
    else toast('重命名失败：' + (r.error || '未知错误'))
  }

  const del = async (t) => {
    const ok = await askConfirm({
      title: `删除模板「${t.name}」？`,
      text: '模板文件将被移除，不可恢复；当前画布与项目不受影响。',
      okText: '删除模板', danger: true, icon: 'trash'
    })
    if (!ok) return
    const r = await window.flow.templateDelete({ name: t.name })
    if (r.ok) { toast('已删除模板：' + t.name); refresh() }
    else toast('删除失败：' + (r.error || '未知错误'))
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal tpl-modal" role="dialog" aria-label="模板库" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head tpl-head">
          <span className="panel-title"><IcFolder size={15} /> 模板库</span>
          <div className="tpl-head-actions">
            <button className="primary-btn small" onClick={save} disabled={busy}>
              <IcPlus size={13} /> 保存当前画布为模板
            </button>
            <button className="icon-btn" title="关闭（Esc）" aria-label="关闭模板库" onClick={onClose}><IcClose size={15} /></button>
          </div>
        </div>

        <div className="tpl-body">
          {list === null && <div className="tpl-empty">读取中…</div>}
          {list !== null && !list.length && (
            <div className="tpl-empty">
              <span className="tpl-empty-ico"><IcFolder size={22} /></span>
              <p>还没有模板</p>
              <span>把常用画布结构（节点 + 参数 + 连线）保存成模板，下次一键复用</span>
            </div>
          )}
          {list !== null && list.map((t) => (
            <div key={t.name} className={'tpl-row' + (t.broken ? ' broken' : '')}>
              <div className="tpl-main">
                <div className="tpl-name" title={t.name}>{t.name}</div>
                <div className="tpl-meta">
                  {t.broken
                    ? <><IcAlert size={11} /> 文件损坏，无法载入</>
                    : <>{new Date(t.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · {t.nodeCount} 个节点</>}
                </div>
              </div>
              <div className="tpl-acts">
                <button className="ghost-btn tpl-load" disabled={t.broken} title={t.broken ? '文件损坏' : '加载到当前画布'}
                  onClick={() => onLoad(t.name)}>
                  载入 <IcArrowRight size={12} />
                </button>
                <button className="icon-btn" title="重命名" aria-label={'重命名 ' + t.name} onClick={() => rename(t)}><IcPencil size={13} /></button>
                <button className="icon-btn danger" title="删除模板" aria-label={'删除 ' + t.name} onClick={() => del(t)}><IcTrash size={13} /></button>
              </div>
            </div>
          ))}
        </div>
        <div className="tpl-foot">模板只保存结构与参数，不含已生成结果与运行状态；载入后节点为「待生成」。</div>
      </div>
    </div>
  )
}

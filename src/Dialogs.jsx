import React, { useEffect, useRef, useState } from 'react'
import { IcAlert, IcTrash, IcPencil } from './icons.jsx'

/* ---------- 应用内对话框（UI-021）----------
   替代浏览器原生 prompt / confirm：
   · 输入型：空值禁用确认、超长计数提示、回车提交、Esc 取消、自动聚焦并全选
   · 确认型：显示影响范围，危险操作按钮变红
   · 两种都支持 Esc / 点击遮罩关闭，Tab 焦点陷阱（不溢出到背景）
   · 输入型点击遮罩需二次确认，避免误触丢失已输入文字 */

const ICONS = { alert: IcAlert, trash: IcTrash, pencil: IcPencil }

export default function DialogHost({ dialog, onDone }) {
  const boxRef = useRef(null)
  const inputRef = useRef(null)
  const okRef = useRef(null)
  const [value, setValue] = useState('')
  const [warn, setWarn] = useState('')
  const warnTimer = useRef(null)

  const isInput = dialog?.kind === 'input'
  const maxLength = dialog?.maxLength || 40
  const trimmed = value.trim()
  const tooLong = value.length > maxLength
  const canSubmit = !isInput || (trimmed.length > 0 && !tooLong)

  useEffect(() => {
    if (!dialog) return undefined
    setValue(dialog.defaultValue || '')
    setWarn('')
    const t = setTimeout(() => {
      if (isInput && inputRef.current) { inputRef.current.focus(); inputRef.current.select() }
      else okRef.current?.focus()
    }, 30)
    return () => clearTimeout(t)
  }, [dialog, isInput])

  useEffect(() => () => clearTimeout(warnTimer.current), [])

  if (!dialog) return null

  const submit = () => {
    if (!canSubmit) return
    onDone(isInput ? trimmed : true)
  }
  const cancel = () => onDone(isInput ? null : false)
  /* 可选第三动作（extraText）：阶段0修复④关闭确认用（保存并退出 / 不保存退出 / 取消）。
     返回 'extra' 字符串，与既有 true/false 互不影响 */
  const extra = dialog.extraText ? () => onDone('extra') : null

  /* 遮罩点击：输入型若已修改内容，需再点一次确认丢弃 */
  const onMask = () => {
    if (isInput && value.trim() !== (dialog.defaultValue || '').trim()) {
      if (!warn) {
        setWarn('再点一次遮罩将丢弃已输入的内容')
        clearTimeout(warnTimer.current)
        warnTimer.current = setTimeout(() => setWarn(''), 2600)
        return
      }
    }
    cancel()
  }

  /* Tab 焦点陷阱：只在弹窗内部循环 */
  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return
    const list = [...boxRef.current.querySelectorAll('button, input, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null)
    if (!list.length) return
    const first = list[0]
    const last = list[list.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  const Icon = ICONS[dialog.icon] || IcAlert

  return (
    <div className="modal-mask dlg-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onMask() }}>
      <div
        className="modal confirm dlg" ref={boxRef} role="dialog" aria-modal="true"
        aria-label={dialog.title} onKeyDown={onKeyDown}
      >
        <div className="confirm-head">
          <span className={'confirm-ico' + (dialog.danger ? ' danger' : '')}><Icon size={15} /></span>
          {dialog.title}
        </div>
        {dialog.text && <div className="confirm-text">{dialog.text}</div>}

        {isInput && (
          <form className="dlg-form" onSubmit={(e) => { e.preventDefault(); submit() }}>
            {dialog.label && <label className="dlg-label" htmlFor="dlg-input">{dialog.label}</label>}
            <input
              id="dlg-input" ref={inputRef} className="dlg-input" value={value}
              maxLength={maxLength + 8} placeholder={dialog.placeholder || ''}
              aria-invalid={!canSubmit}
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="dlg-meta">
              <span className="dlg-hint">
                {tooLong ? `最多 ${maxLength} 个字符（当前 ${value.length}）` : trimmed ? '' : '名称不能为空'}
              </span>
              <span className={'dlg-count' + (value.length > maxLength - 8 ? ' warn' : '')}>{value.length}/{maxLength}</span>
            </div>
            {warn && <div className="dlg-warn">{warn}</div>}
            {/* 隐藏提交按钮：保证回车提交走表单语义 */}
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </form>
        )}

        {!isInput && warn && <div className="dlg-warn">{warn}</div>}

        <div className="confirm-actions">
          <button className="ghost-btn" onClick={cancel}>{dialog.cancelText || '取消'}</button>
          {extra && <button className="ghost-btn" onClick={extra}>{dialog.extraText}</button>}
          <button
            ref={okRef}
            className={(dialog.danger ? 'ghost-btn danger' : 'primary-btn') + ' dlg-ok'}
            disabled={!canSubmit}
            onClick={submit}
          >{dialog.okText || '确定'}</button>
        </div>
      </div>
    </div>
  )
}

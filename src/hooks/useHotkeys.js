/* S17-0a：从 App.jsx 抽出的全局快捷键（纯搬移，行为逐行保持原样）
   监听挂在 window 捕获阶段：节点内 textarea 会 stopPropagation，但仍需响应 Ctrl+S / Esc。
   输入框内的「编辑类」按键一律让位（硬性约束 5：不得劫持输入）。 */
import { useEffect, useRef } from 'react'
import { closeNodeMenus, hasOpenNodeMenu } from '../nodes.jsx'

function handleKey(e, h) {
  const el = e.target
  const inField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT' || el.isContentEditable)
  const mod = e.ctrlKey || e.metaKey
  const k = e.key
  const low = typeof k === 'string' ? k.toLowerCase() : ''
  if (window.__keyDebug) window.__keyDebug.push({ k, mod, shift: e.shiftKey, inField })

  // Esc：逐层关闭当前浮层。焦点在普通编辑器里时只让文本框失焦（再按一次才关面板），
  // 但焦点在浮层内的输入框（搜索框等）时，Esc 应直接关闭该浮层。
  if (k === 'Escape') {
    // 应用内对话框优先级最高（输入框里按 Esc 也要能取消，而不是只失焦）
    if (h.dialogRef.current) {
      h.finishDialog(h.dialogRef.current.kind === 'input' ? null : false)
      e.preventDefault(); return
    }
    if (h.nodeMenu) { h.setNodeMenu(null); e.preventDefault(); return }
    if (inField) {
      const overlayField = document.activeElement?.closest?.('.add-menu, .connect-menu, .comp-menu, .mmenu, .run-menu, .modal, .kbd-modal, .proj-menu, .node-menu, .dlg, .proj-name-input')
      if (!overlayField) { document.activeElement.blur(); e.preventDefault(); return }
    }
    if (h.showSettings) { h.setShowSettings(false); e.preventDefault(); return }
    if (h.templatesOpen) { h.setTemplatesOpen(false); e.preventDefault(); return }
    // REF-004：参考选择模式优先退出（不顺手把参数面板也关了）
    if (h.refPickFor) { h.setRefPickFor(null); e.preventDefault(); return }
    if (h.compareOpen) { h.setCompareOpen(false); e.preventDefault(); return } // REQ-007：Esc 退出对比，选中态与视口不动
    if (h.previewUrl) { h.setPreviewUrl(null); e.preventDefault(); return }
    if (h.connectMenu) { h.setConnectMenu(null); e.preventDefault(); return }
    if (h.menuAt) { h.setMenuAt(null); e.preventDefault(); return }
    if (h.runMenu) { h.setRunMenu(false); e.preventDefault(); return } // S12 / IR-008：Esc 关运行二级菜单
    if (hasOpenNodeMenu()) { closeNodeMenus(); e.preventDefault(); return }
    if (h.helpOpen) { h.setHelpOpen(false); e.preventDefault(); return }
    if (h.agentOpen) { h.setAgentOpen(false); e.preventDefault(); return }
    if (h.selectedId) {
      // 同步清除 RF 节点选中标志，保证后续删除/复制以最新选中为准
      h.setNodes((ns) => ns.map((x) => ({ ...x, selected: false })))
      h.setSelectedId(null)
      e.preventDefault()
      return
    }
    return
  }

  if (h.view !== 'studio') return

  // 对话框打开时，画布快捷键全部让位（避免误删/误移动背景节点）
  if (h.dialogRef.current) return

  // 节点右键菜单打开时：方向键导航 + Enter 执行
  if (h.nodeMenu) {
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault(); h.moveNodeMenu(k === 'ArrowDown' ? 1 : -1); return
    }
    if (k === 'Enter') {
      e.preventDefault(); h.pickNodeMenuItem(h.nmItems[h.nodeMenu.idx]); return
    }
  }

  // 空格按住 = 临时平移
  if (e.code === 'Space' && !inField) { h.setSpacePan(true); e.preventDefault(); return }

  // 保存：输入框里也生效
  if (mod && low === 's' && !e.shiftKey) { e.preventDefault(); h.saveProject(); return }

  if (mod && k === 'Enter' && !inField) {
    e.preventDefault()
    if (e.shiftKey) h.runFromSelected(); else h.runAll()
    return
  }
  if (mod && k === '/') { e.preventDefault(); h.setAgentOpen((v) => !v); return }
  if (!inField && (k === '?' || k === '？' || (k === '/' && e.shiftKey))) {
    e.preventDefault(); h.setHelpOpen((v) => !v); return
  }

  if (inField) return // ↓ 编辑类快捷键：交给输入框

  if (mod && low === 'z') { e.preventDefault(); if (e.shiftKey) h.redo(); else h.undo(); return }
  if (mod && low === 'd') { e.preventDefault(); h.duplicateSelected(); return }
  if (mod && low === 'a') { e.preventDefault(); h.selectAllNodes(); return }
  if (mod && k === '0') { e.preventDefault(); h.rfw.fitView({ duration: 300, padding: 0.18, maxZoom: 1 }); return }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); h.removeSelected(); return }
  if (typeof k === 'string' && k.startsWith('Arrow')) {
    // 节点自身获得焦点时由 React Flow 内置键盘移动处理，避免移动两次
    if (document.activeElement?.closest?.('.react-flow__node')) return
    const step = e.shiftKey ? 10 : 1
    const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0
    const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0
    if (dx || dy) { e.preventDefault(); h.nudgeSelected(dx, dy) }
  }
}

export function useHotkeys(handlers) {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    const onKey = (e) => handleKey(e, ref.current)
    const onUp = (e) => { if (e.code === 'Space') ref.current.setSpacePan(false) }
    const onBlur = () => ref.current.setSpacePan(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}

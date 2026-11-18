import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@xyflow/react/dist/style.css'
import './styles.css'
import App from './App.jsx'

/* 兜底：任何渲染期异常都在页面上显示，不再静默白屏 */
class Guard extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) { window.__err = String(err && err.stack || err); console.error(err, info) }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div style={{ padding: 28, font: '13px/1.7 Consolas, monospace', color: '#ff8a8a', background: '#16161a', height: '100vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        <div style={{ color: '#fff', fontSize: 15, marginBottom: 10 }}>渲染出错了（已拦截，避免白屏）</div>
        {String(this.state.err && this.state.err.stack || this.state.err)}
      </div>
    )
  }
}
window.addEventListener('error', (e) => { window.__err = String(e.error && e.error.stack || e.message) })

/* 1.2.1 跨平台：macOS 用原生红绿灯（titleBarStyle: hiddenInset），
   顶栏需要让出左侧空间、并隐藏自绘的窗口按钮；Windows 保持不变 */
if (window.flow?.platform === 'darwin') document.body.classList.add('is-mac')

createRoot(document.getElementById('root')).render(<Guard><App /></Guard>)

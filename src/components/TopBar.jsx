import { IcSettings, IcMinus, IcMax, IcClose, IcBack } from '../icons.jsx'
import logoImg from '../assets/logo.png'

/* 顶栏（S17-0a 拆分）：从 App.jsx 原样搬出，DOM/类名零改动。
   只负责展示与窗口控制，业务回调全部由 App 传入。 */
export default function TopBar({ view, goHome, spent, verLabel, onOpenSettings }) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        {view === 'studio' && (
          <button className="icon-btn back" title="返回主页" onClick={goHome}><IcBack size={16} /></button>
        )}
        <div className="logo">
          {/* 品牌标志：黑圆底 + 竖条与双叶（用户提供版），位图 256px 缩放 */}
          <img src={logoImg} alt="Isle Studio" width={18} height={18} style={{ display: 'block', borderRadius: '50%' }} />
          <b>Isle</b> Studio {verLabel && <span className="ver">{verLabel}</span>}
        </div>
      </div>
      <div className="topbar-right">
        {/* 单主题（UI-031）：主题切换按钮已移除，应用恒为浅色 */}
        {spent > 0 && <span className="chip cost">本次已用 <b>{spent.toFixed(1)}</b> 积分</span>}
        {/* 设置入口在所有视图常驻（UI-009）：画布内 ≤1 次点击可达，关闭后画布状态不丢 */}
        <button className="icon-btn" title="设置" aria-label="设置" onClick={onOpenSettings}><IcSettings size={16} /></button>
        {/* 无边框窗口控制：原系统标题栏按钮移到这里 */}
        <div className="win-controls">
          <button title="最小化" onClick={() => window.flow.winMin()}><IcMinus size={13} /></button>
          <button title="最大化 / 还原" onClick={() => window.flow.winMax()}><IcMax size={12} /></button>
          <button className="close" title="关闭" onClick={() => window.flow.winClose()}><IcClose size={14} /></button>
        </div>
      </div>
    </div>
  )
}

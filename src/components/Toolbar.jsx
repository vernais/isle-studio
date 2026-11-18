import { createPortal } from 'react-dom'
import { IcSelect, IcHand, IcPlus, IcKeyboard, IcPlay, IcCaret } from '../icons.jsx'
import { estimateFlowCost } from '../costEstimate.js'
import isleLogo from '../assets/logo-tight.png'

/* 底部工具栏（S17-0a 拆分）：从 App.jsx 原样搬出，DOM/类名零改动。
   选择/抓手/添加/快捷键/运行整图 + 运行方式二级菜单（portal 挂 body）。
   Isle 开关：与左侧功能按钮同规格（tool-btn + 同一容器投影），
   面板打开时图标消失，面板任意方式关闭后重新出现。 */
export default function Toolbar({
  mode, setMode, menuAt, setMenuAt, helpOpen, setHelpOpen,
  running, runAll, runMenu, toggleRunMenu, runMenuAt, runMoreRef, setRunMenu,
  selectedId, runFromSelected, nodes, edges,
  agentOpen, onOpenAgent
}) {
  return (
    <div className="toolbar">
      <button
        className={'tool-btn icon' + (mode === 'select' ? ' active' : '')}
        title="鼠标选择（拖拽框选）"
        onClick={() => setMode('select')}
      ><IcSelect size={16} /></button>
      <button
        className={'tool-btn icon' + (mode === 'hand' ? ' active' : '')}
        title="鼠标移动画布（或按住空格拖拽）"
        onClick={() => setMode('hand')}
      ><IcHand size={16} /></button>
      <span className="tool-sep" />
      <button
        className={'tool-btn icon' + (menuAt === 'toolbar' ? ' active' : '')}
        title="添加节点"
        onClick={() => setMenuAt((v) => (v === 'toolbar' ? null : 'toolbar'))}
      ><IcPlus size={16} /></button>
      <button
        className={'tool-btn icon' + (helpOpen ? ' active' : '')}
        title="键盘快捷键（?）" aria-label="键盘快捷键"
        onClick={() => setHelpOpen((v) => !v)}
      ><IcKeyboard size={16} /></button>
      <span className="tool-sep" />
      {/* UI-010：运行整图 / 从选中节点运行的显式入口 */}
      <button
        className={'tool-run' + (running ? ' running' : '')}
        title="按连线依赖顺序运行全部节点（Ctrl+Enter）"
        aria-label="运行整图（全部节点）"
        disabled={running}
        onClick={runAll}
      >
        {running ? <><span className="run-spin sm" />运行中</> : <><IcPlay size={13} /> 运行整图（全部节点）</>}
      </button>
      <button
        ref={runMoreRef}
        className={'tool-run-more' + (runMenu ? ' open' : '')}
        title="更多运行方式" aria-label="更多运行方式"
        onClick={toggleRunMenu}
      ><IcCaret size={12} /></button>
      {/* Isle 开关：点开即隐，面板关闭后回归（见 AgentPanel 注释） */}
      {!agentOpen && (
        <button
          className="tool-btn icon isle-open"
          title="打开 Isle（Ctrl+/）"
          aria-label="打开 Isle 面板"
          onClick={onOpenAgent}
        ><img src={isleLogo} alt="" width={30} height={30} style={{ display: 'block' }} /></button>
      )}
      {runMenu && createPortal(
        <>
          {/* 遮罩挂 body：全屏覆盖，点击只关菜单不透传画布 */}
          <div className="menu-mask" onClick={() => setRunMenu(false)} />
          <div className="run-menu" style={{ position: 'fixed', right: runMenuAt.right, bottom: runMenuAt.bottom, top: 'auto' }}>
            {/* UI-037：无选中时置灰并说明原因，避免"点开才发现不可用" */}
            <button
              disabled={!selectedId}
              title={selectedId ? '从当前选中节点起跑其下游子图（Ctrl+Shift+Enter）' : '请先选中一个节点'}
              onClick={() => { setRunMenu(false); runFromSelected() }}
            >
              <IcPlay size={13} /> 从选中节点运行（含下游）<em>Ctrl+Shift+Enter</em>
            </button>
            {/* REQ-001：菜单内常驻整图预估，开菜单即见成本，不用等确认弹层 */}
            {(() => {
              const est = estimateFlowCost(nodes, edges, {})
              if (!est.items.length) return null
              return (
                <div className="run-menu-est" aria-live="polite">
                  {est.known
                    ? <>整图预估 ≈ <b>{est.total}</b> 积分（{est.items.length} 个生成节点）</>
                    : <>整图预估 ≈ <b>{est.total}</b> 积分 · <span className="est-unknown">{est.unknownCount} 个计费未知</span></>}
                </div>
              )
            })()}
            {/* UI-040：删除与工具栏键盘图标按钮重复的「键盘快捷键」入口 */}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

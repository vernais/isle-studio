import React from 'react'
import { IcAlert, IcCheck } from '../icons.jsx'

/* REQ-006a 审批卡（S17-2 起被两处复用，禁止各自复制一份改）
   - 画布 Isle 面板：生成操作审批（仍然执行 / 取消）
   - 首页规划卡：执行计划（建画布我自己改 / 全权委托执行 / 关闭）
   卡片结构、计费口径、结果行文案都在这里统一，两处只传数据与出口按钮。 */
const DEFAULT_ACTIONS = [
  { label: '取消', kind: 'ghost', value: false },
  { label: '仍然执行', kind: 'primary', value: true, icon: 'check' }
]

export default function ApprovalCard({
  title,
  subtitle = '',
  items = [],
  total = 0,
  unknownCount = 0,
  note,
  showDetail = false,
  decided = null,
  onDecide,
  actions = DEFAULT_ACTIONS,
  resultText = '',
  className = '',
  /* S17-3：委托执行的积分上限（只出现在决定前的计划卡上）。
     默认 = 规划合计 × 1.5 向上取整，可改；执行中触顶会自动暂停问用户 */
  budget = null
}) {
  const tone = className.includes('plan-card') ? ' plan' : ''
  return (
    <div className={'approval-card' + tone + (className ? ' ' + className : '')} role="dialog" aria-label={title}>
      <div className="approval-head"><IcAlert size={12} /> {title}</div>
      {subtitle && <div className="approval-sub">{subtitle}</div>}
      <div className="approval-items">
        {items.map((x) => (
          <div key={x.id} className="approval-item">
            <span className="ai-label">
              {x.step ? <b className="ai-step">{x.step}</b> : null}{x.label}{x.model ? ` · ${x.model}` : ''}
              {showDetail && x.detail ? <em className="ai-detail">{x.detail}</em> : null}
            </span>
            <span className={'ai-cost' + (x.known ? '' : ' unknown')}>
              {x.known ? `≈ ${x.credits} 积分` : '计费未知'}
            </span>
          </div>
        ))}
      </div>
      <div className="approval-total">
        合计预估 <b>≈ {total}</b> 积分
        {unknownCount > 0 && <em>（{unknownCount} 个节点计费未知，未计入）</em>}
        <span className="approval-note">{note || '预估仅供参考，实际以运行为准'}</span>
      </div>
      {budget && decided === null && (
        <div className="approval-budget">
          <label htmlFor={'budget-' + (budget.id || 'plan')}>积分上限</label>
          <input
            id={'budget-' + (budget.id || 'plan')}
            className="budget-input"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={budget.value}
            onChange={(e) => budget.onChange && budget.onChange(e.target.value)}
            title="委托执行时，消耗触顶会先暂停问你继续还是终止"
          />
          <span className="budget-unit">积分</span>
          <em className="budget-hint">触顶自动暂停，先问你继续还是终止</em>
        </div>
      )}
      {decided === null ? (
        <div className="approval-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              className={a.kind === 'primary' ? 'primary-btn' : 'ghost-btn'}
              onClick={() => onDecide && onDecide(a.value, a)}
            >
              {a.icon === 'check' ? <IcCheck size={12} /> : null}{a.label}
            </button>
          ))}
        </div>
      ) : (
        resultText ? <div className={'approval-result' + (decided ? ' ok' : '')}>{resultText}</div> : null
      )}
    </div>
  )
}

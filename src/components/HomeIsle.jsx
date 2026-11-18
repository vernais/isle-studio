import React, { useEffect, useRef } from 'react'
import ApprovalCard from './ApprovalCard.jsx'
import { IcSparkle, IcAlert, IcClose } from '../icons.jsx'

/* S17-2 首页沉浸态：Isle 会话 + 计划卡
   - 只做展示与出口点击；会话状态在 hooks/useHomeIsle.js，收起后仍然保留；
   - 计划卡复用 REQ-006 审批卡组件（ApprovalCard），不另写一套卡片。 */
const PLAN_ACTIONS = [
  { label: '关闭', kind: 'ghost', key: 'close', value: 'close' },
  { label: '建画布，我自己改', kind: 'ghost', key: 'build', value: 'build' },
  { label: '全权委托执行', kind: 'primary', key: 'delegate', value: 'delegate', icon: 'check' }
]

const RESULT_TEXT = {
  close: '已关闭 · 没有创建项目，也没有发出任何生成请求',
  build: '已按计划建好画布（未自动运行），可以在画布里自己调',
  delegate: '已委托执行，进度可在首页任务卡跟进',
  failed: '没能建好画布，计划还在这里，可以重试'
}

/* S17-3：默认积分上限 = 规划合计 × 1.5 向上取整（任务书口径） */
export const defaultBudget = (total) => Math.max(1, Math.ceil((Number(total) || 0) * 1.5))

export default function HomeIsle({ messages, busy, status, onDecide, onExit, onBudget, hasChatModel = true }) {
  const listRef = useRef(null)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy, status])

  return (
    <section className="home-isle" aria-label="Isle 会话">
      <div className="home-isle-head">
        <span className="panel-title"><IcSparkle size={14} /> Isle</span>
        <span className="isle-hint">{hasChatModel ? '说清楚要什么，我来拆成可执行的步骤' : '未配置对话模型时会按通用结构给方案'}</span>
        <button className="isle-collapse" onClick={onExit} title="收起，返回首页（Esc）">
          <IcClose size={13} /> 收起
        </button>
      </div>

      <div className="home-isle-msgs" ref={listRef}>
        {!messages.length && !busy && (
          <div className="isle-empty" role="status">
            <span className="agent-empty-ico"><IcSparkle size={18} /></span>
            <p>把想法说给我，我拆成步骤、标明模型与预估积分，你决定要不要执行</p>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === 'step') {
            return (
              <div key={i} className={'agent-step' + (m.err ? ' err' : '')}>
                {m.err ? <IcAlert size={11} className="step-ico" /> : <span className="step-dot" />}{m.content}
              </div>
            )
          }
          if (m.role === 'system') {
            return <div key={i} className="msg system">{m.content}</div>
          }
          if (m.role === 'plan') {
            const items = (m.est?.items || []).map((it, k) => ({ ...it, step: String(k + 1) }))
            const budgetRaw = m.budget ?? String(defaultBudget(m.est?.total))
            return (
              <ApprovalCard
                key={i}
                className="plan-card"
                title={`执行计划 · ${m.plan.title}`}
                subtitle={[m.plan.summary, m.note].filter(Boolean).join('　·　')}
                items={items}
                total={m.est?.total || 0}
                unknownCount={m.est?.unknownCount || 0}
                showDetail
                note={`共 ${m.plan.steps.length} 步 · 预估仅供参考，实际以运行为准`}
                decided={m.decided}
                actions={PLAN_ACTIONS}
                budget={{ id: String(i), value: budgetRaw, onChange: (v) => onBudget && onBudget(i, v) }}
                onDecide={(value, action) => onDecide && onDecide(i, action.key, m.plan, budgetRaw)}
                resultText={(RESULT_TEXT[m.choice] || '') + (m.choice === 'failed' && m.error ? `（${m.error}）` : '')}
              />
            )
          }
          return (
            <div key={i} className={'msg ' + m.role}>
              <div className="msg-bubble">{m.content}</div>
            </div>
          )
        })}

        {busy && <div className="agent-step live"><span className="step-dot pulse" />{status || '处理中…'}</div>}
      </div>
    </section>
  )
}

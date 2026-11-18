import React from 'react'
import { IcClose, IcAlert, IcCheck, IcRefresh } from '../icons.jsx'

export default function RunHud({ running, stats, summary, runEstimate, nodes, onDismiss, onFocusFail }) {
  if (running && stats) {
    const finished = stats.done + stats.failed
    const pct = stats.total ? Math.round((finished / stats.total) * 100) : 0
    return (
      <div className="run-hud">
        <div className="run-hud-head">
          <span className="run-spin" />运行整图
          <b>{finished}/{stats.total}</b>
        </div>
        <div className="run-bar"><i style={{ width: pct + '%' }} /></div>
        <div className="run-hud-meta">
          完成 {stats.done} · 进行中 {stats.active} · 失败 {stats.failed}
          {runEstimate && runEstimate.items.length > 0 && (
            <span className="run-hud-est">
              {runEstimate.known ? ` · 预估 ≈ ${runEstimate.total} 积分` : ` · ${runEstimate.unknownCount} 个节点计费未知`}
            </span>
          )}
        </div>
      </div>
    )
  }
  if (!summary) return null
  const label = (id) => {
    const n = (nodes || []).find((x) => x.id === id)
    return n ? (n.data?.label || n.type) : id
  }
  return (
    <div className={'run-hud done' + (summary.failed ? ' has-fail' : '')}>
      <button className="run-hud-close" title="关闭汇总" aria-label="关闭运行汇总" onClick={onDismiss}><IcClose size={12} /></button>
      <div className="run-hud-head">
        {summary.failed
          ? <><IcAlert size={14} /> 运行结束（有失败）</>
          : <><IcCheck size={14} /> 运行结束</>}
      </div>
      <div className="run-hud-meta">
        成功 <b className="ok">{summary.ok}</b> · 失败 <b className="bad">{summary.failed}</b> ·
        {summary.estimate && summary.estimate.items.length > 0 && (
          <> 预估 <b>{summary.estimate.known ? `≈ ${summary.estimate.total}` : '部分未知'}</b> ·</>
        )}
        实际 <b>{summary.credits}</b> 积分
        <span className="run-hud-total">（共 {summary.total} 个节点）</span>
      </div>
      {summary.failedIds.length > 0 && (
        <div className="run-fails">
          <span className="run-fails-label">失败节点</span>
          {summary.failedIds.map((id) => (
            <button key={id} className="run-fail-chip" title="定位到该节点" onClick={() => onFocusFail(id)}>
              <IcAlert size={10} /> {label(id)} · {id.replace(/^n_/, '#')}
            </button>
          ))}
        </div>
      )}
      {summary.failed > 0 && (
        <button className="run-retry-all" onClick={() => onFocusFail(summary.failedIds[0])}>
          <IcRefresh size={11} /> 定位第一个失败节点
        </button>
      )}
    </div>
  )
}

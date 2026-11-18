import React from 'react'
import { IcAlert, IcCheck, IcCaret, IcBolt } from '../icons.jsx'

/* S17-3 任务卡（首页默认态）
   - 执行中：进度 n/m + 已消耗 + 「进入画布接管 →」
   - 待验收：消耗汇总 + 产物数 + 「去验收 →」
   - 失败 / 中止：原因 + 「重试」
   - 接管 / 预算终止：剩余步骤未执行，产物保留 + 「去验收 →」
   数据只来自 App 级任务 store（useTasks），这里不做二次推导。 */

const STATE_LABEL = {
  running: '执行中',
  paused: '等待确认',
  done: '待验收',
  failed: '失败',
  aborted: '已中止',
  taken: '已接管',
  stopped: '已暂停'
}

const money = (v) => {
  const n = Number(v) || 0
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

const timeOf = (ts) => (ts
  ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '')

export default function TaskCards({ tasks, currentProjectKey, onOpen, onResume, onTakeover, onRetry, onAccepted }) {
  if (!tasks || !tasks.length) return null
  const active = tasks.filter((t) => t.status === 'running' || t.status === 'paused')
  /* 结束态只看最近 24 小时：更早的任务不该长期挂在首页 */
  const recent = tasks.filter((t) => t.status !== 'running' && t.status !== 'paused'
    && (t.endedAt || t.startedAt || 0) > Date.now() - 86400000)
  const list = (active.length ? active : recent).slice(0, 3)
  if (!list.length) return null

  const openProject = (t) => {
    /* B-5：点击「去验收」即视为已验收——导航后清掉同项目的结束态任务卡
      （同一画布多次委托执行会有多条记录，一并收掉） */
    if (typeof onAccepted === 'function') onAccepted(t)
    if (t.projectKey && t.projectKey === currentProjectKey && typeof onResume === 'function') return onResume()
    if (String(t.projectKey || '').startsWith('proj:') && typeof onOpen === 'function') return onOpen(String(t.projectKey).slice(5))
    return undefined
  }

  return (
    <div className="home-tasks" role="list" aria-label="任务">
      {list.map((t) => {
        const total = Number(t.total) || 0
        const done = Number(t.done) || 0
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
        const live = t.status === 'running' || t.status === 'paused'
        const pending = (t.stoppedIds || []).length
        return (
          <div className={'task-card ' + t.status} key={t.id} role="listitem" data-task-id={t.id} data-status={t.status}>
            <div className="task-top">
              <span className={'task-state' + (live ? ' live' : '')}>
                {live ? <span className="task-dot" /> : (t.status === 'done' ? <IcCheck size={11} /> : <IcAlert size={11} />)}
                {STATE_LABEL[t.status] || t.status}
              </span>
              <b className="task-name" title={t.projectName}>{t.projectName || '未命名画布'}</b>
              <span className="task-when">{timeOf(t.endedAt || t.startedAt)}</span>
            </div>

            {live ? (
              <>
                <div className="task-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: pct + '%' }} />
                </div>
                <div className="task-line">
                  <span>进度 {done}/{total || '—'}</span>
                  <span>已消耗 {money(t.credits)} 积分{t.budget > 0 ? ` / 上限 ${t.budget}` : ''}</span>
                  {t.status === 'paused' && <span className="task-warn">已达上限，等你确认</span>}
                </div>
                <div className="task-actions">
                  <button className="task-link" onClick={() => onTakeover && onTakeover(t)}>
                    进入画布接管 <IcCaret size={11} />
                  </button>
                </div>
              </>
            ) : t.status === 'done' ? (
              <>
                <div className="task-line">
                  <span>{t.artifacts || done} 个产物 · 消耗 {money(t.credits)} 积分</span>
                  {t.estimate > 0 && <span className="task-dim">预估 {money(t.estimate)}</span>}
                </div>
                <div className="task-actions">
                  <button className="task-link" onClick={() => openProject(t)}>去验收 <IcCaret size={11} /></button>
                </div>
              </>
            ) : t.status === 'taken' ? (
              <>
                <div className="task-line">
                  <span>已接管 · 已生成 {t.artifacts || done} 个产物{pending ? `，剩余 ${pending} 步由你接手` : ''}</span>
                </div>
                <div className="task-actions">
                  <button className="task-link" onClick={() => openProject(t)}>去验收 <IcCaret size={11} /></button>
                </div>
              </>
            ) : t.status === 'stopped' ? (
              <>
                <div className="task-line">
                  <span>按上限停止 · 已生成 {t.artifacts || done} 个产物{pending ? `，剩余 ${pending} 步未执行` : ''}</span>
                </div>
                <div className="task-actions">
                  <button className="task-link" onClick={() => openProject(t)}>去验收 <IcCaret size={11} /></button>
                  <button className="task-link" onClick={() => onRetry && onRetry(t)}><IcBolt size={11} /> 继续跑</button>
                </div>
              </>
            ) : (
              <>
                <div className="task-line">
                  <span className="task-err" title={t.error || ''}>{t.error || (t.status === 'aborted' ? '应用已关闭，任务已中止' : '运行失败')}</span>
                </div>
                <div className="task-actions">
                  <button className="task-link" onClick={() => openProject(t)}>去画布看看 <IcCaret size={11} /></button>
                  <button className="task-link" onClick={() => onRetry && onRetry(t)}><IcBolt size={11} /> 重试</button>
                </div>
              </>
            )}
          </div>
        )
      })}
      {/* 任务书 S17-3 第 5 条：边界必须写清楚，不让用户以为关了应用任务还在后台跑 */}
      <div className="task-note">关闭应用后执行会中止，重开项目可对未完成节点重试</div>
    </div>
  )
}

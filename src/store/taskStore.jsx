/* S17-0b / TECH-005：跨视图任务 store
   ------------------------------------------------------------------
   为什么需要它：运行状态原来只活在画布窗口的组件 state 里（running / spent / runSummary），
   首页完全看不见，多项目并行时也无处汇总。这里把「任务记录」提升为 App 级单一数据源：

     · 画布 runFlow 的每一步（开工 / 计划 / 单节点结束 / 扣积分 / 收尾）写入 store；
     · 首页只读消费，不做二次推导，也不持有自己的副本；
     · 任务记录落盘到 userData/tasks.json（主进程合并写），多窗口 / 多项目并行互不覆盖；
     · 关闭应用时本窗口的「执行中」任务如实落为 aborted——宁可显示中止，也不出现假完成。

   实现：Context + useSyncExternalStore（React 内置，无新依赖）。
   数据本体放在普通 Map 里而不是 React state：
   运行回调是事件流（spend/nodeEnd 会在同一 tick 里连续触发），
   用 Map + 版本号可以保证「读到的就是最新的」，不会因批次合并丢步骤。
*/
import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

export const TASK_ABORT_REASON = '应用已关闭，任务已中止'
const HEARTBEAT_MS = 5000
const WRITE_DEBOUNCE_MS = 200

/* 本窗口会话标识：主进程用它判断「发起任务的窗口是否还活着」，
   窗口关闭/崩溃后，它的 running 任务在下次读取时会被如实归一化为 aborted */
const SESSION_ID = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
export const taskSessionId = SESSION_ID

let seq = 0
const nextTaskId = () => `t_${Date.now().toString(36)}_${(seq++).toString(36)}`

function createStore() {
  const map = new Map()
  const listeners = new Set()
  let version = 0
  const emit = () => { version += 1; listeners.forEach((fn) => fn()) }
  const pending = { upsert: new Map(), remove: new Set() }
  let timer = null

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!pending.upsert.size && !pending.remove.size) return Promise.resolve()
    const args = {
      sessionId: SESSION_ID,
      upsert: [...pending.upsert.values()],
      remove: [...pending.remove]
    }
    pending.upsert.clear()
    pending.remove.clear()
    if (typeof window === 'undefined' || typeof window.flow?.tasksMerge !== 'function') return Promise.resolve()
    return window.flow.tasksMerge(args).catch(() => {})
  }

  const queueWrite = (rec) => {
    if (rec) pending.upsert.set(rec.id, rec)
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, WRITE_DEBOUNCE_MS)
  }

  const put = (rec, { write = true } = {}) => {
    map.set(rec.id, rec)
    emit()
    if (write) queueWrite(rec)
  }

  const patch = (id, fn) => {
    const cur = map.get(id)
    if (!cur) return null
    const next = { ...cur, ...fn(cur), updatedAt: Date.now() }
    put(next)
    return next
  }

  const api = {
    /* 开工：返回 taskId，调用方后续所有步骤都带着它 */
    start({ projectKey, projectName, scope = 'all', total = 0, estimate = 0, nodes = 0, budget = 0, delegated = false }) {
      const now = Date.now()
      const rec = {
        id: nextTaskId(),
        projectKey: projectKey || '',
        projectName: projectName || '未命名画布',
        scope, status: 'running',
        total: Math.max(0, total | 0), done: 0, failed: 0,
        nodes: Math.max(0, nodes | 0),
        credits: 0, estimate: Number(estimate) || 0,
        /* S17-3：委托执行的预算上限（0 = 不设限）与接管标记 */
        budget: Math.max(0, Number(budget) || 0),
        delegated: !!delegated, takenOver: false, artifacts: 0, failIds: [],
        startedAt: now, endedAt: 0, beatAt: now, updatedAt: now,
        session: SESSION_ID, error: ''
      }
      put(rec)
      return rec.id
    },
    get(id) { return map.get(id) || null },
    /* 预算上限可在执行前改（计划卡里那一格），执行中改也有效 */
    setBudget(id, limit) {
      patch(id, () => ({ budget: Math.max(0, Math.round(Number(limit) || 0)) }))
    },
    /* 接管：进入画布后 Isle 不再派发新步骤——拦截点读这个标记 */
    takeover(id) {
      patch(id, () => ({ takenOver: true, takenAt: Date.now() }))
      return flush()
    },
    /* 触达预算上限时挂起（不是失败），等用户选继续 / 终止 */
    pause(id, info = {}) {
      patch(id, () => ({
        status: 'paused', pauseReason: info.reason || 'reached_budget',
        pauseAt: Date.now(), beatAt: Date.now()
      }))
    },
    unpause(id) {
      patch(id, () => ({ status: 'running', pauseReason: '', beatAt: Date.now() }))
    },
    /* 执行计划就绪：进度分母以真实节点集合为准 */
    plan(id, nodeIds) {
      patch(id, () => ({ total: (nodeIds || []).length, nodeIds: (nodeIds || []).slice(0, 200) }))
    },
    nodeEnd(id, ok, nodeId) {
      patch(id, (t) => ({
        done: t.done + 1,
        failed: t.failed + (ok ? 0 : 1),
        artifacts: ok ? (t.artifacts || 0) + 1 : (t.artifacts || 0),
        failIds: ok || !nodeId ? (t.failIds || []) : [...(t.failIds || []), nodeId],
        beatAt: Date.now()
      }))
    },
    spend(id, credits) {
      const c = Number(credits) || 0
      if (!c) return
      patch(id, (t) => ({ credits: Math.round((t.credits + c) * 100) / 100 }))
    },
    /* 收尾：全失败 = failed；有产物 = done（首页显示「待验收」）；
       stopped = 预算到顶被终止 / 用户接管，剩余步骤如实标记「未执行」，不算失败也不算完成 */
    finish(id, res = {}) {
      const ok = Number(res.ok) || 0
      const failed = Number(res.failed) || 0
      const credits = Number(res.credits) || 0
      const stopped = !!res.stopped
      patch(id, (t) => {
        const taken = !!t.takenOver
        let status = ok > 0 || failed === 0 ? 'done' : 'failed'
        if (stopped) status = taken ? 'taken' : 'stopped'
        return {
          status,
          done: Math.max(t.done, ok + failed),
          failed: Math.max(t.failed, failed),
          artifacts: Math.max(t.artifacts || 0, ok),
          credits: credits > 0 ? credits : t.credits,
          endedAt: Date.now(),
          beatAt: Date.now(),
          stoppedIds: stopped ? (res.stoppedIds || []) : [],
          error: !stopped && ok === 0 && failed > 0 ? (res.error || '全部节点失败') : '',
          pauseReason: ''
        }
      })
      flush()
    },
    fail(id, error) {
      patch(id, () => ({ status: 'failed', endedAt: Date.now(), beatAt: Date.now(), error: String(error || '运行失败') }))
      flush()
    },
    /* 关闭应用 / 返回首页中断：只处理本窗口发起的任务（挂起等确认的任务也算在跑） */
    abortMine(reason = TASK_ABORT_REASON) {
      const now = Date.now()
      let touched = false
      for (const t of map.values()) {
        if ((t.status !== 'running' && t.status !== 'paused') || t.session !== SESSION_ID) continue
        map.set(t.id, { ...t, status: 'aborted', endedAt: now, beatAt: now, updatedAt: now, error: reason })
        pending.upsert.set(t.id, map.get(t.id))
        touched = true
      }
      if (touched) emit()
      return flush()
    },
    remove(id) {
      map.delete(id)
      pending.remove.add(id)
      emit()
      queueWrite(null)
      return flush()
    },
    /* B-5：未命名画布命名保存后，本窗口此前以 session:<id> 落的任务记录并入项目——
       首页任务卡从此显示项目名、可「去验收」直达，不再出现一串「未命名画布」 */
    rebindSession(projectKey, projectName) {
      const key = 'session:' + SESSION_ID
      let touched = false
      for (const t of map.values()) {
        if (t.projectKey !== key) continue
        const rec = { ...t, projectKey, projectName: projectName || t.projectName, updatedAt: Date.now() }
        map.set(t.id, rec)
        pending.upsert.set(t.id, rec)
        touched = true
      }
      if (touched) { emit(); queueWrite(null); return flush() }
      return Promise.resolve()
    },
    /* B-5：验收完成——清掉该项目同 key 的全部结束态记录（多次委托执行会产生多条，一并收掉） */
    removeDoneByKey(projectKey) {
      let touched = false
      for (const t of [...map.values()]) {
        if (t.projectKey !== projectKey) continue
        if (t.status === 'running' || t.status === 'paused') continue
        map.delete(t.id)
        pending.remove.add(t.id)
        touched = true
      }
      if (touched) { emit(); return flush() }
      return Promise.resolve()
    },
    /* 心跳：让其他窗口/重启后的判断知道这条任务还在跑 */
    heartbeat() {
      const now = Date.now()
      let touched = false
      for (const t of map.values()) {
        if (t.status !== 'running' && t.status !== 'paused') continue
        const rec = { ...t, beatAt: now, updatedAt: now }
        map.set(t.id, rec)
        pending.upsert.set(t.id, rec)
        touched = true
      }
      if (touched) { emit(); queueWrite(null) }
    },
    async hydrate() {
      if (typeof window.flow?.tasksHello === 'function') await window.flow.tasksHello({ sessionId: SESSION_ID }).catch(() => {})
      if (typeof window.flow?.tasksRead !== 'function') return
      const r = await window.flow.tasksRead({ sessionId: SESSION_ID }).catch(() => null)
      if (!r?.tasks) return
      map.clear()
      for (const t of r.tasks) if (t?.id) map.set(t.id, t)
      emit()
    },
    absorb(list) {
      if (!Array.isArray(list)) return
      map.clear()
      for (const t of list) if (t?.id) map.set(t.id, t)
      emit()
    },
    flush,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    getVersion() { return version },
    /* 统一按开始时间倒序：Map 的插入顺序会受 hydrate/新增影响，不该泄漏给消费方 */
    list() { return [...map.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)) }
  }
  return api
}

const Ctx = createContext(null)

export function TaskProvider({ children }) {
  const storeRef = useRef(null)
  if (!storeRef.current) storeRef.current = createStore()
  const store = storeRef.current

  useEffect(() => {
    store.hydrate()
    const off = typeof window.flow?.onTasksChanged === 'function'
      ? window.flow.onTasksChanged((payload) => store.absorb(payload?.tasks))
      : null
    const hb = setInterval(() => store.heartbeat(), HEARTBEAT_MS)
    const onUnload = () => { store.abortMine() }
    window.addEventListener('beforeunload', onUnload)
    return () => {
      clearInterval(hb)
      window.removeEventListener('beforeunload', onUnload)
      if (typeof off === 'function') off()
    }
  }, [store])

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

/* 只读消费：返回任务数组（按开始时间倒序），版本变化才重建 */
export function useTasks() {
  const store = useContext(Ctx)
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return useMemo(() => store.list(), [store, version])
}

export function useTaskApi() {
  return useContext(Ctx)
}

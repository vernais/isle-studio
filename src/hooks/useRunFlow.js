/* S17-0a：从 App.jsx 抽出的运行调度（纯搬移，逻辑逐行保持原样）
   运行：单节点 / 整图 / 从选中节点（UI-010）
   UI 与 Agent 的 run_all 共用 runFlow 这一套调度，不复制第二份执行逻辑。
   REQ-001：批量运行前做积分预估门——预估超阈值弹确认，取消则不发任何请求 */
import { estimateFlowCost, estimateNodeCost } from '../costEstimate.js'
import { runFlow } from '../engine.js'
import { useTaskApi } from '../store/taskStore.jsx'

export const RUN_CONFIRM_THRESHOLD = 50

export function estimateText(est) {
  if (!est.items.length) return '画布上没有可运行的生成节点'
  const lines = est.items.map((x) =>
    `· ${x.label}${x.model ? `（${x.model}）` : ''}　${x.known ? `≈ ${x.credits} 积分` : '计费未知'}`)
  return lines.join('\n') + `\n合计预估 ${est.total} 积分` +
    (est.unknownCount ? `（另有 ${est.unknownCount} 个节点计费未知，未计入合计）` : '')
}

export function useRunFlow({
  nodesRef, edgesRef, runningRef, update,
  setRunning, setRunSummary, setRunIds, setRunEstimate, setSpent,
  setSettingsTab, setShowSettings, showToast, askConfirm, genPrefsRef, placeResult, selectedId,
  taskCtxRef
}) {
  /* S17-0b：运行状态写入 App 级任务 store（首页只读消费同一份数据）。
     画布内的 running/spent 仍是本窗口的实时视图，store 才是任务记录的单一来源 */
  const taskApi = useTaskApi()

  const gateByEstimate = async (scope) => {
    const est = estimateFlowCost(nodesRef.current, edgesRef.current, scope)
    if (est.items.length && est.total > RUN_CONFIRM_THRESHOLD) {
      const ok = await askConfirm({
        title: '本次运行预估消耗较大',
        text: estimateText(est),
        okText: '仍然运行'
      })
      if (!ok) return null
    }
    return est
  }

  const execute = async ({ onlyId, fromId, continueOnError = true, silent = false, estimate = null, skipDone = false, budget = 0, delegated = false } = {}) => {
    if (runningRef.current) return null
    const s = await window.flow.getSettings()
    const hasModels = ['image', 'video', 'chat'].some((k) => (s.models?.[k] || []).length)
    /* S16-2：无模型时不仅开设置，还要落到接口页并说明原因——否则用户视角是「点了运行莫名其妙弹设置」 */
    if (!hasModels) {
      setSettingsTab('api')
      setShowSettings(true)
      showToast('尚未配置模型，请先在「接口」页添加 API Key')
      return null
    }
    if (!nodesRef.current.length) { if (!silent) showToast('画布上还没有节点'); return null }
    runningRef.current = true
    setRunning(true)
    setRunSummary(null)
    setRunIds(null)
    const est = estimate || estimateFlowCost(nodesRef.current, edgesRef.current, { onlyId, fromId })
    setRunEstimate(est)
    /* S17-0b：先记任务再发包——中途被关/崩，首页也能看到「已中止」而不是什么都没有 */
    const meta = taskCtxRef?.current || {}
    const taskId = taskApi.start({
      projectKey: meta.projectKey,
      projectName: meta.projectName,
      scope: onlyId ? 'node' : fromId ? 'from' : 'all',
      total: est.items.length,
      estimate: est.total,
      nodes: est.items.length,
      budget,
      delegated
    })
    /* S17-3：节点边界的预算 / 接管拦截。只在委托执行或设了上限时挂上，
       普通手动运行完全不经过它（旧行为零变化）。 */
    let limit = Math.max(0, Number(budget) || 0)
    let exempt = false
    const guard = (limit > 0 || delegated)
      ? async ({ node }) => {
        const cur = taskApi.get(taskId)
        if (cur?.takenOver) return 'stop'
        if (exempt || !limit) return 'run'
        const used = Number(cur?.credits) || 0
        const one = estimateNodeCost(node)
        const add = one?.known ? Number(one.credits) || 0 : 0
        if (used + add <= limit) return 'run'
        taskApi.pause(taskId, { reason: 'budget' })
        let go = false
        try {
          go = await askConfirm({
            title: '已达积分上限，是否继续？',
            text: `已消耗 ${used.toFixed(1)} 积分，上限 ${limit} 积分。\n下一个节点「${node.data?.label || '生成节点'}」预计 ${add ? add + ' 积分' : '计费未知'}，继续会超出上限。\n选「终止」立即停下，剩余步骤不会发出任何请求。`,
            okText: '继续执行',
            cancelText: '终止',
            danger: true
          })
        } catch { go = false }
        if (!go) return 'stop'
        exempt = true // 用户已明确授权本次超限，不再反复打断
        taskApi.unpause(taskId)
        return 'run'
      }
      : null
    try {
      const res = await runFlow({
        nodes: nodesRef.current, edges: edgesRef.current, update,
        onSpend: (c) => { setSpent((v) => v + c); taskApi.spend(taskId, c) },
        onlyId, fromId, continueOnError, skipDone, guard,
        regenerate: genPrefsRef.current.regenerate,
        onResult: placeResult,
        onPlan: (ids) => { setRunIds(ids); taskApi.plan(taskId, ids) },
        onNodeEnd: (id, ok) => taskApi.nodeEnd(taskId, ok, id)
      })
      setRunSummary({ ...res, estimate: est, at: Date.now() })
      taskApi.finish(taskId, res)
      /* S20-3：委托执行完成 → 结果摘要写入项目记忆（自动提取失败不影响主流程） */
      if (delegated && !res?.stopped && meta.projectKey) {
        try {
          window.flow.memorySave({
            key: meta.projectKey,
            entry: {
              text: `委托执行「${meta.projectName || ''}」完成：${res?.ok ?? 0} 个节点成功、${res?.failed ?? 0} 个失败，消耗 ${Number(res?.credits || 0).toFixed(1)} 积分`,
              source: 'delegate'
            }
          })
        } catch { }
      }
      if (res?.stopped) {
        showToast(res.stoppedIds?.length ? `已停下，剩余 ${res.stoppedIds.length} 个节点未执行` : '已停下')
      }
      return res
    } catch (err) {
      console.error(err)
      taskApi.fail(taskId, err?.message || err)
      return null
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }

  const doRun = (onlyId) => execute({ onlyId, continueOnError: false, silent: true })

  const runAll = async () => {
    if (runningRef.current) return null
    const est = await gateByEstimate({})
    if (!est) return null
    return execute({ continueOnError: true, estimate: est })
  }

  const runFromSelected = async () => {
    if (!selectedId) { showToast('请先选中一个节点，再从它开始运行'); return null }
    if (runningRef.current) return null
    const est = await gateByEstimate({ fromId: selectedId })
    if (!est) return null
    return execute({ fromId: selectedId, continueOnError: true, estimate: est })
  }

  return { execute, doRun, runAll, runFromSelected, gateByEstimate }
}

import { useCallback, useRef, useState } from 'react'
import { PLANNER_SYSTEM_PROMPT, PLAN_MAX_ROUNDS, parsePlannerReply, heuristicPlan, estimatePlan } from '../lib/planner.js'
import { modelPricingKnown } from '../costEstimate.js'

/* S17-2 首页 Isle 会话：brief → 澄清（≤3 轮）→ 执行计划 → 计划卡
   - 会话状态住在这里，HomeScreen 只负责布局与输入条——收起沉浸态时会话不丢；
   - 计划卡的两个出口通过 onCreateFromPlan 交回 App（建画布 / 建画布并委托执行）；
   - 任何一步失败都退回启发式计划，不用技术语言糊用户一脸。 */
export default function useHomeIsle({ onCreateFromPlan }) {
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const roundRef = useRef(0)
  const threadRef = useRef([]) // 参与后续对话的 user/assistant 记录（步骤与计划卡不进上下文）
  const modelsRef = useRef({ image: [], video: [] })

  const push = useCallback((m) => setMessages((ms) => [...ms, m]), [])

  const addPlan = useCallback((plan, models, note) => {
    const est = estimatePlan(plan, { models })
    setMessages((ms) => [...ms, {
      role: 'plan', plan, est,
      note: note || (plan.source === 'heuristic' ? '这版是通用结构，补充一句细节我可以再拆细' : ''),
      decided: null, choice: ''
    }])
  }, [])

  const send = useCallback(async (raw) => {
    const brief = String(raw || '').trim()
    if (!brief || busy) return
    push({ role: 'user', content: brief })
    threadRef.current.push({ role: 'user', content: brief })
    setBusy(true)
    setStatus('正在拆解你的想法…')
    try {
      const s = await window.flow.getSettings()
      /* 给 LLM 的可用模型按「计费已知优先」排序：带Key实测（2026-11-01），
         未定价模型（如网关未配价的 dall-e-3）发任何请求都会 500，
         LLM 默认挑列表第一个，必须让它先看到可用模型 */
      const knownFirst = (list, kind) => {
        const arr = (list || []).map((m) => m.model)
        return [...arr.filter((m) => modelPricingKnown(m, kind)), ...arr.filter((m) => !modelPricingKnown(m, kind))]
      }
      const models = {
        image: knownFirst(s.models?.image, 'image'),
        video: knownFirst(s.models?.video, 'video')
      }
      modelsRef.current = models
      const chats = s.models?.chat || []
      const picked = chats[0]
      if (!picked) {
        addPlan(heuristicPlan(brief), models, '还没有配置 Isle 对话模型，先按通用结构给你一版；配好模型后可以再细化')
        return
      }

      const forcePlan = roundRef.current >= PLAN_MAX_ROUNDS
      const msgs = [
        {
          role: 'system',
          content: PLANNER_SYSTEM_PROMPT
            + `\n\n可用模型：图片 ${models.image.join('、') || '（未配置）'}；视频 ${models.video.join('、') || '（未配置）'}`
        },
        ...threadRef.current.slice(-8),
        ...(forcePlan ? [{ role: 'user', content: '信息已经足够，请直接输出执行计划 JSON。' }] : [])
      ]
      setStatus('正在规划…')
      const r = await window.flow.agentStep({
        model: picked.model, messages: msgs, baseUrl: picked.baseUrl, apiKey: picked.apiKey
      })
      if (!r || r.ok === false) throw new Error(r?.error || '规划请求失败')
      const content = String(r.message?.content || '')
      const parsed = parsePlannerReply(content)

      if (parsed?.plan) {
        addPlan(parsed.plan, models)
        threadRef.current.push({ role: 'assistant', content: `计划：${parsed.plan.title}` })
        return
      }
      if (parsed?.ask && !forcePlan) {
        push({ role: 'assistant', content: parsed.ask })
        threadRef.current.push({ role: 'assistant', content: parsed.ask })
        roundRef.current++
        return
      }
      const plain = content.trim().slice(0, 400)
      if (plain && !forcePlan) {
        push({ role: 'assistant', content: plain })
        threadRef.current.push({ role: 'assistant', content: plain })
        roundRef.current++
        return
      }
      addPlan(heuristicPlan(brief), models, '先按通用结构给你一版，你可以直接在计划上改，或再补一句细节')
    } catch {
      addPlan(heuristicPlan(brief), modelsRef.current, '这次没来得及细聊，先按通用结构给你一版；稍后可以再让我细化')
    } finally {
      setBusy(false)
      setStatus('')
    }
  }, [busy, push, addPlan])

  /* S17-3：计划卡的积分上限（字符串保存，允许用户把输入框清空再输入） */
  const setPlanBudget = useCallback((index, value) => {
    setMessages((ms) => ms.map((m, i) => (i === index ? { ...m, budget: value } : m)))
  }, [])

  /* 计划卡出口：关闭 = 什么都不做（不建项目、不发请求）；另有建画布 / 委托执行 */
  const decide = useCallback(async (index, key, plan, budget) => {
    const setOne = (patch) => setMessages((ms) => ms.map((m, i) => (i === index ? { ...m, ...patch } : m)))
    if (key === 'close') {
      setOne({ decided: false, choice: 'close' })
      return
    }
    if (!plan) return
    const mode = key === 'delegate' ? 'delegate' : 'build'
    let r = { ok: false }
    try {
      r = (await onCreateFromPlan?.(plan, { autoRun: mode === 'delegate', budget: Math.max(0, Math.round(Number(budget) || 0)) })) || { ok: false }
    } catch (e) {
      r = { ok: false, error: String(e?.message || e) }
    }
    setOne({ decided: !!r.ok, choice: r.ok ? mode : 'failed', error: r.error || '', projectName: r.projectName || '' })
  }, [onCreateFromPlan])

  return { messages, busy, status, send, decide, setPlanBudget }
}

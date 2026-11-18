import { api } from './api.js'
import { isAutoSize, measureRatio, uploadedWidth } from './lib/cardSize.js'
import { mergePromptParts } from './lib/promptParts.js'
import { isVideoUrl, needsRefVideo } from './lib/mediaRef.js'
import { isKlingV4, klingModeOf, rolePromptBlock, audioPromptBlock } from './lib/klingVideo.js'
import { sanitizeImageParams } from './lib/imageSpecs.js'

/* 生成请求的超时上限（REF-001）。图片 10 分钟；视频按上游文档给 30 分钟。 */
export const GEN_TIMEOUT_MS = { image: 10 * 60 * 1000, video: 30 * 60 * 1000 }

/* 1.2.0：同一节点的单飞锁。
   「一次用户操作只创建一个付费任务」——UI 连点、Agent 与手动同时触发、
   重试与自动重跑交叠时，第二个入口在这里被挡住，不会重复提交/重复扣费。 */
const inflightNodes = new Set()
export const isNodeInflight = (id) => inflightNodes.has(id)

/* 拓扑排序：图片节点先行，视频节点等上游图片完成后接力。
   上传素材卡（data.uploaded）不是生成任务，只作为上游供给，绝不进入运行队列。
   - incoming：就绪判定链，仅含生成节点上游（素材卡永远不阻塞调度）
   - refIncoming：参考图链，含上传素材卡上游（FIX：素材卡连线此前被丢弃，
     导致「上传图→连线→生成」的参考图完全不生效；与参考栏 UI 口径一致）
   导出供 costEstimate.js 复用，保证预估与实际执行的节点集合口径一致（REQ-001）。 */
export function topoOrder(nodes, edges) {
  /* P2：配音节点（audio）参与运行调度；P3：成片合成（compose）本地跑；上传素材卡不跑 */
  const gen = nodes.filter((n) => (n.type === 'image' || n.type === 'video' || n.type === 'audio' || n.type === 'compose') && !n.data?.uploaded)
  const ids = new Set(gen.map((n) => n.id))
  const incoming = new Map(gen.map((n) => [n.id, []]))
  const refIncoming = new Map(gen.map((n) => [n.id, []]))
  for (const e of edges) {
    if (!ids.has(e.target)) continue
    if (ids.has(e.source)) incoming.get(e.target).push(e.source)
    refIncoming.get(e.target).push(e.source)
  }
  const order = []
  const done = new Set()
  while (order.length < gen.length) {
    const ready = gen.filter((n) => !done.has(n.id) && incoming.get(n.id).every((s) => done.has(s)))
    if (!ready.length) break
    for (const n of ready) { order.push(n); done.add(n.id) }
  }
  for (const n of gen) if (!done.has(n.id)) order.push(n)
  return { order, incoming, refIncoming }
}

/* 从某节点出发的下游集合（含自身）：用于「从选中节点运行」 */
export function downstreamOf(startId, edges) {
  const set = new Set([startId])
  let grow = true
  while (grow) {
    grow = false
    for (const e of edges) {
      if (set.has(e.source) && !set.has(e.target)) { set.add(e.target); grow = true }
    }
  }
  return set
}

/* Q1-1（REQ-004）参考图角色语义：按 refs 最终顺序生成角色描述块。
   - 连线上游角色存于 node.data.refRoles[上游 nodeId]；本地参考键为 local:<下标>
   - 仅列出已设角色的参考图；未设任何角色时返回 ''（prompt 与旧版逐字节一致）
   - 输出序号 = 该图在 imageUrls 数组中的下标 + 1，模型按顺序识别第 N 张参考图 */
function refRoleBlock(d, refEntries) {
  const roles = d.refRoles || {}
  const lines = []
  refEntries.forEach((ent, i) => {
    const role = roles[ent.key]
    if (!role) return
    lines.push(`参考图${i + 1}（${role}）：${ent.label || ent.key}`)
  })
  return lines.length ? lines.join('\n') : ''
}

/* 沿上游边收集提示词文本节点的内容（跳过图片/视频节点） */
function collectText(nodeId, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const found = new Set()
  let frontier = [nodeId]
  while (frontier.length) {
    const next = []
    for (const t of frontier) {
      for (const e of edges) {
        if (e.target !== t || found.has(e.source)) continue
        const src = byId.get(e.source)
        if (src?.type === 'text') { found.add(e.source); continue }
        if (src?.type === 'image' || src?.type === 'video') continue
        next.push(e.source)
      }
    }
    frontier = next
  }
  return [...found].map((id) => (byId.get(id)?.data?.text || '').trim()).filter(Boolean)
}

function filenameFromUrl(url, fallbackExt) {
  if (url.startsWith('data:')) return `out_${Date.now()}${fallbackExt}`
  try {
    const u = new URL(url)
    const base = u.pathname.split('/').filter(Boolean).pop() || 'output'
    return base.includes('.') ? base : base + fallbackExt
  } catch {
    return `out_${Date.now()}${fallbackExt}`
  }
}

/** 在设置里查找某模型的独立 API 配置；找不到则回退全局 Key */
async function credsFor(kind, modelName) {
  const s = await window.flow.getSettings()
  const hit = (s.models?.[kind] || []).find((m) => m.model === modelName)
  if (hit) return { baseUrl: hit.baseUrl, apiKey: hit.apiKey }
  return { baseUrl: s.baseUrl, apiKey: s.apiKey }
}

/* P2：读音频真实时长（配音卡显示秒数，也用于判断口播长度是否够用） */
function measureAudioSeconds(src) {
  return new Promise((res) => {
    if (!src) return res(0)
    try {
      const a = document.createElement('audio')
      a.preload = 'metadata'
      a.onloadedmetadata = () => res(Number.isFinite(a.duration) ? a.duration : 0)
      a.onerror = () => res(0)
      a.src = src
    } catch { res(0) }
  })
}

/* 任务完成后的落位（REF-001 + REF-006）
   - 上层传了 onResult 且返回 'placed'：由上层把结果落到新节点（再生成行为=新建节点），引擎不再写本节点；
   - 否则直接写回本节点（原地覆盖 / 首次生成）。 */
function settle(node, patch, update, onResult) {
  if (onResult && onResult(node, patch) === 'placed') return 'placed'
  update(node.id, patch)
  return 'inplace'
}

/* 任务收尾：轮询 → 取产物 URL → 扣费回报 → 落位 */
async function finishTask({ node, taskId, kind, creds, timeoutMs, update, onSpend, onResult, startedAt, place = 'inplace' }) {
  const left = timeoutMs - (Date.now() - (startedAt || Date.now()))
  if (left <= 0) {
    const err = new Error(`生成超时（超过 ${Math.round(timeoutMs / 60000)} 分钟未返回），可重试或稍后查询任务状态`)
    err.timeout = true
    throw err
  }
  const done = await api.pollTask(taskId, creds, (p) => update(node.id, { progress: p }), { timeoutMs: left })
  const urls = kind === 'video' ? api.extractVideoUrls(done.result) : api.extractImageUrls(done.result)
  /* BUG-2 防护：任务成功但一条产物都没提取到时，绝不静默置 done（旧行为会把卡片
     清成空态，用户感知「生成完视频卡片消失」）。标记 failed + 保留 taskId 可手动续查。 */
  if (!urls.length) {
    const raw = JSON.stringify(done.result || {}).slice(0, 200)
    update(node.id, {
      status: 'failed',
      error: `任务已完成但未提取到${kind === 'video' ? '视频' : '图片'}链接（响应结构与预期不符）。可点「查询任务状态」重试提取。原始响应：${raw}`,
      progress: 100
    })
    return { urls: [], cost: 0, empty: true }
  }
  const cost = done.credits_cost || 0
  /* S18 修复：产物先收进项目资产库（未命名项目进会话暂存目录，保存命名时自动并项），
     节点改引用本地资产文件——否则「项目资产」要等一次手动保存才看得到 */
  const localUrls = await api.adopt(urls, kind)
  const patch = {
    status: 'done', progress: 100, urls: localUrls,
    lastCost: cost, cost: cost ? `+${cost} 积分` : '',
    taskId: '', taskKind: '', submittedAt: 0, pendingPlace: place, error: '',
    /* P1：保留入库前的远端地址——网关产物本身就是公网 URL，可再作为动作控制的
       参考视频复用（本地 file:// 网关访问不到） */
    remoteUrls: urls
  }
  /* 画面比例为 Auto 时：出片后按产物真实宽高比重塑卡片（初始用默认比例显示，不压缩内容） */
  if (isAutoSize(node?.data?.size)) {
    const ar = await measureRatio(localUrls[0], kind)
    if (ar) { patch.ar = ar; patch.cardWidth = uploadedWidth(ar) }
  }
  settle(node, patch, update, onResult)
  if (onSpend) onSpend(cost)
  localUrls.forEach((u) => api.download(u, kind === 'video' ? 'videos' : 'images',
    filenameFromUrl(u, kind === 'video' ? '.mp4' : '.png')).catch(() => {}))
  return { urls: localUrls, cost }
}

/**
 * 运行流程（UI 手动「运行整图 / 从选中运行」与 Agent run_all 共用同一套调度）。
 *
 * @param onlyId           只跑单个节点
 * @param fromId           跑该节点及其全部下游
 * @param skipDone         Agent 批量执行时跳过已完成节点，避免重复扣费
 * @param continueOnError  单个失败不中断整批（UI 整图运行使用；Agent 保持快速失败）
 * @param regenerate       REF-006 再生成行为：'new'（默认，结果落新节点）| 'inplace'（原地覆盖）
 * @param onPlan           执行前回报本次要跑的节点 id 列表（用于进度分母）
 * @param onNodeEnd        (id, ok) 每个节点结束回调
 * @param onResult         (node, patch) => 'placed' | undefined，上层可接管落位
 * @param guard            S17-3 可选：({node,index,total}) => 'run' | 'stop'，节点边界处调用一次。
 *                         预算上限 / 用户接管都走这里——停止只发生在两个节点之间，
 *                         不会打断已经发出的请求；不传时行为与旧版完全一致。
 * @returns {Promise<{credits:number,total:number,ok:number,failed:number,failedIds:string[],okIds:string[],stopped?:boolean,stoppedIds?:string[]}>}
 */
export async function runFlow({
  nodes, edges, update, onSpend, onlyId, fromId, skipDone, continueOnError, onPlan, onNodeEnd, onResult, regenerate = 'new', guard
}) {
  const { order, incoming, refIncoming } = topoOrder(nodes, edges)
  // 结果种子：已完成的节点沿用现有 URL，供下游视频引用
  const results = new Map()
  for (const n of nodes) {
    if (n.data?.urls?.length) results.set(n.id, n.data.urls)
  }

  let targets
  if (onlyId) targets = order.filter((n) => n.id === onlyId)
  else if (fromId) {
    const set = downstreamOf(fromId, edges)
    targets = order.filter((n) => set.has(n.id))
  } else {
    targets = skipDone ? order.filter((n) => n.data?.status !== 'done') : order
  }

  if (onPlan) onPlan(targets.map((n) => n.id))

  let totalCredits = 0
  const okIds = []
  const failedIds = []
  const failedMark = new Map() // id → 失败原因（用于阻断下游）
  let stopped = false
  const stoppedIds = []
  let firstError = '' // S17-3：任务卡要显示真实失败原因，不能只写「全部节点失败」

  for (let ti = 0; ti < targets.length; ti++) {
    const node = targets[ti]
    /* S17-3：节点边界拦截（积分上限 / 接管）。放在节点开始前，
       已发出的请求不受影响，剩余节点原样保留——操作权交回用户。 */
    if (guard) {
      let verdict = 'run'
      try { verdict = await guard({ node, index: ti, total: targets.length }) } catch { verdict = 'run' }
      if (verdict === 'stop') {
        stopped = true
        for (const rest of targets.slice(ti)) stoppedIds.push(rest.id)
        break
      }
    }
    const d = node.data
    /* ---------- P3 成片合成节点：本地 FFmpeg 拼接 + 混音 + 烧字幕（零积分） ----------
       不选模型、不走网关。片段 = 上游视频节点产物（按画布 y 坐标排序）；
       配音 = 上游配音节点产物（第一个）；字幕文案 = 配音节点的台词。 */
    if (d.kind === 'compose') {
      const byIdC = new Map(nodes.map((x) => [x.id, x]))
      /* 用 refIncoming：上传素材卡不参与调度（不在 incoming 里），但同样是合法输入源 */
      const ins = (refIncoming.get(node.id) || []).map((sid) => byIdC.get(sid)).filter(Boolean)
      const vids = ins.filter((n) => n.data?.kind === 'video')
        .sort((a, b) => (a.position.y - b.position.y) || (a.position.x - b.position.x))
      const auds = ins.filter((n) => n.data?.kind === 'audio')
      const clipUrls = vids.flatMap((n) => results.get(n.id) || n.data?.urls || []).filter(Boolean)
      const voiceUrl = auds.map((n) => (results.get(n.id) || n.data?.urls || [])[0]).find(Boolean) || ''
      const script = auds.map((n) => n.data?.prompt || '').join(' ').replace(/\s+/g, ' ').trim()
      const failC = (msg) => {
        update(node.id, { status: 'failed', error: msg, progress: 0 })
        failedIds.push(node.id)
        failedMark.set(node.id, msg)
        if (!firstError) firstError = msg
        if (onNodeEnd) onNodeEnd(node.id, false)
      }
      if (!clipUrls.length) {
        const msg = '没有可合成的视频片段：请先把已生成的视频节点连到本节点左侧'
        failC(msg)
        if (!continueOnError) throw new Error(msg)
        continue
      }
      update(node.id, { status: 'running', progress: 5, error: '' })
      try {
        const r = await api.composeVideo({
          clips: clipUrls, voice: voiceUrl,
          opts: {
            size: d.size, keepOriginalSound: !!d.keepOriginalSound,
            loopAudio: !!d.loopAudio, subtitles: !!d.subtitles, script
          }
        }, (pct) => update(node.id, { progress: Math.max(5, Math.min(99, pct)) }))
        update(node.id, {
          status: 'done', progress: 100, urls: [r.url], seconds: r.seconds || 0,
          ...(r.width && r.height ? { ar: r.width / r.height } : {}),
          lastCost: 0, cost: '', taskId: '', taskKind: '', submittedAt: 0, pendingPlace: '', error: ''
        })
        api.download(r.url, 'videos', `compose-${Date.now()}.mp4`).catch(() => {})
        results.set(node.id, [r.url])
        okIds.push(node.id)
        if (onNodeEnd) onNodeEnd(node.id, true)
      } catch (err) {
        failC(String(err?.message || err))
        if (!continueOnError) throw err
      }
      continue
    }
    // 上游失败时不再浪费额度：直接标记并跳过
    const blocked = (incoming.get(node.id) || []).find((s) => failedMark.has(s))
    if (blocked) {
      const why = `上游节点失败，已跳过（${failedMark.get(blocked)}）`
      update(node.id, { status: 'failed', error: why, progress: 0 })
      failedIds.push(node.id)
      failedMark.set(node.id, why)
      if (onNodeEnd) onNodeEnd(node.id, false)
      continue
    }
    if (!d.model) {
      const err = new Error('有节点未选择模型，请点击节点在右侧面板选择')
      update(node.id, { status: 'failed', error: err.message })
      failedIds.push(node.id)
      failedMark.set(node.id, err.message)
      if (!firstError) firstError = err.message
      if (onNodeEnd) onNodeEnd(node.id, false)
      if (!continueOnError) throw err
      continue
    }
    /* ---------- P2 配音节点：文本 → TTS 语音 ----------
       同步返回音频（无任务可轮询），直接落项目资产。台词来源与图片卡一致：
       卡片内输入 + 连线上游提示词（去重合并）。 */
    if (d.kind === 'audio') {
      const script = mergePromptParts([d.prompt, ...collectText(node.id, nodes, edges)]).trim()
      if (!script) {
        const msg = '台词为空，请先在卡片里输入要配音的内容'
        update(node.id, { status: 'failed', error: msg, progress: 0 })
        failedIds.push(node.id)
        failedMark.set(node.id, msg)
        if (!firstError) firstError = msg
        if (onNodeEnd) onNodeEnd(node.id, false)
        if (!continueOnError) throw new Error(msg)
        continue
      }
      update(node.id, { status: 'running', progress: 30, error: '' })
      try {
        const creds = await credsFor('audio', d.model)
        const r = await api.submitAudio({
          model: d.model, input: script, voice: d.voice,
          speed: d.speed, format: d.format, ...creds
        })
        const urls = await api.adopt([r.dataUrl], 'audio')
        const seconds = await measureAudioSeconds(urls[0])
        update(node.id, {
          status: 'done', progress: 100, urls, seconds: seconds || 0,
          lastCost: 0, cost: '', taskId: '', taskKind: '', submittedAt: 0, error: ''
        })
        okIds.push(node.id)
        if (onNodeEnd) onNodeEnd(node.id, true)
      } catch (err) {
        const msg = String(err?.message || err)
        update(node.id, { status: 'failed', error: msg, progress: 0 })
        failedIds.push(node.id)
        failedMark.set(node.id, msg)
        if (!firstError) firstError = msg
        if (onNodeEnd) onNodeEnd(node.id, false)
        if (!continueOnError) throw err
      }
      continue
    }

    const kind = d.kind === 'video' ? 'video' : 'image'
    // REF-006：已有产物 + 新建节点策略 → 结果落新节点；否则原地覆盖
    const place = (regenerate === 'new' && (d.urls || []).length) ? 'new' : 'inplace'
    /* 单飞：该节点正在提交/轮询（连点、UI 与 Agent 交叠）→ 本次跳过，不重复建任务 */
    if (inflightNodes.has(node.id)) {
      const why = '该节点正在提交中，已跳过重复提交（一次操作只创建一个付费任务）'
      if (!continueOnError) throw new Error(why)
      continue
    }
    /* 已有远端任务（断线、重启、上次提交未回收）→ 续查结果，绝不重新提交。
       这是「切项目/重启后自动恢复」与「扣费但节点无产出」的主链路。 */
    if (d.taskId && ['queued', 'submitted', 'running'].includes(d.status)) {
      let resumedOk = false
      inflightNodes.add(node.id)
      try {
        const r = await resumeTask({ node, update, onSpend, onResult })
        resumedOk = !!r?.ok
        if (resumedOk) {
          results.set(node.id, r.urls || [])
          totalCredits += Number(r.credits) || 0
          okIds.push(node.id)
        } else {
          const why = r?.error || '续查失败'
          failedIds.push(node.id)
          failedMark.set(node.id, why)
          if (!firstError) firstError = why
        }
        if (onNodeEnd) onNodeEnd(node.id, resumedOk)
      } finally {
        inflightNodes.delete(node.id)
      }
      if (!resumedOk && !continueOnError) throw new Error(failedMark.get(node.id))
      continue
    }
    update(node.id, { status: 'queued', progress: 0, error: '', pendingPlace: place })
    inflightNodes.add(node.id)
    try {
      const creds = await credsFor(kind, d.model)
      update(node.id, { status: 'running' })
      // Q1-1：参考图带来源键（本地=local:<i>，上游=来源 nodeId，含上传素材卡）。
      // 顺序/去重/上限与旧版一致：本地参考在前、连线上游在后、按 url 去重保留首现、最多 4 张
      const byId = new Map(nodes.map((x) => [x.id, x]))
      const localEntries = (d.refImages || []).map((url, i) => ({ url, key: `local:${i}`, label: '本地上传' }))
      const upstreamEntries = (refIncoming.get(node.id) || []).flatMap((s) => {
        const src = byId.get(s)
        const isVid = src?.data?.kind === 'video'
        /* 视频卡片优先用公网地址：产物入库后只剩本地文件，入库前的远端 URL 仍在
           remoteUrls 里，可再当作参考视频喂给动作控制类模型 */
        const remote = isVid ? (src?.data?.remoteUrls || []).find((u) => /^https?:\/\//i.test(u)) : ''
        const list = remote ? [remote] : (results.get(s) || [])
        return list.map((url) => ({
          url, key: s, label: src?.data?.label || s, isVideo: isVid || isVideoUrl(url)
        }))
      })
      /* P1：参考视频与参考图分流。面板手填的公网直链优先级最高 */
      const videoEntries = [...upstreamEntries.filter((e) => e.isVideo)]
      if (d.refVideoUrl && /^https?:\/\//i.test(d.refVideoUrl)) {
        videoEntries.unshift({ url: d.refVideoUrl, key: 'panel', label: '面板填写' })
      }
      const videoUrls = [...new Set(videoEntries.map((e) => e.url).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 2)
      if (needsRefVideo(d.model) && !videoUrls.length && videoEntries.length) {
        throw new Error('本地视频不能直接作参考：网关只接受公网直链。请在右侧面板「参考视频」填入可公开访问的 mp4/mov 地址（3–10 秒）')
      }
      const imagePool = [...localEntries, ...upstreamEntries.filter((e) => !e.isVideo)]
      /* 1.2.0：Kling-v4 按模式定上限——首尾帧 2 张（超出本地拦截）、多图参考最多 10 张；
         其他模型维持 4 张（与面板参考栏口径一致）。 */
      const kling = isKlingV4(d.model)
      const kmode = klingModeOf(d)
      const refCap = kling ? (kmode === 'reference' ? 10 : 2) : 4
      const uniqEntries = []
      {
        const seenUrls = new Set()
        for (const ent of imagePool) {
          if (seenUrls.has(ent.url)) continue
          seenUrls.add(ent.url)
          uniqEntries.push(ent)
        }
      }
      if (kling && kmode === 'frames' && uniqEntries.length > 2) {
        throw new Error(`首尾帧模式最多 2 张参考图（当前 ${uniqEntries.length} 张，首帧+尾帧）。想用多张图请把节点模式切到「多图参考」，或断开多余的参考连线。`)
      }
      const refEntries = uniqEntries.slice(0, refCap)
      const refs = refEntries.map((r) => r.url)
      /* Kling-v4 用 @Image1 图序说明；其他模型保持原有「参考图N（角色）」措辞 */
      const audioUrls = kling && kmode === 'reference'
        ? [d.refAudioUrl, ...(Array.isArray(d.refAudioUrls) ? d.refAudioUrls : [])]
          .map((u) => String(u || '').trim())
          .filter((u) => /^https?:\/\//i.test(u))
        : []
      const roleBlock = kling
        ? mergePromptParts([
          rolePromptBlock(refEntries.map((e) => ({ role: (d.refRoles || {})[e.key] }))),
          audioPromptBlock(audioUrls.length)
        ])
        : refRoleBlock(d, refEntries)
      /* D-5：C-2 把上游提示词同步进了 d.prompt，而这里原本还会再拼一次上游文本，
         历史项目回填后同样会重复。按归一化内容去重（保序、保留首处写法）。 */
      const prompt = mergePromptParts([d.prompt, ...collectText(node.id, nodes, edges), roleBlock])
      /* 1.2.0：历史节点可能存着「该模型不支持的 4K」或比例型模型收到像素值，
         提交前按能力表再兜一次（面板已裁，这里是最后一道） */
      const imgParams = kind === 'image'
        ? sanitizeImageParams(d.model, { size: d.size, resolution: d.resolution }).params
        : null
      const sub = kind === 'image'
        ? await api.submitImage({
          model: d.model, prompt, size: imgParams.size, resolution: imgParams.resolution,
          n: d.n, imageUrls: refs, ...creds
        })
        : await api.submitVideo({
          model: d.model, prompt, size: d.size, duration: d.duration,
          resolution: d.resolution, audio: d.audio, imageUrls: refs,
          videoUrls, orientation: d.motionOrientation, mode: d.motionMode,
          keepOriginalSound: d.keepOriginalSound,
          klingMode: kmode, audioUrls, maxRefs: 10, ...creds
        })

      let urls
      if (sub.kind === 'sync') {
        urls = await api.adopt(sub.urls, kind) // S18 修复：即时入库（同上）
        const patch = {
          status: 'done', progress: 100, urls, lastCost: 0, cost: '',
          taskId: '', taskKind: '', submittedAt: 0, pendingPlace: place, error: ''
        }
        settle(node, patch, update, onResult)
        urls.forEach((u) => api.download(u, kind === 'video' ? 'videos' : 'images',
          filenameFromUrl(u, kind === 'video' ? '.mp4' : '.png')).catch(() => {}))
      } else {
        // REF-001：任务 ID + 发起时间落进节点数据，重启后可续查
        const startedAt = Date.now()
        update(node.id, { status: 'submitted', taskId: sub.id, taskKind: kind, submittedAt: startedAt })
        const r = await finishTask({
          node, taskId: sub.id, kind, creds, timeoutMs: GEN_TIMEOUT_MS[kind],
          update, onSpend, onResult, startedAt, place
        })
        if (r.empty) {
          // BUG-2：任务成功但产物提取为空——节点已被置 failed，按失败处理阻断下游
          failedIds.push(node.id)
          failedMark.set(node.id, '产物提取失败（响应结构异常）')
          if (onNodeEnd) onNodeEnd(node.id, false)
          continue
        }
        urls = r.urls
        totalCredits += r.cost
      }
      results.set(node.id, urls)
      okIds.push(node.id)
      if (onNodeEnd) onNodeEnd(node.id, true)
    } catch (err) {
      const msg = String(err?.message || err)
      /* 提交结果未知（1.2.0）：请求已发出但响应丢失/超时。保留底层原因与耗时，
         节点标记 unknownSubmit，卡片给「查询已有任务」而不是直接重试——
         服务端可能已经生成并扣费，盲目重试就是重复扣费。 */
      const unknown = !!(err?.unknownSubmit || /提交结果未知/.test(msg))
      update(node.id, {
        status: 'failed', error: msg,
        ...(unknown
          ? {
            unknownSubmit: true,
            submitDetail: err?.detail || '',
            submitElapsedMs: Number(err?.elapsedMs) || 0,
            submittedAt: Number(err?.submitStartedAt) || Date.now(),
            submitPossibleTaskId: err?.possibleTaskId || ''
          }
          : (err?.timeout ? {} : { taskId: '', taskKind: '', submittedAt: 0, pendingPlace: '' }))
      })
      failedIds.push(node.id)
      failedMark.set(node.id, msg)
      if (!firstError) firstError = msg
      if (onNodeEnd) onNodeEnd(node.id, false)
      if (!continueOnError) throw err
    } finally {
      inflightNodes.delete(node.id)
    }
  }

  return {
    credits: totalCredits,
    total: targets.length,
    ok: okIds.length,
    failed: failedIds.length,
    okIds,
    failedIds,
    ...(firstError ? { error: firstError } : {}),
    ...(stopped ? { stopped: true, stoppedIds } : {})
  }
}

/**
 * 恢复未完成的任务（REF-001）：应用启动/打开项目时对「生成中」且有 taskId 的节点续查。
 * 也用于节点的「查询任务状态」入口。
 */
export async function resumeTask({ node, update, onSpend, onResult }) {
  const d = node.data || {}
  if (!d.taskId) {
    update(node.id, { status: 'failed', error: '没有可查询的任务 ID，请重新生成' })
    return { ok: false, error: 'no task' }
  }
  const kind = d.taskKind === 'video' || d.kind === 'video' ? 'video' : 'image'
  const startedAt = d.submittedAt || Date.now()
  const timeoutMs = GEN_TIMEOUT_MS[kind]
  update(node.id, { status: 'submitted', error: '' })
  try {
    const creds = await credsFor(kind, d.model)
    const r = await finishTask({ node, taskId: d.taskId, kind, creds, timeoutMs, update, onSpend, onResult, startedAt })
    return { ok: true, urls: r.urls, credits: r.cost }
  } catch (err) {
    const msg = String(err?.message || err)
    update(node.id, {
      status: 'failed', error: msg,
      ...(err?.timeout ? {} : { taskId: '', taskKind: '', submittedAt: 0, pendingPlace: '' })
    })
    return { ok: false, error: msg }
  }
}

/** 找出需要续查的节点（生成中 + 有 taskId） */
export function pendingTasks(nodes) {
  return (nodes || []).filter((n) => n.data?.taskId && ['queued', 'submitted', 'running'].includes(n.data.status))
}

/**
 * 找回结果（1.2.0）：扣费但节点无产出 / 下载失败时的兜底入口。
 * - 有 taskId：重新查询远端任务，成功后重新入库（产物可能已生成，只是上次没取回）
 * - 无 taskId 但有 remoteUrls：直接按远端地址重新入库
 * 与 resumeTask 共用落位逻辑，不重新提交生成请求，不会二次扣费。
 */
export async function refetchResult({ node, update, onSpend, onResult }) {
  const d = node.data || {}
  if (d.taskId) return resumeTask({ node, update, onSpend, onResult })
  const kind = d.kind === 'video' ? 'video' : 'image'
  const remote = (d.remoteUrls || []).filter((u) => /^https?:\/\//i.test(u))
  if (!remote.length) {
    const msg = d.unknownSubmit
      ? '这次提交没有拿到任务 ID（响应在返回前断开）。请先到服务商网页核对是否已生成：有就下载后拖进画布，没有再重新生成。'
      : '没有可重新取回的结果（既无任务 ID，也无远端地址），请重新生成。'
    update(node.id, { status: 'failed', error: msg })
    return { ok: false, error: msg }
  }
  update(node.id, { status: 'submitted', error: '' })
  try {
    const localUrls = await api.adopt(remote, kind)
    const patch = {
      status: 'done', progress: 100, urls: localUrls,
      taskId: '', taskKind: '', submittedAt: 0, pendingPlace: '', error: '',
      unknownSubmit: false, submitDetail: '', submitElapsedMs: 0
    }
    settle(node, patch, update, onResult)
    localUrls.forEach((u) => api.download(u, kind === 'video' ? 'videos' : 'images',
      filenameFromUrl(u, kind === 'video' ? '.mp4' : '.png')).catch(() => {}))
    return { ok: true, urls: localUrls, credits: 0 }
  } catch (err) {
    const msg = String(err?.message || err)
    update(node.id, { status: 'failed', error: '重新取回失败：' + msg })
    return { ok: false, error: msg }
  }
}

/** 批量恢复：启动/打开项目时调用一次；串行避免同时打满网关 */
export async function resumePending({ nodes, update, onSpend, onResult }) {
  const list = pendingTasks(nodes)
  const out = []
  for (const n of list) out.push({ id: n.id, ...(await resumeTask({ node: n, update, onSpend, onResult })) })
  return out
}

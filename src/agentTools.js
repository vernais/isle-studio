/* Agent 工具清单（OpenAI function calling 格式）
   工具在渲染进程执行（App.jsx 里的 window.__flowAgent），主进程只负责把模型回复带回来 */

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_flow',
      description: '读取当前画布：所有节点的 id / 人话引用（图1、图2…视频1…）/ 类型 / 角色标注（主角、场景、产品、风格参考）/ 模型 / 参数 / 状态 / 提示词 / 是否已有产物，以及所有连线。任何操作前后都应调用它确认现状，不要凭空猜测节点。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_models',
      description: '列出用户已配置的图片模型和视频模型（含可用的画面比例与分辨率）。新建节点选模型前先调用它。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_node',
      description: '在画布上新增一个节点，返回新节点 id。image=图片生成，video=视频生成，text=提示词文本。可选同时写入提示词。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['image', 'video', 'text'], description: '节点类型' },
          prompt: { type: 'string', description: '提示词（图片/视频节点的 prompt，或文本节点的正文）' },
          x: { type: 'number', description: '画布 x 坐标，省略则自动摆放' },
          y: { type: 'number', description: '画布 y 坐标，省略则自动摆放' }
        },
        required: ['kind']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_params',
      description: '修改某个节点的参数。图片节点支持 prompt/model/size(画面比例)/resolution/n(出图数量)；视频节点支持 prompt/model/size/duration/resolution/audio；文本节点支持 text。只传要改的字段。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: "节点 id，也可填画布引用（图1、视频2，来自 read_flow 的 ref 字段）" },
          prompt: { type: 'string', description: '提示词' },
          text: { type: 'string', description: '文本节点正文' },
          model: { type: 'string', description: '模型 id，必须来自 list_models' },
          size: { type: 'string', description: '画面比例，如 1:1 / 16:9 / 9:16 / Auto' },
          resolution: { type: 'string', description: '分辨率，图片如 1K/2K/4K；视频如 480p/720p/1080p/4k' },
          duration: { type: 'number', description: '视频时长（秒）' },
          n: { type: 'number', description: '出图数量' },
          audio: { type: 'boolean', description: '视频是否带声音' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'connect_nodes',
      description: '把上游节点的输出连到下游节点的输入（source 的输出挂点 → target 的输入挂点）。连线后上游的图片会自动成为下游的参考图，上游文本节点的提示词会自动拼接进下游提示词。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: "上游节点 id 或画布引用（图1）" },
          target: { type: 'string', description: "下游节点 id 或画布引用（图2）" }
        },
        required: ['source', 'target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_node',
      description: '删除节点及其所有连线。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '节点 id' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_node',
      description: '真实执行某个节点的生成，会消耗用户积分并等待结果返回（耗时可能 30 秒到数分钟）。返回状态与结果 URL。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: "要运行的节点 id，也可填画布引用（图1、视频2）" } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_all',
      description: '按依赖顺序执行整张画布的所有生成节点，消耗积分并等待全部完成。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
]

export const AGENT_SYSTEM_PROMPT = `你是 Isle，Isle Studio 的创作助理，直接操作这个节点式画布（不是只给建议）。
画布规则：
- 节点三类：image（图片生成）、video（视频生成）、text（提示词文本）。
- 图片节点参数：model、prompt、size（画面比例，如 1:1 / 16:9 / 9:16 / Auto）、resolution（1K/2K/4K）、n（数量）。
- 视频节点参数：model、prompt、size、resolution（480p/720p/1080p/4k）、duration（秒）、audio。
- 连线 source→target：上游图片自动成为下游参考图；上游文本自动拼进下游提示词。

画布引用（重要）：
- read_flow 会给每个图片/视频节点一个引用名（图1、图2…视频1…）和角色标注（主角/场景/产品/风格参考）。
- 用户说「画布里的第 2 张图」「那张人物图」「刚才的场景图」「用我画布里的人物」时，先 read_flow，
  根据每张图的引用、角色标注、提示词和已有产物判断用户指的是哪张，直接用它的引用名操作。
- 绝对不要让用户提供「卡片 id」——用户看不到 id，id 是系统内部的。你只管用引用名和提示词自己判断。
- 拿不准是哪张时，把候选列出来问用户（用描述，例如「是穿红裙的那张，还是街景那张？」），不要问 id。

工作方式：
1. 先 read_flow 看现状；需要选模型时先 list_models，模型 id 必须来自该结果，禁止臆造。
2. 用 add_node / set_params / connect_nodes 完成搭建，再用 run_node / run_all 真正出图或出视频。
3. 涉及生成/扣积分的动作（run_node / run_all）必须先经用户审批确认（界面上会出现审批卡），未经确认不得自行重试生成；但不要重复执行已经完成的节点。
4. 新节点默认放在现有节点右侧（x 加 420）或下方（y 加 460），不要重叠。
5. 每步操作后简述你做了什么；全部完成后用简洁中文汇报：建了什么、用了什么模型/参数、结果在哪几个节点、消耗多少积分。
6. 如果工具返回 ok:false，先自行读懂 error 修正后重试一次；过程调整不需要向用户汇报。仍失败时告诉用户结果和接下来可以怎么办，用创作伙伴的口吻，不要照搬报错原文或技术栈细节。

先沟通、后动手（重要）：
- 用户在提问、讨论、征求意见时（例如「需要加什么提示词？」「这样可行吗？」「为什么…」），用文字直接回答，不要动画布、不要调用任何工具、不要发起执行计划。你可以引用画布现状（先 read_flow）来回答。
- 只有用户明确要求搭建/修改/运行（「帮我搭建」「生成」「运行」「加上」「删掉」「改成」）时才操作画布。
- 拿不准是讨论还是执行时：先用文字回答问题，最后问一句「需要我直接改到画布上吗？」，等确认再动手。
- 严禁把「回答问题」变成「按你的理解直接建节点/跑生成」。

说话方式（重要）：
- 你在直接面对创作者对话，不是在写开发日志。禁止出现「无法调用」「改用」「回退」「fallback」「HTTP/接口/协议/参数不支持」这类后台技术叙述。
- 遇到限制或失败，翻译成创作语言，例如：「这个模型暂时出不了这种比例，我换了个效果接近的模型」或「这条生成没有成功，积分没有扣，我们可以换个说法再试一次」。
- 中间的尝试、切换、重试只体现在操作步骤里（界面会显示简短进度行），最终回复只说结论和结果位置。

回答用简体中文，简洁、直接、不寒暄。所有输出一律纯文本，禁止 Markdown 符号（**、#、*、\`）——气泡与提示词都不渲染 Markdown。`

/* ---------- JSON 协议（给不支持 function calling 的网关/模型用） ---------- */
export const AGENT_JSON_PROMPT = `${AGENT_SYSTEM_PROMPT}

【重要】你所在的环境不能调用函数，改用 JSON 协议执行动作：
- 每轮只输出一个 JSON 对象，不要加解释、不要加代码块标记。
- 需要操作画布时输出：{"tool":"工具名","args":{...}}
  可用工具名与参数：
  read_flow {} ; list_models {}
  add_node {"kind":"image|video|text","prompt":"...","x":可选,"y":可选}
  set_params {"id":"图1","prompt":"...","model":"...","size":"16:9","resolution":"2K","n":1,"duration":5,"audio":true}
  connect_nodes {"source":"n_1","target":"n_2"}
  delete_node {"id":"n_1"}
  run_node {"id":"n_1"}   run_all {}
- 每次只输出一个动作。系统会回复「工具结果：{...}」，你据此继续下一个动作。
- 全部完成、或不需要再操作时输出：{"final":"给用户的中文总结"}
- id 可以填节点 id，也可以填画布引用（图1、视频2，来自 read_flow 的 ref 字段）。
- 绝不能凭空编造节点 id；不确定就先 read_flow。`

/* 从模型输出中抽出第一个完整 JSON 对象（容忍 ```json 包裹与前后废话） */
export function parseAgentAction(text) {
  if (!text) return null
  const s = String(text).replace(/```json|```/g, '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

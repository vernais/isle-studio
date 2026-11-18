const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flow', {
  platform: process.platform,
  appVersion: () => ipcRenderer.invoke('app:version'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickOutputDir: () => ipcRenderer.invoke('pick-output-dir'),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openOutputs: () => ipcRenderer.invoke('open-outputs'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  /* 数据位置（Data Home）：查询 / 选目录 / 整体搬家 */
  dataHomeInfo: () => ipcRenderer.invoke('datahome:info'),
  dataHomePick: () => ipcRenderer.invoke('datahome:pick'),
  dataHomeRelocate: (target) => ipcRenderer.invoke('datahome:relocate', target),
  thumbPut: (args) => ipcRenderer.invoke('thumb:put', args),
  request: (args) => ipcRenderer.invoke('apimart', args),
  /* P1：参考素材公网化（本地图片 → 网关可访问 URL） */
  mediaUpload: (args) => ipcRenderer.invoke('media:upload', args),
  /* P2 配音：TTS 返回二进制音频，主进程转 dataURL 回传 */
  audioSpeech: (args) => ipcRenderer.invoke('audio:speech', args),
  /* P3 成片合成：FFmpeg 本地拼接视频 + 混音 + 烧字幕 */
  composeVideo: (args) => ipcRenderer.invoke('video:compose', args),
  onComposeProgress: (cb) => {
    const h = (_e, d) => cb(d)
    ipcRenderer.on('compose:progress', h)
    return () => ipcRenderer.removeListener('compose:progress', h)
  },
  testConnection: (args) => ipcRenderer.invoke('apimart:test', args),
  download: (args) => ipcRenderer.invoke('download', args),
  saveAs: (args) => ipcRenderer.invoke('save-as', args),
  projectSave: (args) => ipcRenderer.invoke('project:save', args),
  projectList: () => ipcRenderer.invoke('project:list'),
  projectLoad: (args) => ipcRenderer.invoke('project:load', args),
  projectPin: (args) => ipcRenderer.invoke('project:pin', args),
  projectRename: (args) => ipcRenderer.invoke('project:rename', args),
  projectDelete: (args) => ipcRenderer.invoke('project:delete', args),
  projectOpenWindow: (args) => ipcRenderer.invoke('project:open-window', args),
  templateCreate: (args) => ipcRenderer.invoke('template:create', args),
  templateList: () => ipcRenderer.invoke('template:list'),
  templateLoad: (args) => ipcRenderer.invoke('template:load', args),
  templateRename: (args) => ipcRenderer.invoke('template:rename', args),
  templateDelete: (args) => ipcRenderer.invoke('template:delete', args),
  modelsSync: (args) => ipcRenderer.invoke('models:sync', args),
  winMin: () => ipcRenderer.invoke('window:minimize'),
  winMax: () => ipcRenderer.invoke('window:maximize'),
  winClose: () => ipcRenderer.invoke('window:close'),
  agentChat: (args) => ipcRenderer.invoke('agent:chat', args),
  agentStep: (args) => ipcRenderer.invoke('agent:step', args),
  /* S17-0b 任务中心：跨视图共享的任务记录（userData/tasks.json） */
  tasksHello: (args) => ipcRenderer.invoke('tasks:hello', args),
  tasksRead: (args) => ipcRenderer.invoke('tasks:read', args),
  tasksMerge: (args) => ipcRenderer.invoke('tasks:merge', args),
  onTasksChanged: (cb) => ipcRenderer.on('tasks:changed', (e, d) => cb(d)),
  /* S19 自动保存草稿（userData/drafts/，与 projects 彻底隔离） */
  draftSave: (args) => ipcRenderer.invoke('draft:save', args),
  draftLoad: () => ipcRenderer.invoke('draft:load'),
  draftClear: () => ipcRenderer.invoke('draft:clear'),
  draftPending: () => ipcRenderer.invoke('draft:pending'),
  /* S20 Isle 会话持久化 + 项目记忆（userData/sessions/） */
  sessionLoad: (args) => ipcRenderer.invoke('session:load', args),
  sessionSave: (args) => ipcRenderer.invoke('session:save', args),
  memoryLoad: (args) => ipcRenderer.invoke('memory:load', args),
  memorySave: (args) => ipcRenderer.invoke('memory:save', args),
  memoryDelete: (args) => ipcRenderer.invoke('memory:delete', args),
  memoryClear: (args) => ipcRenderer.invoke('memory:clear', args),
  /* S21 设置页「数据」区：存储占用 / 缩略图清理 / 配置导入导出 */
  storageUsage: () => ipcRenderer.invoke('storage:usage'),
  storageClearThumbs: () => ipcRenderer.invoke('storage:clear-thumbs'),
  configExportFile: (args) => ipcRenderer.invoke('config:export-file', args),
  configImportFile: (args) => ipcRenderer.invoke('config:import-file', args),
  /* S18 项目资产面板：清单扫描 / 插入画布（跨项先复制）/ 删除（引用扫描+二次确认） */
  assetsScan: () => ipcRenderer.invoke('assets:scan'),
  assetAdopt: (args) => ipcRenderer.invoke('assets:adopt', args),
  assetsInsert: (args) => ipcRenderer.invoke('assets:insert', args),
  assetsDelete: (args) => ipcRenderer.invoke('assets:delete', args),
  onAgentChunk: (cb) => ipcRenderer.on('agent:chunk', (e, d) => cb(d)),
  onAgentDone: (cb) => ipcRenderer.on('agent:done', () => cb()),
  onAgentError: (cb) => ipcRenderer.on('agent:error', (e, d) => cb(d)),
  /* 阶段0修复④：关闭确认链路。主进程拦截 close → 通知渲染端询问未保存状态 → 渲染端决定放行 */
  onCloseRequest: (cb) => ipcRenderer.on('app:close-request', () => cb()),
  confirmClose: () => ipcRenderer.send('app:close-confirm')
})

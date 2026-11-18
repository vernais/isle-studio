import {
  ReactFlow, Background, ViewportPortal
} from '@xyflow/react'
import { IcPlus } from '../icons.jsx'
import { nodeTypes, edgeTypes } from '../nodes.jsx'
import ProjectBar from './ProjectBar.jsx'
import CanvasHud from './CanvasHud.jsx'

/* 画布主体（S17-0a 拆分）：从 App.jsx 原样搬出，DOM/类名零改动。
   只承载画布渲染与交互回调，状态与实现全部由 App 传入。 */
export default function StudioCanvas({
  mode, dragOver, spacePan, connFrom,
  uploadMedia, createMediaNode, setDragOver,
  nodes, edges, flowNodes,
  onNodesChange, onEdgesChange,
  onConnect, onConnectStart, onConnectEnd, isValidConnection,
  onNodeClick, openNodeMenu, onPaneClick, onPaneContextMenu,
  onNodeDrag, onNodeDragStop,
  snapLines, minimapOpen, onToggleMinimap,
  edgeColor,
  projectBar
}) {
  const {
    onTemplates, name, dirty, open, projects, onToggle,
    onLoad, onNew, onSave, onOrganize, onDownloadAll, onRename, assets
  } = projectBar
  return (
    <div
      className={'canvas-wrap mode-' + mode + (dragOver ? ' file-drag' : '') + (spacePan ? ' space-pan' : '')
        + (connFrom ? ' conn-active ' + (connFrom.kind === 'text' ? 'conn-from-text' : 'conn-from-media') : '')}
      onDoubleClick={(e) => {          // 空白处双击 → 直接弹上传窗口，卡片落在光标处
        if (!e.target.closest('.react-flow__pane')) return
        if (e.target.closest('.react-flow__node') || e.target.closest('.react-flow__minimap')) return
        uploadMedia({ drop: { x: e.clientX, y: e.clientY } })
      }}
      onDragOver={(e) => {
        // 允许从资源管理器拖入文件；浮在节点上时不接管
        if (e.target.closest('.react-flow__node') || e.target.closest('.react-flow__minimap')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDragOver(false)
      }}
      onDrop={async (e) => {
        // 从资源管理器拖入图片/视频 → 直接落卡片
        setDragOver(false)
        if (e.target.closest('.react-flow__node') || e.target.closest('.react-flow__minimap')) return
        const files = [...(e.dataTransfer?.files || [])].filter((f) =>
          f.type.startsWith('image/') || f.type.startsWith('video/'))
        if (!files.length) return
        e.preventDefault()
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          const kind = f.type.startsWith('video/') ? 'video' : 'image'
          const dataUrl = await new Promise((res) => {
            const r = new FileReader()
            r.onload = () => res(r.result)
            r.onerror = () => res(null)
            r.readAsDataURL(f)
          })
          if (!dataUrl) continue
          await createMediaNode({
            kind, dataUrl,
            drop: { x: e.clientX + (files.length > 1 ? i * 30 : 0), y: e.clientY + (files.length > 1 ? i * 24 : 0) }
          })
        }
      }}
    >
      {/* UI-028：画布空态引导（只引用 SHORTCUT_GROUPS 里真实存在的键位） */}
      {!nodes.length && (
        <div className="canvas-empty" role="status">
          <span className="canvas-empty-ico"><IcPlus size={22} /></span>
          <p>
            从左上角 <b>+</b> 添加节点&emsp;·&emsp;<b>Ctrl + /</b> 打开 Agent&emsp;·&emsp;<b>Ctrl + 0</b> 适应画布
          </p>
        </div>
      )}
      <ProjectBar
        onTemplates={onTemplates}
        name={name}
        dirty={dirty}
        open={open}
        projects={projects}
        onToggle={onToggle}
        onLoad={onLoad}
        onNew={onNew}
        onSave={onSave}
        onOrganize={onOrganize}
        onDownloadAll={onDownloadAll}
        onRename={onRename}
        assets={assets}
      />
      <ReactFlow
        nodes={flowNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        isValidConnection={isValidConnection}
        defaultEdgeOptions={{ type: 'flow', animated: true, style: { stroke: edgeColor } }}
        /* 面板互斥「最近操作优先」（S11 / IR-003）：Agent 开着时点击可编辑节点
           （非 text、非 uploaded）→ Agent 自动收起，参数面板立即接管（同一事件批处理，无闪烁）；
           点击 text / uploaded 节点或空白画布 → Agent 保持打开，不误伤会话 */
        onNodeClick={onNodeClick}
        onNodeContextMenu={openNodeMenu}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        zoomOnDoubleClick={false}
        minZoom={0.1} /* 竞品对齐：ComfyUI 10% / n8n 无限缩小，50% 下限看不到大画布全局 */
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        selectionOnDrag={mode === 'select' && !spacePan}
        panOnDrag={mode === 'hand' || spacePan}
        edgesFocusable={false}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.18 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#dde1e8" gap={22} />
        <ViewportPortal>
          {snapLines.map((l, i) => (l.orient === 'v'
            ? <div key={i} className="snap-line v" style={{ left: l.pos, top: -50000, height: 100000 }} />
            : <div key={i} className="snap-line h" style={{ top: l.pos, left: -50000, width: 100000 }} />))}
        </ViewportPortal>
        <CanvasHud minimapOpen={minimapOpen} onToggleMinimap={onToggleMinimap} />
      </ReactFlow>
    </div>
  )
}

/* 快捷键说明数据（UI-007 B-3）：ShortcutsModal 与画布空态引导共用同一份键位表 */
export const SHORTCUT_GROUPS = [
  {
    g: '节点',
    items: [
      ['Del / Backspace', '删除选中节点'],
      ['Ctrl + D', '复制节点'],
      ['Ctrl + A', '全选节点'],
      ['↑ ↓ ← →', '微调节点位置（Shift 加速 10px）']
    ]
  },
  {
    g: '编辑',
    items: [
      ['Ctrl + Z', '撤销'],
      ['Ctrl + Shift + Z', '重做'],
      ['Ctrl + S', '保存项目']
    ]
  },
  {
    g: '画布',
    items: [
      ['空格 + 拖拽', '平移画布'],
      ['Ctrl + 滚轮', '缩放画布'],
      ['Ctrl + 0', '适应画布（fitView）']
    ]
  },
  {
    g: '运行 / 界面',
    items: [
      ['Ctrl + Enter', '运行整图'],
      ['Ctrl + Shift + Enter', '从选中节点运行'],
      ['Esc', '关闭当前浮层'],
      ['Ctrl + /', '打开 / 收起 Isle']
    ]
  }
]

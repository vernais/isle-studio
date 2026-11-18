/* 节点 id 序号：模块级单例，App 与各类动作共用同一计数器 */
let idSeq = 1

export const nextId = () => `n_${idSeq++}`

/* 载入项目后抬高 id 序号，避免新节点 id 与画布已有节点冲突 */
export const bumpIdSeq = (list) => {
  for (const n of list || []) {
    const m = /^n_(\d+)$/.exec(n.id)
    if (m) idSeq = Math.max(idSeq, Number(m[1]) + 1)
  }
}

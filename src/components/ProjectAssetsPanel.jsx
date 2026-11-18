import React, { useEffect, useMemo, useState, useCallback } from 'react'
import Lightbox from 'yet-another-react-lightbox'
import { Zoom, Video, Thumbnails, Download, Captions } from 'yet-another-react-lightbox/plugins'
import 'yet-another-react-lightbox/styles.css'
import 'yet-another-react-lightbox/plugins/thumbnails.css'
import 'yet-another-react-lightbox/plugins/captions.css'
import { IcImage, IcAudio } from '../icons.jsx'

/* S18 项目资产面板：画布左上「项目资产」下拉的下半区。
   资产网格（类型×项目双维筛选）+ YARL 预览（缩放/视频播放/缩略条/下载/标注）+
   插入画布（跨项复制由主进程 assets:insert 处理）+ 删除（被引用二次确认）。 */

const fmtSize = (n) => (!n ? '0 B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB')
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function ProjectAssetsPanel({ currentProject, onInsert, onDelete, onToast }) {
  const [items, setItems] = useState(null) // null = 加载中
  const [failed, setFailed] = useState(false)
  const [typeF, setTypeF] = useState('all') // all | image | video
  const [projF, setProjF] = useState('__current__') // __all__ | __current__ | key
  const [preview, setPreview] = useState(-1) // lightbox 打开时的 filtered 下标
  const [confirmDel, setConfirmDel] = useState(null) // 被引用资产的删除确认条目

  const load = useCallback((isRetry = false) => {
    window.flow.assetsScan?.().then((r) => {
      if (r?.ok) { setItems(r.items || []); setFailed(false) }
      else if (!isRetry) setTimeout(() => load(true), 600) // S18-6：静默重试一次
      else setFailed(true)
    }).catch(() => {
      if (!isRetry) setTimeout(() => load(true), 600)
      else setFailed(true)
    })
  }, [])
  useEffect(() => { load() }, [load])
  /* 生成产物即时入库后（api.adopt 广播）自动刷新，面板开着也能立刻看到新资产 */
  useEffect(() => {
    const onChanged = () => load(true)
    window.addEventListener('isle:assets-changed', onChanged)
    return () => window.removeEventListener('isle:assets-changed', onChanged)
  }, [load])

  const projOptions = useMemo(() => {
    const map = new Map()
    for (const it of items || []) if (!map.has(it.key)) map.set(it.key, it.proj)
    return [...map.entries()] // [key, disp]
  }, [items])

  const filtered = useMemo(() => {
    if (!items) return []
    return items.filter((it) => {
      if (typeF !== 'all' && it.type !== typeF) return false
      if (projF === '__all__') return true
      /* B-8：未命名（未保存）项目没有自己的资产目录——「当前项目」下应显示为空，
         而不是回退成全部项目（否则新画布里会看到其他项目的资产） */
      if (projF === '__current__') return currentProject ? it.proj === currentProject : false
      return it.key === projF
    })
  }, [items, typeF, projF, currentProject])

  const doDelete = async (item) => {
    const force = confirmDel === item // 同一资产第二次点删除 = 确认
    try {
      const r = await onDelete(item, force)
      if (r?.ok) {
        setConfirmDel(null)
        onToast?.('已删除资产' + (r.cleared ? `（置空 ${r.cleared} 处引用）` : ''))
        load(true)
      } else if (r?.referenced) {
        setConfirmDel(item)
        onToast?.(`该资产被「${(r.refs || []).join('、')}」引用，再次点删除确认`)
      } else {
        setConfirmDel(null)
        onToast?.('删除失败：' + (r?.error || '未知错误'))
      }
    } catch (e) { onToast?.('删除失败：' + (e?.message || e)) }
  }

  const slides = useMemo(() => filtered.map((it) => (it.type === 'video'
    ? { type: 'video', src: it.url, sources: [{ src: it.url, type: 'video/mp4' }], width: 1280, height: 720, title: it.name, description: `${it.proj} · ${fmtTime(it.mtime)}`, assetItem: it }
    : { src: it.url, thumbSrc: it.thumb, width: 1024, height: 1024, title: it.name, description: `${it.proj} · ${fmtTime(it.mtime)}`, assetItem: it }
  )), [filtered])

  if (failed) return null // S18-6：降级为仅项目列表区可用

  return (
    <div className="passets">
      <div className="passets-head">
        <span className="passets-title">项目资产{items ? <i className="passets-count">{filtered.length}</i> : null}</span>
        <div className="passets-filters">
          <select value={typeF} onChange={(e) => setTypeF(e.target.value)} aria-label="按类型筛选">
            <option value="all">全部类型</option>
            <option value="image">图片</option>
            <option value="video">视频</option>
            <option value="audio">音频</option>
          </select>
          <select value={projF} onChange={(e) => setProjF(e.target.value)} aria-label="按项目筛选">
            <option value="__current__">当前项目</option>
            <option value="__all__">全部项目</option>
            {projOptions.map(([k, d]) => <option key={k} value={k}>{d}</option>)}
          </select>
        </div>
      </div>
      {!items && <div className="passets-loading">扫描资产中…</div>}
      {items && !filtered.length && (
        <div className="passets-empty">
          <span className="passets-empty-ico"><IcImage size={22} /></span>
          <p>{items.length ? '当前筛选下没有资产' : <>全库还没有资产<br />生成图片/视频后自动汇集到这里</>}</p>
        </div>
      )}
      {!!filtered.length && (
        <div className="passets-scroll">
          <div className="passets-grid">
            {filtered.map((it, idx) => (
              <div className="passet-cell" key={it.url + idx}>
                {it.type === 'audio' ? (
                  /* P2：音频资产没有缩略图，用波形图标占位（点击交给系统播放器） */
                  <span className="passet-audio-ico"><IcAudio size={26} /></span>
                ) : (
                  <img
                    src={it.thumb || it.url}
                    alt={it.name}
                    loading="lazy"
                    decoding="async"
                    onError={(e) => { if (e.currentTarget.src !== it.url) e.currentTarget.src = it.url }}
                  />
                )}
                <div className="passet-ov" onClick={(e) => {
                  e.stopPropagation()
                  if (it.type === 'audio') {
                    window.flow.openPath(decodeURIComponent(it.url.slice('file:///'.length)))
                    return
                  }
                  setPreview(idx)
                }}>
                  <span className={'passet-badge' + (it.type === 'video' ? ' v' : '') + (it.type === 'audio' ? ' a' : '')}>
                    {it.type === 'video' ? '视频' : it.type === 'audio' ? '音频' : '图'}
                  </span>
                  <span className="passet-name" title={`${it.proj} · ${it.name} · ${fmtSize(it.size)}`}>{it.name}</span>
                  <div className="passet-bar">
                    <button className="passet-btn" title="插入到当前画布（其他项目的资产会先复制到当前项目）" onClick={(e) => { e.stopPropagation(); onInsert?.(it) }}>
                      插入
                    </button>
                    <button
                      className={'passet-btn danger' + (confirmDel === it ? ' sure' : '')}
                      title={confirmDel === it ? '再次点击确认删除' : '删除资产'}
                      onClick={(e) => { e.stopPropagation(); doDelete(it) }}
                    >{confirmDel === it ? '确认删除' : '删除'}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {preview >= 0 && slides[preview] && (
        <Lightbox
          open
          index={preview}
          close={() => setPreview(-1)}
          slides={slides}
          plugins={[Zoom, Video, Thumbnails, Download, Captions]}
          video={{ controls: true, autoPlay: true }}
          download={({ slide }) => {
            const it = slide.assetItem
            if (!it) return
            window.flow.download({ url: it.url, subdir: it.type === 'video' ? 'videos' : 'images', filename: it.name })
              .then((f) => onToast?.('已另存：' + f))
              .catch((e) => onToast?.('另存失败：' + (e?.message || e)))
          }}
          carousel={{ finite: filtered.length <= 1 }}
        />
      )}
    </div>
  )
}

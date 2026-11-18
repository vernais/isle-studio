/* 统一图标层：Tabler Icons（MIT）outline · 24 网格 · 1.75 线宽 · currentColor
   全部内联 SVG 路径，零运行时依赖；任何地方需要图标都从这里取，禁止用 emoji 或字符当图标 */
const mk = (paths) => function Icon({ size = 16, strokeWidth = 1.75, ...rest }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" {...rest}
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
}

export const IcBolt = mk(['M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11'])
export const IcSettings = mk(['M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065', 'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0'])
export const IcClose = mk(['M18 6l-12 12', 'M6 6l12 12'])
export const IcPlus = mk(['M12 5l0 14', 'M5 12l14 0'])
export const IcMinus = mk(['M5 12l14 0'])
export const IcSend = mk(['M12 5l0 14', 'M18 11l-6 -6', 'M6 11l6 -6'])
export const IcCaret = mk(['M6 9l6 6l6 -6'])
export const IcCaretUp = mk(['M6 15l6 -6l6 6'])
export const IcArrowRight = mk(['M9 6l6 6l-6 6'])
export const IcCopy = mk(['M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666', 'M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1'])
export const IcTrash = mk(['M4 7l16 0', 'M10 11l0 6', 'M14 11l0 6', 'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12', 'M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3'])
export const IcText = mk(['M3 7v-2h13v2', 'M10 5v14', 'M12 19h-4', 'M15 13v-1h6v1', 'M18 12v7', 'M17 19h2'])
export const IcImage = mk(['M15 8h.01', 'M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12', 'M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5', 'M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3'])
export const IcVideo = mk(['M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12', 'M8 4l0 16', 'M16 4l0 16', 'M4 8l4 0', 'M4 16l4 0', 'M4 12l16 0', 'M16 8l4 0', 'M16 16l4 0'])
export const IcAudio = mk(['M21 12h-2c-.894 0 -1.662 -.857 -1.761 -2c-.296 -3.45 -.749 -6 -2.749 -6s-2.5 3.582 -2.5 8s-.5 8 -2.5 8s-2.452 -2.547 -2.749 -6c-.1 -1.147 -.867 -2 -1.763 -2h-2'])
export const IcUpload = mk(['M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2', 'M7 9l5 -5l5 5', 'M12 4l0 12'])
export const IcSelect = mk(['M7.904 17.563a1.2 1.2 0 0 0 2.228 .308l2.09 -3.093l4.907 4.907a1.067 1.067 0 0 0 1.509 0l1.047 -1.047a1.067 1.067 0 0 0 0 -1.509l-4.907 -4.907l3.113 -2.09a1.2 1.2 0 0 0 -.309 -2.228l-13.582 -3.904l3.904 13.563'])
export const IcHand = mk(['M8 13v-7.5a1.5 1.5 0 0 1 3 0v6.5', 'M11 5.5v-2a1.5 1.5 0 1 1 3 0v8.5', 'M14 5.5a1.5 1.5 0 0 1 3 0v6.5', 'M17 7.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47'])
export const IcFit = mk(['M16 4l4 0l0 4', 'M14 10l6 -6', 'M8 20l-4 0l0 -4', 'M4 20l6 -6', 'M16 20l4 0l0 -4', 'M14 14l6 6', 'M8 4l-4 0l0 4', 'M4 4l6 6'])
export const IcMap = mk(['M3 7l6 -3l6 3l6 -3v13l-6 3l-6 -3l-6 3v-13', 'M9 4v13', 'M15 7v13'])
export const IcSparkle = mk(['M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6'])
export const IcSliders = mk(['M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 6l8 0', 'M16 6l4 0', 'M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 12l2 0', 'M10 12l10 0', 'M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 18l11 0', 'M19 18l1 0'])
export const IcDownload = mk(['M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2', 'M7 11l5 5l5 -5', 'M12 4l0 12'])
export const IcAlert = mk(['M12 9v4', 'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0', 'M12 16h.01'])
export const IcLock = mk(['M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6', 'M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0', 'M8 11v-4a4 4 0 1 1 8 0v4'])
export const IcUnlock = mk(['M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -6', 'M11 16a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M8 11v-5a4 4 0 0 1 8 0'])
export const IcFolder = mk(['M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2'])
export const IcSave = mk(['M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2', 'M10 14a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M14 4l0 4l-6 0l0 -4'])
export const IcOrganize = mk(['M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4', 'M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4', 'M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4', 'M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4'])
export const IcBack = mk(['M5 12l14 0', 'M5 12l6 6', 'M5 12l6 -6'])
export const IcPin = mk(['M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4', 'M9 15l-4.5 4.5', 'M14.5 4l5.5 5.5'])
export const IcPencil = mk(['M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4', 'M13.5 6.5l4 4'])
export const IcExternal = mk(['M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6', 'M11 13l9 -9', 'M15 4h5v5'])
export const IcMore = mk(['M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'])
export const IcRefresh = mk(['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'])
export const IcCheck = mk(['M5 12l5 5l10 -10'])
export const IcSearch = mk(['M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M21 21l-6 -6'])
export const IcMax = mk(['M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14'])
export const IcPalette = mk(['M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25', 'M7.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M11.5 7.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M15.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'])
export const IcKeyboard = mk(['M2 8a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2l0 -8', 'M6 10l0 .01', 'M10 10l0 .01', 'M14 10l0 .01', 'M18 10l0 .01', 'M6 14l0 .01', 'M18 14l0 .01', 'M10 14l4 .01'])
export const IcPlay = mk(['M7 4v16l13 -8l-13 -8'])
export const IcMenuText = mk(['M19 10h-14', 'M5 6h14', 'M14 14h-9', 'M5 18h6', 'M18 15v6', 'M15 18h6'])
export const IcMenuImage = mk(['M15 8h.01', 'M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5', 'M3 16l5 -5c.928 -.893 2.072 -.893 3 0l4 4', 'M14 14l1 -1c.67 -.644 1.45 -.824 2.182 -.54', 'M16 19h6', 'M19 16v6'])
export const IcMenuVideo = mk(['M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4', 'M3 8a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -8', 'M7 12l4 0', 'M9 10l0 4'])
export const IcMenuAudio = mk(['M3 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0', 'M9 17v-13h10v8', 'M9 8h10', 'M16 19h6', 'M19 16v6'])
export const IcMenuCompose = mk(['M12 4l-8 4l8 4l8 -4l-8 -4', 'M4 12l8 4l8 -4', 'M4 16l8 4l8 -4'])
export const IcMenuUpload = mk(['M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2', 'M7 9l5 -5l5 5', 'M12 4l0 12'])
export const IcComposeGlyph = mk(['M12 4l-8 4l8 4l8 -4l-8 -4', 'M4 12l8 4l8 -4', 'M4 16l8 4l8 -4'])

/* ---------- 菜单族聚合 ---------- */
export const IcMenu = {
  text: IcMenuText,
  image: IcMenuImage,
  video: IcMenuVideo,
  audio: IcMenuAudio,
  compose: IcMenuCompose,
  upload: IcMenuUpload
}

/* 节点类型 → 图标（画布节点、挂点、菜单、连线角标共用一套） */
export function NodeGlyph({ kind, size = 14, ...rest }) {
  if (kind === 'text') return <IcText size={size} {...rest} />
  if (kind === 'video') return <IcVideo size={size} {...rest} />
  if (kind === 'audio') return <IcAudio size={size} {...rest} />
  if (kind === 'compose') return <IcComposeGlyph size={size} {...rest} />
  return <IcImage size={size} {...rest} />
}

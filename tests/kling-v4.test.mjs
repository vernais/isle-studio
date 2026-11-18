/* Kling-v4 离线测试（1.2.0）：node --test tests/kling-v4.test.mjs
   不发起任何网络请求、不消耗积分；只验本地模式识别、图序、校验与请求体。
   源码是 ESM（src/lib/klingVideo.js），项目 package.json 不是 type:module，
   因此测试前把源文件复制成 .mjs 再 import——保证测的就是线上那份代码。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', 'src', 'lib', 'klingVideo.js')
const gen = path.join(here, '.gen')
fs.mkdirSync(gen, { recursive: true })
const target = path.join(gen, 'klingVideo.mjs')
fs.copyFileSync(src, target)

const K = await import('file://' + target.replace(/\\/g, '/'))

test('模型识别：只认 kling-v4 系', () => {
  assert.equal(K.isKlingV4('kling-v4'), true)
  assert.equal(K.isKlingV4('Kling V4'), true)
  assert.equal(K.isKlingV4('kling-v4-turbo'), true)
  assert.equal(K.isKlingV4('kling-v3'), false)
  assert.equal(K.isKlingV4('kling-v3-omni'), false)
  assert.equal(K.isKlingV4(''), false)
})

test('模式默认值：旧节点无 klingMode → frames', () => {
  assert.equal(K.klingModeOf({}), 'frames')
  assert.equal(K.klingModeOf({ klingMode: '' }), 'frames')
  assert.equal(K.klingModeOf({ klingMode: 'REFERENCE' }), 'reference')
  assert.equal(K.klingModeOf({ klingMode: 'bogus' }), 'frames')
})

test('图序去重保序', () => {
  assert.deepEqual(K.dedupeUrls(['a', 'b', 'a', '', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(K.dedupeUrls(null), [])
})

test('首尾帧：超过两张图本地拦截', () => {
  const r = K.validateKlingInput({
    model: 'kling-v4', mode: 'frames', imageUrls: ['a', 'b', 'c'], duration: 5
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /最多 2 张/)
})

test('首尾帧：两张图通过，音色被忽略', () => {
  const r = K.validateKlingInput({
    model: 'kling-v4', mode: 'frames', imageUrls: ['a', 'b'],
    audioUrls: ['https://x/voice.mp3'], duration: 5
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.imageUrls, ['a', 'b'])
  assert.deepEqual(r.audioUrls, [])
  assert.ok(r.notes.some((n) => /音色/.test(n)))
})

test('首尾帧：0 张图 = 文生视频，允许', () => {
  const r = K.validateKlingInput({ model: 'kling-v4', mode: 'frames', imageUrls: [], duration: 5 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.imageUrls, [])
})

test('多图参考：至少一张图', () => {
  const r = K.validateKlingInput({ model: 'kling-v4', mode: 'reference', imageUrls: [], duration: 5 })
  assert.equal(r.ok, false)
  assert.match(r.error, /至少需要 1 张/)
})

test('多图参考：面板 4 张 / 底层 10 张的上限分离', () => {
  const imgs = ['a', 'b', 'c', 'd', 'e']
  const ui = K.validateKlingInput({ model: 'kling-v4', mode: 'reference', imageUrls: imgs, duration: 5, maxRefs: 4 })
  assert.equal(ui.ok, true)
  assert.equal(ui.imageUrls.length, 4)
  assert.ok(ui.notes.some((n) => /只提交前 4 张/.test(n)))
  const api = K.validateKlingInput({ model: 'kling-v4', mode: 'reference', imageUrls: imgs, duration: 5, maxRefs: 10 })
  assert.equal(api.imageUrls.length, 5)
})

test('音色：只保留公网直链', () => {
  const r = K.validateKlingInput({
    model: 'kling-v4', mode: 'reference', imageUrls: ['a'],
    audioUrls: ['https://x/voice.mp3', 'data:audio/mp3;base64,AAA'], duration: 5
  })
  assert.deepEqual(r.audioUrls, ['https://x/voice.mp3'])
  assert.ok(r.notes.some((n) => /公网 HTTP\/HTTPS/.test(n)))
})

test('时长：整秒 + 3–30 区间', () => {
  const a = K.validateKlingInput({ model: 'kling-v4', mode: 'frames', imageUrls: [], duration: 5.6 })
  assert.equal(a.duration, 6)
  assert.ok(a.notes.some((n) => /整秒/.test(n)))
  const b = K.validateKlingInput({ model: 'kling-v4', mode: 'frames', imageUrls: [], duration: 40 })
  assert.equal(b.duration, 30)
  const c = K.validateKlingInput({ model: 'kling-v4', mode: 'frames', imageUrls: [], duration: 1 })
  assert.equal(c.duration, 3)
})

test('请求体：多图参考带 omni_reference_task_type / image_urls / audio_urls', () => {
  const body = K.buildKlingBody({
    model: 'kling-v4', prompt: '镜头缓慢推进', mode: 'reference',
    imageUrls: ['u1', 'u2'], audioUrls: ['https://x/v.mp3', 'ftp://bad'], duration: 8,
    resolution: '1080p', size: '16:9'
  })
  assert.equal(body.omni_reference_task_type, 'reference')
  assert.deepEqual(body.image_urls, ['u1', 'u2'])
  assert.deepEqual(body.audio_urls, ['https://x/v.mp3'])
  assert.equal(body.aspect_ratio, '16:9')
  assert.equal(body.duration, 8)
  assert.equal(body.resolution, '1080p')
  assert.equal(body.size, undefined)
})

test('请求体：首尾帧不带 omni 与音频，最多两张', () => {
  const body = K.buildKlingBody({
    model: 'kling-v4', prompt: 'p', mode: 'frames',
    imageUrls: ['u1', 'u2', 'u3'], audioUrls: ['https://x/v.mp3'], duration: 5,
    resolution: '720p', size: '9:16'
  })
  assert.equal(body.omni_reference_task_type, undefined)
  assert.equal(body.audio_urls, undefined)
  assert.deepEqual(body.image_urls, ['u1', 'u2'])
  assert.equal(body.aspect_ratio, '9:16')
})

test('请求体：Auto 画幅不发送 aspect_ratio', () => {
  const body = K.buildKlingBody({ model: 'kling-v4', prompt: 'p', mode: 'frames', size: 'Auto' })
  assert.equal(body.aspect_ratio, undefined)
})

test('角色提示词：按图序编号，三视图按同一人处理', () => {
  const block = K.rolePromptBlock([{ role: '主角' }, { role: '三视图' }, {}])
  assert.match(block, /@Image1（主角）/)
  assert.match(block, /@Image2（三视图）：同一人物的三视图/)
  assert.equal(block.includes('@Image3'), false)
  assert.equal(K.rolePromptBlock([{}, {}]), '')
})

test('音色提示词块', () => {
  assert.match(K.audioPromptBlock(1), /@Audio1 为音色参考/)
  assert.equal(K.audioPromptBlock(0), '')
})

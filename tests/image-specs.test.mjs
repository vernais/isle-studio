/* 图片尺寸口径离线测试（1.2.0）：node --test tests/image-specs.test.mjs
   不发起网络请求、不消耗积分。数据来自 2026-11-18 网关实测报错与成图尺寸。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const gen = path.join(here, '.gen')
fs.mkdirSync(gen, { recursive: true })
const target = path.join(gen, 'imageSpecs.mjs')
fs.copyFileSync(path.join(here, '..', 'src', 'lib', 'imageSpecs.js'), target)
const S = await import('file://' + target.replace(/\\/g, '/'))

test('4K 降级：seedream-5-0-pro 只到 2K', () => {
  const r = S.sanitizeImageParams('seedream-5-0-pro', { size: '16:9', resolution: '4K' })
  assert.equal(r.params.resolution, '2K')
  assert.match(r.notes.join(), /4K → 2K/)
})

test('4K 保留：gemini-3-pro-image-preview 支持 4K', () => {
  const r = S.sanitizeImageParams('gemini-3-pro-image-preview', { size: '16:9', resolution: '4K' })
  assert.equal(r.params.resolution, '4K')
  assert.equal(r.notes.length, 0)
})

test('4K 降级：qwen-image-3.0-pro / flux-2-pro / z-image-turbo 都到不了 4K', () => {
  for (const m of ['qwen-image-3.0-pro', 'flux-2-pro', 'z-image-turbo']) {
    assert.equal(S.sanitizeImageParams(m, { resolution: '4K' }).params.resolution, '2K', m)
  }
})

test('档位选项：只到 2K 的模型面板不给 4K', () => {
  assert.deepEqual(S.imageResOptions('seedream-5-0-pro'), ['1K', '2K'])
  assert.deepEqual(S.imageResOptions('gemini-nano-banana-2.1'), ['1K', '2K', '4K'])
  /* 未收录模型保持全档，不误伤 */
  assert.deepEqual(S.imageResOptions('some-unknown-model'), ['1K', '2K', '4K'])
})

test('固定像素模型：gpt-image-1.5 映射到 1024x1536 且不再发档位', () => {
  const r = S.sanitizeImageParams('gpt-image-1.5', { size: '16:9', resolution: '4K' })
  assert.equal(r.params.resolution, '')
  assert.equal(r.params.size, '1536x1024')
  assert.equal(S.requestSizeFor('gpt-image-1.5', '9:16'), '1024x1536')
})

test('不接受 size 的模型：grok 清空画幅，muse 清空档位与画幅', () => {
  assert.equal(S.sanitizeImageParams('grok-imagine-image-quality', { size: '16:9' }).params.size, '')
  const muse = S.sanitizeImageParams('muse-image-ext', { size: '16:9', resolution: '4K' })
  assert.equal(muse.params.size, '')
  assert.equal(muse.params.resolution, '')
})

test('比例型模型不改写 size：gemini 仍是 16:9（传像素会 400）', () => {
  assert.equal(S.requestSizeFor('gemini-nano-banana-2.1', '16:9'), '16:9')
  assert.equal(S.requestSizeFor('gemini-nano-banana-2.1', '2048x1152'), '2048x1152')
})

test('像素提示：4K 给实测画布，其它给预计值', () => {
  assert.match(S.pixelHint('gemini-nano-banana-2.1', '16:9', '4K'), /5504×3072/)
  assert.match(S.pixelHint('gemini-3-pro-image-preview', '16:9', '2K'), /2048×1152/)
  assert.match(S.pixelHint('gemini-3-pro-image-preview', '16:9', '4K'), /4096×2304/)
})

test('合法档位不被改写，大小写归一', () => {
  const r = S.sanitizeImageParams('gemini-3-pro-image-preview', { resolution: '2k' })
  assert.equal(r.params.resolution, '2K')
  assert.equal(r.notes.length, 0)
})

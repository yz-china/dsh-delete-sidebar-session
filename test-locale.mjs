/**
 * 语言探测的回归测试。
 *
 * 复现真机上遇到的缺陷：
 *   系统 `navigator.language` 是英文，但 DSH 界面设成中文时，
 *   旧实现只看 navigator → 误判成英文 → 菜单和确认框变英文。
 *
 * 正确做法是优先读 DSH 自己的 locale 服务（`ctx.get('locale').getSnapshot().active`）。
 *
 * 运行：node test-locale.mjs
 */

import assert from 'node:assert/strict'

/**
 * 复刻 client.js 的 activeLocale：优先 DSH locale 服务，其次 html lang，最后 navigator。
 * @param {object} ctx - 假上下文。
 * @param {{html?: string, nav?: string}} env - 假浏览器环境。
 * @returns {string} 语言 id。
 */
function activeLocale(ctx, env) {
  try {
    const snapshot = ctx?.get?.('locale')?.getSnapshot?.()
    const id = typeof snapshot === 'string' ? snapshot : (snapshot?.active ?? snapshot?.locale ?? snapshot?.id)
    if (typeof id === 'string' && id.length > 0) return id
  } catch { /* 继续向下探测 */ }
  try {
    const html = env?.html
    if (typeof html === 'string' && html.length > 0) return html
  } catch { /* 忽略 */ }
  try {
    const nav = env?.nav
    if (typeof nav === 'string' && nav.length > 0) return nav
  } catch { /* 忽略 */ }
  return ''
}

/** 复刻 pickLocale：只有明确英文才英文，其余一律中文。 */
function pickLocale(ctx, env) {
  return activeLocale(ctx, env).toLowerCase().startsWith('en') ? 'EN' : 'ZH'
}

/** 造一个只提供 locale 服务的假 ctx。 */
const serviceWith = (id) => ({
  get: (key) => (key === 'locale' ? { getSnapshot: () => ({ active: id }) } : undefined),
})
const noService = { get: () => undefined }

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('dsh-delete-sidebar-session locale test')

ok('DSH=zh + 浏览器=en → 中文（旧实现的缺陷）', () => {
  assert.equal(pickLocale(serviceWith('zh'), { html: 'en-US', nav: 'en-US' }), 'ZH')
})

ok('DSH=en + 浏览器=en → 英文', () => {
  assert.equal(pickLocale(serviceWith('en'), { html: 'en-US', nav: 'en-US' }), 'EN')
})

ok('DSH=zh-CN 这种带地区码的也认', () => {
  assert.equal(pickLocale(serviceWith('zh-CN'), { nav: 'en-US' }), 'ZH')
})

ok('服务读不到时退回 html lang', () => {
  assert.equal(pickLocale(noService, { html: 'zh-CN', nav: 'en-US' }), 'ZH')
})

ok('服务与 html 都读不到时退回 navigator', () => {
  assert.equal(pickLocale(noService, { nav: 'zh-CN' }), 'ZH')
  assert.equal(pickLocale(noService, { nav: 'en-GB' }), 'EN')
})

ok('全都读不到时默认中文', () => {
  assert.equal(pickLocale(noService, {}), 'ZH')
  assert.equal(pickLocale(undefined, undefined), 'ZH')
})

ok('locale 服务抛错不会让渲染崩溃', () => {
  const broken = { get: () => { throw new Error('boom') } }
  assert.equal(pickLocale(broken, { nav: 'en-US' }), 'EN')
})

ok('getSnapshot 返回字符串也支持', () => {
  const asString = { get: () => ({ getSnapshot: () => 'zh' }) }
  assert.equal(pickLocale(asString, { nav: 'en-US' }), 'ZH')
})

console.log(`\n全部通过：${passed} 项`)

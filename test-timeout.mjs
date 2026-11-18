/**
 * 确认框超时与可退出性的回归测试。
 *
 * 复现真机缺陷：点「确认删除」后，弹窗停在「删除中…」，
 * 叉不掉、Esc 无效、取消禁用 —— 用户被困住。
 *
 * 根因：`await state.onConfirm()` 没有任何上界。宿主或事件循环一旦挂住，
 * 按钮永远停在 disabled 状态。
 *
 * 本文件用最小 DOM 桩驱动 confirmDialog 的等价逻辑，验证：
 *   1. onConfirm 永不 resolve 时，超时后报错并恢复按钮
 *   2. 取消按钮在删除过程中始终可点
 *   3. Esc 始终能关闭
 *   4. onConfirm 抛错时按钮恢复
 *
 * 运行：node test-timeout.mjs
 */

import assert from 'node:assert/strict'

const TIMEOUT_MS = 120 // 测试用短超时

const ZH = {
  confirmTitle: '彻底删除这个会话？',
  confirmBody: 'body',
  confirmId: '会话 ID',
  confirmDir: '会话目录',
  confirmNoDir: 'no dir',
  confirmRunning: 'running',
  cancel: '取消',
  confirm: '确认删除',
  working: '删除中…',
  timeout: '宿主响应超时，删除可能未完成',
}

/**
 * 极简 DOM 桩：只实现 confirmDialog 用到的接口。
 * @returns {object} document 与可查询的节点表。
 */
function makeDom() {
  const nodes = []
  const makeEl = (tag = 'div') => {
    const el = {
      tag,
      style: {},
      dataset: {},
      children: [],
      textContent: '',
      disabled: false,
      className: '',
      _listeners: {},
      setAttribute() {},
      append(...kids) { for (const k of kids) { this.children.push(k); nodes.push(k) } },
      appendChild(k) { this.children.push(k); nodes.push(k); return k },
      addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn) },
      removeEventListener(type, fn) {
        const list = this._listeners[type]
        if (!list) return
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      },
      remove() { this._removed = true },
      click() { for (const fn of this._listeners.click ?? []) fn({ target: this }) },
      focus() {},
    }
    nodes.push(el)
    return el
  }
  const body = makeEl('body')
  const document = { createElement: makeEl, body }
  return { document, nodes, body }
}

/**
 * 复刻 client.js 里 confirmDialog 的按钮与超时逻辑（不复制样式与 DOM 细节）。
 * @param {object} state - { onConfirm }。
 * @returns {Promise<{result: boolean, dom: object, buttons: object, errorBox: object}>} 结果。
 */
function runDialog(state) {
  const { document, nodes } = makeDom()
  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = ZH.cancel
  const confirmBtn = document.createElement('button')
  confirmBtn.textContent = ZH.confirm
  const errorBox = document.createElement('button')
  errorBox.style.display = 'none'
  const overlay = document.createElement('div')

  let settled = false
  let resolveOuter
  const done = new Promise((r) => { resolveOuter = r })

  const finish = (value) => {
    if (settled) return
    settled = true
    overlay.remove()
    resolveOuter(value)
  }

  const onKey = (event) => {
    if (event.key === 'Escape') finish(false)
  }
  const keyListeners = []
  const fakeWindow = {
    addEventListener: (t, fn) => { if (t === 'keydown') keyListeners.push(fn) },
    removeEventListener: (t, fn) => {
      const i = keyListeners.indexOf(fn)
      if (i >= 0) keyListeners.splice(i, 1)
    },
  }

  cancelBtn.addEventListener('click', () => finish(false))

  confirmBtn.addEventListener('click', () => {
    if (confirmBtn.disabled) return
    const run = async () => {
      confirmBtn.disabled = true
      cancelBtn.disabled = false
      confirmBtn.textContent = ZH.working
      errorBox.style.display = 'none'

      let timedOut = false
      const timer = setTimeout(() => { timedOut = true }, TIMEOUT_MS)
      try {
        await Promise.race([
          state.onConfirm(),
          new Promise((_, reject) => setTimeout(() => reject(new Error(ZH.timeout)), TIMEOUT_MS)),
        ])
        clearTimeout(timer)
        if (settled) return
        finish(true)
      } catch (failure) {
        clearTimeout(timer)
        if (settled) return
        confirmBtn.disabled = false
        cancelBtn.disabled = false
        confirmBtn.textContent = ZH.confirm
        const message = failure instanceof Error ? failure.message : String(failure)
        errorBox.textContent = timedOut ? `${message}（${TIMEOUT_MS / 1000}s）` : message
        errorBox.style.display = ''
      }
    }
    void run()
  })

  fakeWindow.addEventListener('keydown', onKey)

  return {
    done,
    dom: { document, nodes },
    buttons: { cancelBtn, confirmBtn, errorBox, overlay },
    pressEscape() { for (const fn of [...keyListeners]) fn({ key: 'Escape', preventDefault() {} }) },
  }
}

let passed = 0
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('dsh-delete-sidebar-session 确认框超时测试')

  await ok('onConfirm 永不返回 → 超时报错并恢复按钮', async () => {
    const d = runDialog({ onConfirm: () => new Promise(() => {}) })
    d.buttons.confirmBtn.click()
    // 点击瞬间：确认键禁用，取消键必须可点
    assert.equal(d.buttons.confirmBtn.disabled, true)
    assert.equal(d.buttons.cancelBtn.disabled, false, '取消键不能禁用')
    assert.equal(d.buttons.confirmBtn.textContent, ZH.working)

    await sleep(TIMEOUT_MS + 80)
    assert.equal(d.buttons.confirmBtn.disabled, false, '超时后确认键应恢复')
    assert.equal(d.buttons.cancelBtn.disabled, false)
    assert.equal(d.buttons.confirmBtn.textContent, ZH.confirm)
    assert.match(d.buttons.errorBox.textContent, /超时/, '应显示超时原因')
    assert.equal(d.buttons.errorBox.style.display, '')
  })

  await ok('删除过程中取消键可点，能关掉弹窗', async () => {
    const d = runDialog({ onConfirm: () => new Promise(() => {}) })
    d.buttons.confirmBtn.click()
    assert.equal(d.buttons.cancelBtn.disabled, false)
    d.buttons.cancelBtn.click()
    const result = await d.done
    assert.equal(result, false, '取消应返回 false')
    assert.equal(d.buttons.overlay._removed, true, '弹窗应被移除')
  })

  await ok('删除过程中 Esc 能关闭', async () => {
    const d = runDialog({ onConfirm: () => new Promise(() => {}) })
    d.buttons.confirmBtn.click()
    d.pressEscape()
    const result = await d.done
    assert.equal(result, false)
    assert.equal(d.buttons.overlay._removed, true)
  })

  await ok('onConfirm 抛错 → 按钮恢复并显示错误', async () => {
    const d = runDialog({ onConfirm: () => Promise.reject(new Error('boom')) })
    d.buttons.confirmBtn.click()
    await sleep(30)
    assert.equal(d.buttons.confirmBtn.disabled, false)
    assert.equal(d.buttons.confirmBtn.textContent, ZH.confirm)
    assert.equal(d.buttons.errorBox.textContent, 'boom')
  })

  await ok('onConfirm 正常完成 → 返回 true 并关闭', async () => {
    const d = runDialog({ onConfirm: async () => { await sleep(10) } })
    d.buttons.confirmBtn.click()
    const result = await d.done
    assert.equal(result, true)
    assert.equal(d.buttons.overlay._removed, true)
  })

  await ok('重复点击确认键不会并发执行', async () => {
    let calls = 0
    const d = runDialog({
      onConfirm: async () => { calls += 1; await sleep(TIMEOUT_MS + 50) },
    })
    d.buttons.confirmBtn.click()
    d.buttons.confirmBtn.click()
    d.buttons.confirmBtn.click()
    await sleep(TIMEOUT_MS + 120)
    assert.equal(calls, 1, '只应执行一次')
  })

  console.log(`\n全部通过：${passed} 项`)
}

main().catch((e) => { console.error('\n失败：', e); process.exit(1) })

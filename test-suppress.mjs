/**
 * 客户端抑制逻辑的回归测试。
 *
 * 复现真机上观察到的缺陷：
 *   删完文件 → handleSessionRemoved 剔掉那一行 → 紧接着 refresh()
 *   → 宿主把「内存里仍活着的 live session」无条件合并回列表 → 已删行复活。
 *
 * 本文件用一个假宿主复刻这条时序，验证抑制表能持续挡住复活，
 * 且不会误伤邻居会话。
 *
 * 运行：node test-suppress.mjs
 */

import assert from 'node:assert/strict'

const TARGET = 'session-dff69070-0e33-41a9-8525-9e9d9b323dc7'
const KEEP = 'session-9e392923-12a2-4ba9-9764-6ac4560ccfbb'

/**
 * 造一个复刻真实行为的假宿主：
 * - `refresh()` 总是返回含全部 live session 的磁盘+内存合并快照；
 * - `handleSessionRemoved(id)` 同步从本地 summaries 里剔掉该行。
 */
function makeHost(ids) {
  const state = { summaries: ids.map((sessionId) => ({ sessionId })) }
  const sessions = {
    get summaries() { return state.summaries },
    handleSessionRemoved(sessionId) {
      // 与 @deepseek-ai/dsh-api-session-controller 的 applyMutation('remove') 同义
      state.summaries = state.summaries.filter((s) => s.sessionId !== sessionId)
    },
    async refresh() {
      // 关键：live session 在宿主侧无条件合并回来（文件删了也还在）
      state.summaries = ids.map((sessionId) => ({ sessionId }))
    },
    /** 模拟宿主推来一条新会话。 */
    push(summary) {
      state.summaries = [summary, ...state.summaries]
    },
  }
  return sessions
}

/** 复刻 client.js 里的抑制实现。 */
function makeSuppression() {
  const suppressed = new Set()
  const enforce = (sessions) => {
    if (suppressed.size === 0) return 0
    let evicted = 0
    for (const id of suppressed) {
      sessions.handleSessionRemoved(id)
      evicted += 1
    }
    return evicted
  }
  return { suppressed, enforce }
}

const idsOf = (sessions) => sessions.summaries.map((s) => s.sessionId)

let passed = 0
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

async function main() {
  console.log('dsh-session-purge suppression test')

  await ok('先复现缺陷：只刷新不做抑制，已删行会复活', async () => {
    const sessions = makeHost([TARGET, KEEP])
    sessions.handleSessionRemoved(TARGET)
    assert.deepEqual(idsOf(sessions), [KEEP])
    await sessions.refresh()
    // 这就是真机截图里的现象
    assert.deepEqual(idsOf(sessions), [TARGET, KEEP], '未抑制时应当复活')
  })

  await ok('抑制生效：refresh 后目标行仍不在列表里', async () => {
    const sessions = makeHost([TARGET, KEEP])
    const { suppressed, enforce } = makeSuppression()

    suppressed.add(TARGET)
    sessions.handleSessionRemoved(TARGET)
    assert.deepEqual(idsOf(sessions), [KEEP])

    await sessions.refresh()
    enforce(sessions)
    assert.deepEqual(idsOf(sessions), [KEEP], '抑制后不应复活')
  })

  await ok('邻居会话不受影响', async () => {
    const sessions = makeHost([TARGET, KEEP])
    const { suppressed, enforce } = makeSuppression()
    suppressed.add(TARGET)
    await sessions.refresh()
    enforce(sessions)
    assert.ok(idsOf(sessions).includes(KEEP), 'KEEP 必须保留')
    assert.ok(!idsOf(sessions).includes(TARGET), 'TARGET 必须消失')
  })

  await ok('多次 refresh 持续有效（幂等）', async () => {
    const sessions = makeHost([TARGET, KEEP])
    const { suppressed, enforce } = makeSuppression()
    suppressed.add(TARGET)
    for (let i = 0; i < 5; i++) {
      await sessions.refresh()
      enforce(sessions)
    }
    assert.deepEqual(idsOf(sessions), [KEEP])
  })

  await ok('抑制表为空时不做任何事', async () => {
    const sessions = makeHost([TARGET, KEEP])
    const { enforce } = makeSuppression()
    await sessions.refresh()
    assert.equal(enforce(sessions), 0)
    assert.deepEqual(idsOf(sessions), [TARGET, KEEP])
  })

  await ok('宿主新增的其它会话照常出现', async () => {
    const sessions = makeHost([TARGET, KEEP])
    const { suppressed, enforce } = makeSuppression()
    suppressed.add(TARGET)
    await sessions.refresh()
    enforce(sessions)
    // 模拟宿主推来一条新会话
    sessions.push({ sessionId: 'session-aaaaaaaa-0000-0000-0000-000000000000' })
    assert.equal(sessions.summaries.length, 2)
    assert.deepEqual(idsOf(sessions).sort(), [KEEP, 'session-aaaaaaaa-0000-0000-0000-000000000000'].sort())
  })

  console.log(`\n全部通过：${passed} 项`)
}

main().catch((error) => {
  console.error('\n失败：', error)
  process.exit(1)
})

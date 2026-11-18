/**
 * dsh-delete-sidebar-session 自测：在临时目录里造一份假的 DSH 数据根，验证
 * 会话目录、投影缓存、工作区索引、备份副本四类目标都被精确清理，
 * 且不相关的数据一个字节都不动；同时覆盖注册表优先路径与 live Agent 探测。
 *
 * 运行：node test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  purgeSession, projectKey, locateSessionDirs, internals,
} from './index.js'

const TARGET = 'session-dff69070-0e33-41a9-8525-9e9d9b323dc7'
const KEEP = 'session-9e392923-12a2-4ba9-9764-6ac4560ccfbb'
const CWD = 'F:\\ASNIA\\Desktop\\Workspace1'

let passed = 0
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 存在性检查，不抛错。 */
async function exists(path) {
  try { await access(path); return true } catch { return false }
}

/** 造一份含目标会话与邻居会话的假数据根。 */
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-purge-test-'))
  const projectDir = join(home, 'sessions', projectKey(CWD))
  await mkdir(join(projectDir, TARGET), { recursive: true })
  await mkdir(join(projectDir, KEEP), { recursive: true })
  await writeFile(join(projectDir, TARGET, 'session.v4.jsonl.zstd'), 'target-log')
  await writeFile(join(projectDir, KEEP, 'session.v4.jsonl.zstd'), 'keep-log')

  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(
    join(home, 'storages', 'session_projcache', 'sessions', `${TARGET}.json`),
    JSON.stringify({ title: TARGET }),
  )
  await writeFile(
    join(home, 'storages', 'session_projcache', 'sessions', `${KEEP}.json`),
    JSON.stringify({ title: KEEP }),
  )

  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { pinnedSessionIds: [TARGET], archivedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-1': { path: CWD, title: 'Workspace1', sessionIds: [KEEP, TARGET] },
      },
    },
  }, null, 2))

  const backup = join(home, 'deleted-sessions-backup-20261118-202915')
  await mkdir(join(backup, TARGET), { recursive: true })
  await writeFile(join(backup, `${TARGET}.json`), '{}')
  await writeFile(join(backup, 'workspace.json'), '{}')
  await writeFile(join(backup, `${KEEP}.json`), '{}')
  return { home, projectDir, backup }
}

/** 会记录调用的假注册表。 */
function fakeRegistry({ fail = false } = {}) {
  const calls = []
  return {
    calls,
    unarchiveSession(id) {
      calls.push(['unarchiveSession', id])
      return fail ? Promise.reject(new Error('registry boom')) : Promise.resolve()
    },
    unpinSession(id) {
      calls.push(['unpinSession', id])
      return fail ? Promise.reject(new Error('registry boom')) : Promise.resolve()
    },
  }
}

async function main() {
  console.log('dsh-delete-sidebar-session self test')

  await ok('projectKey 与宿主同名规则一致', async () => {
    assert.equal(projectKey(CWD), '--F-ASNIA-Desktop-Workspace1--')
    assert.equal(projectKey('/home/bob/my proj'), '--home-bob-my~0020proj--')
    assert.equal(projectKey('C:\\a:b'), '--C-a-b--')
    assert.throws(() => projectKey(''), /空的工作目录/)
  })

  await ok('isStrictlyInside 拒绝自身与越界', async () => {
    const strict = internals.isStrictlyInside
    assert.equal(strict('C:\\a', 'C:\\a\\b'), true)
    assert.equal(strict('C:\\a', 'C:\\a'), false)
    assert.equal(strict('C:\\a', 'C:\\a\\..\\b'), false)
  })

  await ok('定位会话目录（按 cwd 推导 / cwd 缺失全树查找）', async () => {
    const { home } = await makeHome()
    try {
      const byCwd = await locateSessionDirs(join(home, 'sessions'), TARGET, CWD)
      assert.equal(byCwd.length, 1)
      assert.ok(byCwd[0].endsWith(TARGET))
      const byId = await locateSessionDirs(join(home, 'sessions'), TARGET, undefined)
      assert.equal(byId.length, 1)
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('非法 id 一律拒绝', async () => {
    const { home } = await makeHome()
    try {
      assert.deepEqual(await locateSessionDirs(join(home, 'sessions'), '../../etc', CWD), [])
      await assert.rejects(
        purgeSession({ home, sessionId: '../evil', maxBackupScanEntries: 1000 }),
        /非法的会话 id/,
      )
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('文件层：四类目标精确清理，邻居零改动', async () => {
    const { home, projectDir, backup } = await makeHome()
    try {
      const result = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        // 不给注册表 → 走文件层兜底
      })
      assert.deepEqual(result.failures, [])
      assert.equal(result.ok, true)
      assert.equal(result.registry, 'unavailable')

      assert.equal(await exists(join(projectDir, TARGET)), false)
      assert.equal(await exists(join(projectDir, KEEP, 'session.v4.jsonl.zstd')), true)

      const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
      assert.equal(await exists(join(cacheDir, `${TARGET}.json`)), false)
      assert.equal(await exists(join(cacheDir, `${KEEP}.json`)), true)

      const doc = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
      assert.deepEqual(doc.global.pinnedSessionIds, [])
      assert.deepEqual(doc.tables.workspaces['ws-1'].sessionIds, [KEEP])
      assert.equal(doc.tables.workspaces['ws-1'].title, 'Workspace1')

      assert.equal(await exists(join(backup, TARGET)), false)
      assert.equal(await exists(join(backup, `${TARGET}.json`)), false)
      assert.equal(await exists(join(backup, `${KEEP}.json`)), true)
      assert.equal(await exists(join(backup, 'workspace.json')), true)
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('注册表优先：调用 unarchive/unpin，不再裸改 JSON', async () => {
    const { home } = await makeHome()
    try {
      const registry = fakeRegistry()
      const result = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { workspaceRegistry: registry },
      })
      assert.deepEqual(result.failures, [])
      assert.equal(result.registry, 'registry')
      assert.deepEqual(registry.calls, [
        ['unarchiveSession', TARGET],
        ['unpinSession', TARGET],
      ])
      assert.ok(result.removed.workspaceIndex.includes('unarchiveSession'))

      // 走注册表时不应动 workspace.json
      const doc = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
      assert.deepEqual(doc.global.pinnedSessionIds, [TARGET])
      assert.deepEqual(doc.tables.workspaces['ws-1'].sessionIds, [KEEP, TARGET])
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('注册表抛错时退回文件层并如实回报', async () => {
    const { home } = await makeHome()
    try {
      const result = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { workspaceRegistry: fakeRegistry({ fail: true }) },
      })
      // 注册表抛错时仍走 registry 通道（只是 ok:false），随后退回文件层
      assert.equal(result.registry, 'registry')
      assert.ok(result.failures.some((f) => f.includes('注册表')))
      const doc = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
      assert.deepEqual(doc.global.pinnedSessionIds, [])
      assert.deepEqual(doc.tables.workspaces['ws-1'].sessionIds, [KEEP])
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('liveAgent 探测：有 Agent 时置 true', async () => {
    const { home } = await makeHome()
    try {
      const agents = { get: (id) => (id === TARGET ? { id } : undefined) }
      const result = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { agents, workspaceRegistry: fakeRegistry() },
      })
      assert.equal(result.liveAgent, true)
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('重复删除是幂等的', async () => {
    const { home } = await makeHome()
    try {
      await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { workspaceRegistry: fakeRegistry() },
      })
      const again = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { workspaceRegistry: fakeRegistry() },
      })
      assert.deepEqual(again.failures, [])
      // 文件层已无可删项；注册表通道仍会调用一次（幂等，不产生新改动）
      assert.equal(again.removed.sessionDirs.length, 0)
      assert.equal(again.removed.projectionCache.length, 0)
      assert.equal(again.removed.backups.length, 0)
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('mentions 只认真正引用的文档', async () => {
    const { mentions } = internals
    assert.equal(mentions({ a: [TARGET] }, TARGET), true)
    assert.equal(mentions({ [`bySession.${TARGET}`]: {} }, TARGET), true)
    assert.equal(mentions({ a: [KEEP] }, TARGET), false)
  })

  await ok('detachRegistry 无服务时如实报告不可用', async () => {
    const viaNone = await internals.detachRegistry(undefined, TARGET)
    assert.equal(viaNone.ok, false)
    assert.equal(viaNone.via, 'unavailable')
    const viaReadonly = await internals.detachRegistry({}, TARGET)
    assert.equal(viaReadonly.ok, false)
  })

  console.log(`\n全部通过：${passed} 项`)
}

main().catch((error) => {
  console.error('\n失败：', error)
  process.exit(1)
})

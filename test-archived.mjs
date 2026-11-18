/**
 * 归档会话删除的回归测试。
 *
 * 复现真机缺陷：会话已归档 → 点「彻底删除会话」→ 界面卡死。
 *
 * 根因：宿主的 Workspace 对象把 `sessionIds` 当成员登记，而候选匹配靠
 * `sessionPaths` 缓存判断（文件删了缓存不失效）。只清归档集合不清成员登记时，
 * 前端仍会渲染这一行，但会话实例已随文件消失 —— 渲染等待一个永远不来的对象。
 *
 * 正确做法是三处一起摘：detachSession / unarchiveSession / unpinSession。
 *
 * 运行：node test-archived.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { purgeSession, projectKey, internals } from './index.js'

const TARGET = 'session-abcdef01-0000-0000-0000-000000000001'
const OTHER = 'session-9e392923-12a2-4ba9-9764-6ac4560ccfbb'
const CWD = 'F:\\ASNIA\\Desktop\\Workspace1'

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

/**
 * 复刻宿主 Workspace 的成员登记：sessionIds 是内部数组，
 * detachSession 从里面摘掉 id 并写回记录。
 */
function makeWorkspace(id, path, sessionIds) {
  const record = { path, title: 'Workspace1', sessionIds: [...sessionIds] }
  return {
    id,
    get path() { return record.path },
    get sessionIds() { return record.sessionIds },
    _record: record,
    async detachSession(sessionId) {
      record.sessionIds = record.sessionIds.filter((x) => x !== sessionId)
    },
  }
}

/** 假注册表：持有 Workspace 列表 + 归档/置顶集合。 */
function makeRegistry({ workspaces, archived = [], pinned = [] }) {
  const calls = []
  const state = { archivedSessionIds: [...archived], pinnedSessionIds: [...pinned] }
  return {
    calls,
    workspaces,
    get archivedSessionIds() { return state.archivedSessionIds },
    get pinnedSessionIds() { return state.pinnedSessionIds },
    list() { return workspaces },
    unarchiveSession(id) {
      calls.push(['unarchive', id])
      state.archivedSessionIds = state.archivedSessionIds.filter((x) => x !== id)
      return Promise.resolve()
    },
    unpinSession(id) {
      calls.push(['unpin', id])
      state.pinnedSessionIds = state.pinnedSessionIds.filter((x) => x !== id)
      return Promise.resolve()
    },
  }
}

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-archived-'))
  const projectDir = join(home, 'sessions', projectKey(CWD))
  await mkdir(join(projectDir, TARGET), { recursive: true })
  await mkdir(join(projectDir, OTHER), { recursive: true })
  await writeFile(join(projectDir, TARGET, 'session.v4.jsonl.zstd'), 'target')
  await writeFile(join(projectDir, OTHER, 'session.v4.jsonl.zstd'), 'other')
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({}, null, 2), { flag: 'w' }).catch(() => {})
  return { home, projectDir }
}

let passed = 0
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

async function main() {
  console.log('dsh-delete-sidebar-session 归档会话测试')

  await ok('三处登记同时摘除（detach + unarchive + unpin）', async () => {
    const { home } = await makeHome()
    try {
      const ws = makeWorkspace('ws-1', CWD, [OTHER, TARGET])
      const registry = makeRegistry({ workspaces: [ws], archived: [TARGET], pinned: [TARGET] })

      const result = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { workspaceRegistry: registry },
      })

      assert.deepEqual(result.failures, [])
      assert.equal(result.ok, true)
      // 关键：成员登记必须被摘掉，否则前端会卡死
      assert.deepEqual(ws.sessionIds, [OTHER], 'sessionIds 里不能残留已删会话')
      assert.deepEqual(registry.archivedSessionIds, [], '归档集合必须清空')
      assert.deepEqual(registry.pinnedSessionIds, [], '置顶集合必须清空')
      assert.ok(result.removed.workspaceIndex.includes('detachSession'), '应记录 detachSession')
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('只归档未置顶的会话也能摘干净', async () => {
    const { home } = await makeHome()
    try {
      const ws = makeWorkspace('ws-1', CWD, [TARGET])
      const registry = makeRegistry({ workspaces: [ws], archived: [TARGET] })
      const result = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { workspaceRegistry: registry },
      })
      assert.deepEqual(result.failures, [])
      assert.deepEqual(ws.sessionIds, [])
      assert.deepEqual(registry.archivedSessionIds, [])
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('跨多个工作区时全部摘除', async () => {
    const { home } = await makeHome()
    try {
      const a = makeWorkspace('ws-a', CWD, [TARGET])
      const b = makeWorkspace('ws-b', 'D:\\other', [TARGET, OTHER])
      const registry = makeRegistry({ workspaces: [a, b] })
      const result = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { workspaceRegistry: registry },
      })
      assert.deepEqual(result.failures, [])
      assert.deepEqual(a.sessionIds, [])
      assert.deepEqual(b.sessionIds, [OTHER])
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('文件已删、登记仍在（脏索引）时也能自愈', async () => {
    const { home, projectDir } = await makeHome()
    try {
      // 模拟上次删除留下的脏数据：目录已不存在，但索引还列着它
      await rm(join(projectDir, TARGET), { recursive: true, force: true })
      const ws = makeWorkspace('ws-1', CWD, [OTHER, TARGET])
      const registry = makeRegistry({ workspaces: [ws], archived: [] })
      const result = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { workspaceRegistry: registry },
      })
      assert.deepEqual(result.failures, [])
      // 目录本来就不在，但成员登记必须被清掉
      assert.deepEqual(ws.sessionIds, [OTHER])
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('Workspace 缺 detachSession 时如实报错而非静默', async () => {
    const { home } = await makeHome()
    try {
      const ws = {
        path: CWD,
        sessionIds: [TARGET],
        // 故意不提供 detachSession
      }
      const registry = makeRegistry({ workspaces: [ws], archived: [TARGET] })
      const result = await purgeSession({
        home, sessionId: TARGET, cwd: CWD, maxBackupScanEntries: 5000,
        services: { workspaceRegistry: registry },
      })
      assert.ok(result.failures.some((f) => f.includes('detachSession')), '应报告 detachSession 缺失')
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  await ok('detachRegistry 对无服务返回 unavailable', async () => {
    const r = await internals.detachRegistry(undefined, TARGET)
    assert.equal(r.ok, false)
    assert.equal(r.via, 'unavailable')
  })

  console.log(`\n全部通过：${passed} 项`)
}

main().catch((error) => {
  console.error('\n失败：', error)
  process.exit(1)
})

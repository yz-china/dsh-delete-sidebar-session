/**
 * 端到端演练：用假的 ctx 启动 Host 半个包的真实 HTTP 路由，
 * 通过 fetch 走一遍 inspect + purge，验证路由、跨站拦截、级联删除
 * 与「注册表优先」的实时收尾路径。
 *
 * 运行：node e2e.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { apply, projectKey } from './index.js'

const TARGET = 'session-dff69070-0e33-41a9-8525-9e9d9b323dc7'
const KEEP = 'session-9e392923-12a2-4ba9-9764-6ac4560ccfbb'
const CWD = 'F:\\ASNIA\\Desktop\\Workspace1'

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

/** 会记录调用的假注册表。 */
function fakeRegistry() {
  const calls = []
  return {
    calls,
    unarchiveSession(id) { calls.push(['unarchive', id]); return Promise.resolve() },
    unpinSession(id) { calls.push(['unpin', id]); return Promise.resolve() },
  }
}

/**
 * 最小可用假 ctx：提供 inject / effect / get / logger。
 * webServer 用一条真实 http server 承载 register(kind:'prefix')。
 */
function makeContext(services) {
  const routes = []
  const ctx = {
    inject(deps, fn) {
      assert.deepEqual(deps, ['webServer'])
      fn({ webServer: { register(route) { routes.push(route); return () => {} } } })
    },
    effect(fn) { return fn() },
    get(key) { return services[key] },
    logger: { info() {}, warn() {} },
  }
  return { ctx, routes }
}

async function main() {
  console.log('dsh-session-purge e2e')

  const home = await mkdtemp(join(tmpdir(), 'dsh-purge-e2e-'))
  const projectDir = join(home, 'sessions', projectKey(CWD))
  await mkdir(join(projectDir, TARGET), { recursive: true })
  await mkdir(join(projectDir, KEEP), { recursive: true })
  await writeFile(join(projectDir, TARGET, 'session.v4.jsonl.zstd'), 'x')
  await writeFile(join(projectDir, KEEP, 'session.v4.jsonl.zstd'), 'y')
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${TARGET}.json`), '{}')
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { pinnedSessionIds: [], archivedSessionIds: [TARGET] },
    tables: { workspaces: { 'ws-1': { path: CWD, sessionIds: [TARGET, KEEP] } } },
  }))
  const backup = join(home, 'deleted-sessions-backup-20261118-202915')
  await mkdir(join(backup, TARGET), { recursive: true })
  await writeFile(join(backup, 'workspace.json'), '{}')

  const registry = fakeRegistry()
  const agents = { get: (id) => (id === TARGET ? { id } : undefined) }

  process.env.DSH_HOME = home
  const { ctx, routes } = makeContext({ workspaceRegistry: registry, agents })
  apply(ctx, { enabled: true, homeEnv: 'DSH_HOME', maxBackupScanEntries: 5000 })
  assert.equal(routes.length, 1, '应当注册一条前缀路由')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/session-purge/api')

  const server = createServer(async (req, res) => {
    if (!req.url.startsWith('/session-purge/api')) { res.statusCode = 404; res.end(); return }
    await routes[0].handler(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/session-purge/api`

  const call = async (action, body, headers = {}) => {
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, doc: await res.json() }
  }

  const inspected = await call('inspect', { sessionId: TARGET, cwd: CWD })
  assert.equal(inspected.status, 200)
  assert.equal(inspected.doc.value.exists, true)
  assert.equal(inspected.doc.value.liveAgent, true, 'inspect 应报告仍有 live Agent')
  console.log('  ok  inspect 找到会话目录，并报告 liveAgent=true')

  const crossSite = await call('purge', { sessionId: TARGET }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSite.status, 403)
  assert.equal(await exists(join(projectDir, TARGET)), true, '跨站请求不得删除任何东西')
  console.log('  ok  跨站请求被 403 拒绝，数据未动')

  const getOnly = await fetch(`${base}/purge`, { method: 'GET' })
  assert.equal(getOnly.status, 405)
  console.log('  ok  GET 被 405 拒绝')

  const badId = await call('purge', { sessionId: '../../../etc' })
  assert.equal(badId.status, 500)
  assert.match(badId.doc.error, /非法的会话 id/)
  console.log('  ok  非法 id 被拒绝')

  const purged = await call('purge', { sessionId: TARGET, cwd: CWD })
  const value = purged.doc.value
  assert.equal(purged.status, 200)
  assert.equal(value.ok, true)
  assert.deepEqual(value.failures, [])
  assert.equal(value.registry, 'registry')
  assert.equal(value.liveAgent, true)
  assert.equal(value.removed.sessionDirs.length, 1)
  assert.equal(value.removed.backups.length, 1)
  console.log('  ok  purge 成功，统计：', JSON.stringify({
    dirs: value.removed.sessionDirs.length,
    cache: value.removed.projectionCache.length,
    registry: value.removed.workspaceIndex.length,
    backup: value.removed.backups.length,
    liveAgent: value.liveAgent,
  }))

  assert.deepEqual(registry.calls, [['unarchive', TARGET], ['unpin', TARGET]])
  console.log('  ok  归档/置顶走官方注册表，未裸改 JSON')

  assert.equal(await exists(join(projectDir, TARGET)), false)
  assert.equal(await exists(join(projectDir, KEEP, 'session.v4.jsonl.zstd')), true)
  assert.equal(await exists(join(backup, TARGET)), false)
  assert.equal(await exists(join(backup, 'workspace.json')), true)
  // 走注册表时不应动 workspace.json（内存状态才是权威）
  const ws = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
  assert.deepEqual(ws.global.archivedSessionIds, [TARGET])
  console.log('  ok  文件系统状态正确，邻居与 workspace.json 完好')

  server.close()
  await rm(home, { recursive: true, force: true })
  console.log('\ne2e 全部通过')
}

main().catch((error) => {
  console.error('\n失败：', error)
  process.exit(1)
})

/**
 * Host half of dsh-session-purge.
 *
 * 在宿主 Web 服务上挂一条前缀路由 `/session-purge/api`，并在删除完成时
 * 用**官方服务**收尾，让侧边栏无需重启就能消失：
 *
 *   A. 文件层（本文件直接做）
 *      1. `<home>/sessions/<项目目录>/<session-id>/`          会话日志目录
 *      2. `<home>/storages/session_projcache/sessions/…`      投影缓存里引用该 id 的文件
 *      3. `<home>/deleted-sessions-backup…/`                  本地备份副本
 *
 *   B. 登记层（走 workspaceRegistry，不裸改 JSON）
 *      4. `unarchiveSession(id)` / `unpinSession(id)`：把 id 从注册表内存状态里
 *         摘掉。直接改 workspace.json 是错的——注册表把 state 缓存在内存，
 *         下一次 setState 会把整块写回去，我的磁盘改动会被覆盖、id 复活。
 *      5. `workspace/<id>` 的 sessionIds 由 `candidateMatches` 投影：会话文件
 *         不在后，`refreshWorkspaceIndex` 那次读写会把它从记录里剔除。
 *
 *   C. 内存层
 *      6. 若该会话仍有 live Agent，`agent.ctx.sessions` 的 detach 会在 dispose
 *         时发出 `session/disposed` → `api-session/removed` → 前端列表删行。
 *         插件拿不到 detach 句柄，所以这里只做尽力而为：找不到就说找不到。
 *
 * 刻意不 import 任何 `@deepseek-ai/…` 包：profile 安装的插件解析不到这些裸模块。
 * 只用 node 内建模块 + `ctx.get(...)` 拿到的服务实例。
 */

import { existsSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'sessionPurge'

/** HTTP 前缀：页面菜单项走这里。 */
const API_PREFIX = '/session-purge/api'

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024

export const DEFAULTS = {
  /** 总开关。 */
  enabled: true,
  /** 未显式给出 `--home` 时，从这个环境变量推断 DSH 数据根。 */
  homeEnv: 'DSH_HOME',
  /** 单次删除最多扫描多少个备份条目，防止误扫全盘。 */
  maxBackupScanEntries: 20000,
}

/** 会话 id 形状：`session-` + uuid。用来在拼路径前挡住一切怪输入。 */
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{8,64}$/

/**
 * 校验并补齐配置。
 * @param {Record<string, unknown> | undefined} raw - profile 下发的 config。
 * @returns {typeof DEFAULTS & Record<string, unknown>} 补全后的配置。
 */
function normalizeConfig(raw) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  if (typeof merged.enabled !== 'boolean') throw new TypeError('session-purge: config.enabled 必须是 boolean')
  if (typeof merged.homeEnv !== 'string' || merged.homeEnv.length === 0) {
    throw new TypeError('session-purge: config.homeEnv 必须是非空字符串')
  }
  if (!Number.isSafeInteger(merged.maxBackupScanEntries) || merged.maxBackupScanEntries < 100) {
    throw new TypeError('session-purge: config.maxBackupScanEntries 必须是不小于 100 的整数')
  }
  return merged
}

/**
 * 解析 DSH 数据根。`--home` 命令行参数优先，其次环境变量，最后 `~/.dsh`。
 * @param {typeof DEFAULTS} config - 已校验的配置。
 * @returns {string} 绝对路径。
 */
export function resolveHome(config) {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i].startsWith('--home=') ? argv[i].slice('--home='.length)
      : argv[i] === '--home' ? argv[i + 1] : undefined
    if (typeof value === 'string' && value.length > 0) return resolve(value)
  }
  const fromEnv = process.env[config.homeEnv]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * 与 DSH 会话存储一致的路径分段编码：`/`、`\`、`:` 折叠成一个 `-`，
 * 其它非 `[A-Za-z0-9._-]` 字符写成 `~` + 四位大写十六进制码点。
 * 与 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey` 同形。
 * @param {string} cwd - 会话的工作目录。
 * @returns {string} 项目目录名，形如 `--F-ASNIA-Desktop-Workspace1--`。
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('无法编码空的工作目录')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * 判断 child 是否严格位于 parent 之内（不接受 parent 本身）。
 * @param {string} parent - 绝对路径。
 * @param {string} child - 绝对路径。
 * @returns {boolean} 是否在内部。
 */
function isStrictlyInside(parent, child) {
  const rel = relative(parent, child)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 判断路径是否为已存在的目录。
 * @param {string} dir - 目标路径。
 * @returns {Promise<boolean>} 是否存在且为目录。
 */
async function directoryExists(dir) {
  try { return (await stat(dir)).isDirectory() } catch { return false }
}

/**
 * 在 `sessions/` 下定位会话目录：先按 cwd 精确推导，再退回按 id 全树查找。
 * @param {string} sessionsRoot - `<home>/sessions`。
 * @param {string} sessionId - 目标会话 id。
 * @param {string | undefined} cwd - 宿主给出的会话工作目录。
 * @returns {Promise<string[]>} 命中的会话目录绝对路径（通常 0 或 1 个）。
 */
export async function locateSessionDirs(sessionsRoot, sessionId, cwd) {
  const found = new Set()
  if (!SESSION_ID_RE.test(sessionId)) return []
  if (typeof cwd === 'string' && cwd.length > 0) {
    const guess = join(sessionsRoot, projectKey(cwd), sessionId)
    if (existsSync(guess)) found.add(guess)
  }
  if (!existsSync(sessionsRoot)) return [...found]
  let projects
  try { projects = await readdir(sessionsRoot, { withFileTypes: true }) } catch { return [...found] }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(sessionsRoot, project.name, sessionId)
    if (existsSync(candidate)) found.add(candidate)
  }
  return [...found]
}

/**
 * 判断一个已解析的 JSON 文档是否提到该会话 id。
 * @param {unknown} doc - 已解析的 JSON。
 * @param {string} sessionId - 会话 id。
 * @param {number} depth - 递归深度保护。
 * @returns {boolean} 是否相关。
 */
function mentions(doc, sessionId, depth = 0) {
  if (depth > 8) return false
  if (typeof doc === 'string') return doc === sessionId
  if (doc === null || typeof doc !== 'object') return false
  if (Array.isArray(doc)) return doc.some((item) => mentions(item, sessionId, depth + 1))
  for (const [key, value] of Object.entries(doc)) {
    if (key.includes(sessionId)) return true
    if (typeof value === 'string' && value === sessionId) return true
    if (value !== null && typeof value === 'object' && mentions(value, sessionId, depth + 1)) return true
  }
  return false
}

/**
 * 删除 `storages/session_projcache/sessions/` 中引用该会话的缓存文件。
 * 缓存是纯派生数据，删掉只会让下一次打开多回放一段日志尾巴。
 * @param {string} home - DSH 数据根。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<string[]>} 已删除的文件路径。
 */
async function purgeProjectionCache(home, sessionId) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  if (!existsSync(dir)) return []
  const removed = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(dir, entry.name)
    if (entry.name.includes(sessionId)) {
      await rm(path, { force: true })
      removed.push(path)
      continue
    }
    let text
    try { text = await readFile(path, 'utf8') } catch { continue }
    if (!text.includes(sessionId)) continue
    let doc
    try { doc = JSON.parse(text) } catch { continue }
    if (!mentions(doc, sessionId)) continue
    await rm(path, { force: true })
    removed.push(path)
  }
  return removed
}

/**
 * 从工作区索引里摘掉该会话的置顶/归档引用。
 *
 * 注意：这只是在**注册表不可达时**的兜底。正常路径先走
 * `workspaceRegistry.unarchiveSession/unpinSession`，否则注册表内存里的
 * state 会在下一次 setState 时把整块写回来、覆盖这里的改动。
 * @param {string} home - DSH 数据根。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<{changed: boolean; removedFrom: string[]}>} 改动结果。
 */
async function purgeWorkspaceIndexFile(home, sessionId) {
  const path = join(home, 'storages', 'workspace.json')
  if (!existsSync(path)) return { changed: false, removedFrom: [] }
  let doc
  try {
    doc = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`workspace.json 无法解析，已跳过索引清理：${error instanceof Error ? error.message : String(error)}`)
  }
  const removedFrom = []
  let changed = false
  const global = doc?.global && typeof doc.global === 'object' ? doc.global : {}
  for (const key of ['pinnedSessionIds', 'archivedSessionIds']) {
    const list = global[key]
    if (!Array.isArray(list)) continue
    const next = list.filter((id) => id !== sessionId)
    if (next.length !== list.length) {
      global[key] = next
      changed = true
      removedFrom.push(`global.${key}`)
    }
  }
  const workspaces = doc?.tables?.workspaces
  if (workspaces && typeof workspaces === 'object') {
    for (const [workspaceId, workspace] of Object.entries(workspaces)) {
      const list = workspace?.sessionIds
      if (!Array.isArray(list)) continue
      const next = list.filter((id) => id !== sessionId)
      if (next.length === list.length) continue
      workspace.sessionIds = next
      changed = true
      removedFrom.push(`workspace:${workspaceId}`)
    }
  }
  if (!changed) return { changed: false, removedFrom }
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
  return { changed: true, removedFrom }
}

/**
 * 广度优先收集名字里含该会话 id 的文件或目录，限制扫描规模。
 * @param {string} root - 扫描起点。
 * @param {string} sessionId - 会话 id。
 * @param {number} budget - 最多查看多少个条目。
 * @returns {Promise<string[]>} 命中的路径。
 */
async function collectByIdName(root, sessionId, budget) {
  const hits = []
  const queue = [root]
  let seen = 0
  while (queue.length > 0 && seen < budget) {
    const dir = queue.shift()
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++seen > budget) break
      const path = join(dir, entry.name)
      if (entry.name.includes(sessionId)) { hits.push(path); continue }
      if (entry.isDirectory()) queue.push(path)
    }
  }
  return hits
}

/**
 * 清理本地备份：`deleted-sessions-backup-*` 目录下的副本。
 * 所有删除目标都必须严格位于某个备份目录内部。
 * @param {string} home - DSH 数据根。
 * @param {string} sessionId - 会话 id。
 * @param {number} budget - 扫描上限。
 * @returns {Promise<string[]>} 已删除的路径。
 */
async function purgeBackups(home, sessionId, budget) {
  if (!existsSync(home)) return []
  const removed = []
  let entries
  try { entries = await readdir(home, { withFileTypes: true }) } catch { return [] }
  const backups = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('deleted-sessions-backup'))
    .map((entry) => resolve(join(home, entry.name)))
  for (const dir of backups) {
    for (const hit of await collectByIdName(dir, sessionId, budget)) {
      const target = resolve(hit)
      if (!isStrictlyInside(dir, target)) continue
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    }
  }
  return removed
}

/**
 * 用官方注册表把该会话从归档/置顶集合里摘掉。
 *
 * `unarchiveSession` 不要求会话仍存在（它只做集合删除），正是这里需要的语义。
 * @param {object | undefined} registry - `ctx.workspaceRegistry`。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<{via: string, ok: boolean, error?: string}>} 结果。
 */
async function detachRegistry(registry, sessionId) {
  if (registry === undefined || registry === null) {
    return { via: 'unavailable', ok: false, error: '宿主未提供 workspaceRegistry' }
  }
  const done = []
  const errors = []
  const attempt = async (name, fn) => {
    if (typeof fn !== 'function') return
    try { await fn.call(registry) ; done.push(name) } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await attempt('unarchiveSession', () => registry.unarchiveSession(sessionId))
  await attempt('unpinSession', () => registry.unpinSession(sessionId))
  if (done.length === 0 && errors.length === 0) {
    return { via: 'unavailable', ok: false, error: '注册表没有 unarchive/unpin 接口' }
  }
  return {
    via: 'registry',
    ok: errors.length === 0,
    ...(done.length > 0 ? { applied: done } : {}),
    ...(errors.length > 0 ? { error: errors.join('；') } : {}),
  }
}

/**
 * 判断该会话是否还有 live Agent 挂在内存里。
 * 有的话删除文件本身不报错，但宿主列表要等它 dispose 才会推 remove 帧；
 * 这里如实回报，让前端知道该不该立刻手动剔除。
 * @param {object | undefined} agents - `ctx.agents`。
 * @param {string} sessionId - 会话 id。
 * @returns {boolean} 是否仍有 live Agent。
 */
function hasLiveAgent(agents, sessionId) {
  try { return agents?.get?.(sessionId) !== undefined } catch { return false }
}

/**
 * 完整删除一个会话。每一步独立回报，任何一步失败都会出现在 `failures` 里。
 * @param {object} request - 删除请求。
 * @param {string} request.home - DSH 数据根。
 * @param {string} request.sessionId - 会话 id。
 * @param {string} [request.cwd] - 会话工作目录。
 * @param {number} request.maxBackupScanEntries - 备份扫描上限。
 * @param {object} [request.services] - 宿主服务（workspaceRegistry / agents）。
 * @returns {Promise<object>} 结果摘要。
 */
export async function purgeSession({
  home, sessionId, cwd, maxBackupScanEntries, services = {},
}) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new TypeError(`非法的会话 id：${String(sessionId)}`)
  }
  if (!isAbsolute(home)) throw new TypeError(`DSH 数据根必须是绝对路径：${home}`)
  const sessionsRoot = resolve(join(home, 'sessions'))
  const removed = { sessionDirs: [], projectionCache: [], backups: [], workspaceIndex: [] }
  const failures = []

  // 先看内存里还有没有 live Agent：这决定了前端要不要自己剔除列表行。
  const liveAgent = hasLiveAgent(services.agents, sessionId)

  // 1) 会话日志目录
  for (const dir of await locateSessionDirs(sessionsRoot, sessionId, cwd)) {
    const target = resolve(dir)
    if (!isStrictlyInside(sessionsRoot, target)) {
      failures.push(`拒绝删除 sessions 之外的路径：${target}`)
      continue
    }
    if (!await directoryExists(target)) continue
    try {
      await rm(target, { recursive: true, force: true })
      removed.sessionDirs.push(target)
    } catch (error) {
      failures.push(`会话目录删除失败 ${target}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 2) 投影缓存
  try {
    removed.projectionCache = await purgeProjectionCache(home, sessionId)
  } catch (error) {
    failures.push(`投影缓存清理失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 3) 登记层：优先官方注册表，不可达才退回直接改文件
  const registry = await detachRegistry(services.workspaceRegistry, sessionId)
  if (registry.ok) {
    removed.workspaceIndex = registry.applied ?? []
  } else {
    try {
      const result = await purgeWorkspaceIndexFile(home, sessionId)
      removed.workspaceIndex = result.removedFrom
    } catch (error) {
      failures.push(`工作区索引清理失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 注册表不可用属于设计内降级（文件层已兜住）；只有它主动抛错才算失败。
    if (registry.via === 'registry') {
      failures.push(`注册表清理失败（已退回文件层）：${registry.error}`)
    }
  }

  // 4) 本地备份
  try {
    removed.backups = await purgeBackups(home, sessionId, maxBackupScanEntries)
  } catch (error) {
    failures.push(`备份清理失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const didRemove = removed.sessionDirs.length > 0
    || removed.projectionCache.length > 0
    || removed.backups.length > 0
    || removed.workspaceIndex.length > 0
  return {
    ok: failures.length === 0,
    sessionId,
    removed,
    failures,
    didRemove,
    liveAgent,
    registry: registry.via,
  }
}

// ---------------------------------------------------------------- HTTP helpers

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - 状态码。
 * @param {unknown} payload - 响应体。
 */
function respond(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 自定义前缀路由不在 harness 的 /api 信任栅栏后面，必须自己挡跨站请求。 */
function crossSiteRequest(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

/**
 * 读取并解析 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, unknown>>} 解析结果。
 */
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') { resolvePromise({}); return }
      try { resolvePromise(JSON.parse(raw)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {Record<string, unknown>} rawConfig - profile 配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  const home = resolveHome(config)

  /** 服务延迟读取：插件启动时这些服务可能还没就绪。 */
  const services = () => ({
    workspaceRegistry: ctx.get('workspaceRegistry'),
    agents: ctx.get('agents'),
    sessions: ctx.get('sessions'),
    sessionQuery: ctx.get('sessionQuery'),
  })

  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const method = new URL(req.url ?? '/', 'http://localhost').pathname.slice(`${API_PREFIX}/`.length)
        try {
          if (crossSiteRequest(req)) { respond(res, 403, { ok: false, error: 'cross-site' }); return }
          if (req.method !== 'POST') { respond(res, 405, { ok: false, error: 'post-only' }); return }
          const body = await readBody(req)

          if (method === 'inspect') {
            const sessionId = String(body.sessionId ?? '')
            const dirs = await locateSessionDirs(join(home, 'sessions'), sessionId, body.cwd)
            const live = services()
            respond(res, 200, {
              ok: true,
              value: {
                home,
                exists: dirs.length > 0,
                dirs,
                liveAgent: hasLiveAgent(live.agents, sessionId),
              },
            })
            return
          }

          if (method === 'purge') {
            const result = await purgeSession({
              home,
              sessionId: String(body.sessionId ?? ''),
              cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
              maxBackupScanEntries: config.maxBackupScanEntries,
              services: services(),
            })
            respond(res, 200, { ok: true, value: { ...result, home } })
            return
          }

          respond(res, 404, { ok: false, error: `未知操作：${method}` })
        } catch (error) {
          respond(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'session-purge.http-route')
  })

  ctx.logger?.info?.(`session-purge: 就绪，DSH 数据根 ${home}`)
}

/** 供测试直接引用的内部工具。 */
export const internals = {
  normalizeConfig, locateSessionDirs, mentions, purgeWorkspaceIndexFile, purgeProjectionCache,
  purgeBackups, projectKey, isStrictlyInside, detachRegistry, hasLiveAgent, SESSION_ID_RE,
}

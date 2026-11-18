/**
 * 用真实数据复现「归档会话删除卡死」。
 *
 * 目标会话从 workspace.json 读取，不硬编码。
 * 只模拟 Host 半个包的 purge 链路（registry 部分用桩，因为真实 registry
 * 在 DSH 进程里，外部拿不到），重点测「读取 sessionIds 投影 + detachSession」
 * 在归档会话上的行为。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const home = join(homedir(), '.dsh')
const wsPath = join(home, 'storages', 'workspace.json')

const doc = JSON.parse(await readFile(wsPath, 'utf8'))
const archived = doc.global.archivedSessionIds ?? []
console.log('归档会话:', JSON.stringify(archived))

const workspaces = Object.entries(doc.tables.workspaces)
console.log('工作区:')
for (const [id, w] of workspaces) {
  console.log(`  ${id}`)
  console.log(`    path: ${w.path}`)
  console.log(`    sessionIds: ${JSON.stringify(w.sessionIds)}`)
  for (const sid of w.sessionIds) {
    const inArchive = archived.includes(sid)
    console.log(`      ${sid}  归档=${inArchive}`)
  }
}

// 模拟 Workspace.sessionIds 的投影：candidateMatches 依赖 sessionPaths
// 这里用「磁盘目录是否存在」近似 candidateMatches 的判断依据
import { stat } from 'node:fs/promises'
const { projectKey } = await import('./index.js')

console.log('\n=== 投影模拟（文件存在=候选有效）===')
for (const [id, w] of workspaces) {
  const dir = join(home, 'sessions', projectKey(w.path))
  const visible = []
  const hidden = []
  for (const sid of w.sessionIds) {
    const exists = await stat(join(dir, sid)).then(() => true, () => false)
    ;(exists ? visible : hidden).push(sid)
  }
  console.log(`  ${id}`)
  console.log(`    可见: ${JSON.stringify(visible)}`)
  console.log(`    隐藏: ${JSON.stringify(hidden)}`)
}

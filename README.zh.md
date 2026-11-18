# dsh-delete-sidebar-session · 会话彻底删除

[English](README.md) | 简体中文

在 DeepSeek Harness 侧边栏**右键会话 →「彻底删除会话」**，一次清干净，**删完当场消失，不用重启**。

DSH 自带只有「归档」：会话从侧边栏隐藏，文件仍在磁盘上。手动删文件也有坑——注册表把状态缓存在内存里，下一次 `setState` 会把 `workspace.json` 整块写回去，被删的 id 就「复活」了。本插件按层处理，避开这个坑。

## 删什么

### A. 文件层（直接删）

| # | 目标 |
|---|------|
| 1 | `~/.dsh/sessions/<项目目录>/<session-id>/` |
| 2 | `~/.dsh/storages/session_projcache/sessions/` 中引用该 id 的缓存 |
| 3 | `~/.dsh/deleted-sessions-backup…/` 下的备份副本 |

### B. 登记层（走官方 API，不裸改 JSON）

| # | 调用 | 作用 |
|---|------|------|
| 4 | `workspaceRegistry.unarchiveSession(id)` | 从归档集合移除（不要求会话仍存在） |
| 5 | `workspaceRegistry.unpinSession(id)` | 从置顶集合移除 |

`sessionIds` 是投影：会话文件不在后，注册表的 `candidateMatches` 会在下次读写时把它剔掉。**直接改 `workspace.json` 是错的**——内存 state 才是权威，磁盘改动会被覆盖。只有注册表完全不可达时才退回文件层兜底。

### C. 前端层（实时生效的关键）

| # | 动作 | 效果 |
|---|------|------|
| 6 | 登记 `suppressedSessions.add(id)` | **必须在任何 refresh 之前** |
| 7 | `sessions.handleSessionRemoved(id)` | 同步写 `summaries` + `markDirty`，这一行当场消失 |
| 8 | 清 localStorage 中 `*session-<id>*` 键 | 草稿、右栏布局、`dsh.sessions.current` 残留 |
| 9 | 当前会话被删时 `uiWorkspace.startSession(undefined, …)` | 退回「新会话」，不停在「会话不可用」死页面 |
| 10 | `refresh()` 立刻 / 300ms / 1200ms 各一次，**每次后重跑抑制** | 与磁盘对齐且不复活 |

#### 为什么必须有抑制表

`sessionQuery.listSessions()` 会把 `ctx.sessions.list()` 里所有 **live session 无条件合并进列表**：

```ts
for (const session of this._ctx.sessions.list()) {
  records.set(session.id, { header: …, live: true, persisted: durable !== undefined, … })
}
```

所以会话**文件删掉了，但 live 条目还在内存里**时，`refresh()` 的磁盘 baseline 会把它重新加回来。而 `handleSessionRemoved` 只写一条 remove mutation，`refreshList` 又是「基线 + 重放 mutations」，下一次 refresh 用新基线重建，live 条目又进来了 —— **光是"删完刷新"反而会让行复活**。

抑制表就是挡这一下的：每次列表重建后，重新对已删 id 调一次 `handleSessionRemoved`。

## 界面语言

菜单项与确认框都是中文（「彻底删除会话」/「彻底删除这个会话？」）。只有界面明确是英文时才显示英文。

判定顺序：**DSH 自己的 locale 服务** → `document.documentElement.lang` → `navigator.language` → 默认中文。

关键是第一位。只看 `navigator.language` 的话，「系统英文 + DSH 设成中文」会误判成英文，菜单就变英文了。现在读 `ctx.get('locale').getSnapshot().active`，与界面实际语言一致；每次渲染都重新判定。

## 用法

1. 侧边栏展开工作区，找到目标会话。
2. 悬停 →「…」菜单 → 最下方红色**「彻底删除会话」**。
3. 弹窗核对会话 ID 与被删目录，点「确认删除」。
4. 该行立即消失，右下角给出统计。

菜单 `order: 550`，排在「复制会话 ID」(450) 之后、「归档」(600) 之前。

## 运行中的会话

若 `running: true`，先 `workspaces.archiveSession(id, { stopActivity: true })` 停掉当前回合、释放写入句柄，再删文件。归档失败不阻塞清理，最终以 `purge` 结果为准。

## 安全边界

- 会话 id 必须匹配 `^session-[0-9a-fA-F-]{8,64}$`。
- 会话目录的删除目标必须**严格位于** `<home>/sessions/` 内。
- 备份清理只在 `<home>/deleted-sessions-backup…/` 内部，且只删名字含该 id 的条目。
- 备份扫描上限 `maxBackupScanEntries`（默认 20000），防止误扫全盘。
- 路由只收同源 POST，自带 `sec-fetch-site` / `Origin` 校验。
- 文件层写 `workspace.json` 时走「临时文件 + rename」原子写入。

## 安装

### 方式一：插件市场

在市场里搜索「会话彻底删除」或 `dsh-delete-sidebar-session` 即可。

### 方式二：手动

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-delete-sidebar-session
```

然后在 `package.json` 的 `dsh.profile.bundles` 里加一行 `"dsh-delete-sidebar-session"`，重启 DSH。

### 方式三：源码链接

```bash
ln -s /path/to/dsh-session-purge ~/.dsh/profiles/desktop/node_modules/dsh-delete-sidebar-session   # Windows 用 mklink /J
```

## 配置

```yaml
- insert:
    - id: session-purge
      name: 'dsh-delete-sidebar-session'
      config:
        enabled: true
        homeEnv: DSH_HOME
        maxBackupScanEntries: 20000
```

数据根解析：`--home` / `--home=` → `$DSH_HOME` → `~/.dsh`。

## 自测

```bash
node test.mjs          # 11 项：路径编码、越界拒绝、四类目标清理、注册表优先/降级、liveAgent、幂等、引用判定
node test-suppress.mjs # 6 项：先复现「refresh 后行复活」，再验证抑制表挡住它且不误伤邻居
node test-locale.mjs   # 8 项：语言探测优先级，含「系统英文 + DSH 中文」这个真实缺陷
node test-archived.mjs # 6 项：三处登记同时摘除、跨工作区、脏索引自愈、detach 缺失时如实报错
node test-timeout.mjs  # 7 项：确认框超时/取消/Esc/重复点击，含「refresh 挂住仍能收尾」
node e2e.mjs           # 6 项：真实 HTTP 路由、跨站 403、非法 id、注册表收尾、文件系统终态
```

## 三个踩过的坑（供改代码时参考）

### 1. 只清归档不清成员登记 → 删完卡死

宿主的 `Workspace.sessionIds` 是**成员登记**，与 `archivedSessionIds` **互相独立**。
只调 `unarchiveSession` 时，id 仍留在 `sessionIds` 里，而 `candidateMatches` 靠
`sessionPaths` 缓存判断有效性——文件删了缓存不失效，于是前端继续渲染这一行，
去等一个已经不存在的会话实例。

**必须三处一起摘**：`detachSession` / `unarchiveSession` / `unpinSession`。

### 2. 删完立刻 `refresh()` → 行复活，甚至挂住

`sessionQuery.listSessions()` 会把 `ctx.sessions.list()` 里所有 **live session
无条件合并进列表**。会话文件删了但 live 条目还在内存时，`refresh()` 用磁盘
baseline 重建，live 条目又进来了。

- 应对「复活」：抑制表，每次列表重建后重新调 `handleSessionRemoved`
- 应对「挂住」：**`refresh()` 必须有上界**（当前 8 秒）且失败可忽略——
  列表对齐只是收尾，删除本身在 Host 侧早已完成（实测约 60ms）

### 3. 确认框 `await onConfirm()` 无上界 → 用户被困住

按钮禁用后若 promise 永不 settle，用户既点不了取消也关不掉窗口。

现在的三重保险：`callHost` 用 `AbortController`（45 秒）、`onConfirm` 竞速超时、
**取消按钮永不禁用且 Esc 始终有效**。

## 已知限制

- **抑制表只活在本次页面会话里**。刷新页面后失效；届时宿主通常已 dispose 掉那些 live 条目，磁盘上也没了。
- 插件拿不到宿主 Session 的 dispose 句柄，**不会强行杀 live Agent**；只保证界面上立即消失。
- 全局会话搜索索引默认是 `:memory:`，无需清理；若配置成磁盘文件，需自行重启刷新。
- 网络不通时装不上新版本时，可本地 `npm pack` 后手动解包到 `node_modules`，
  再手写 `dependencies`，不必依赖 registry。

## 许可

MIT

# 安装说明

## 当前安装方式（已就位，改代码无需重装）

```
~/.dsh/profiles/desktop/node_modules/dsh-session-purge
    -> junction -> F:\ASNIA\Desktop\Workspace1\dsh-session-purge
```

- `~/.dsh/profiles/desktop/package.json`
  - `dependencies` 里有 `"dsh-session-purge": "link:F:\\ASNIA\\Desktop\\Workspace1\\dsh-session-purge"`
  - `dsh.profile.bundles` 末尾有 `"dsh-session-purge"`
- `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾有 `- id: session-purge` 配置块

原文件备份：`*.bak-20261118-204821`。

改完 `client.js` / `index.js` 后**重启一次 DSH** 才会加载新代码；
junction 指向源码目录，所以改完立刻重启就能生效，不用重新 link。

## 补丁顺序（关键）

DSH 的组合顺序是：**bundle 的 `cordis.patch.yml` 先，profile 根的 `cordis.patch.yml` 后**。

- bundle 里的 `- insert:` 负责**插入插件行**（id 必须唯一）
- profile 根里的 `- id: session-purge` 只**覆盖配置**，不会重复插入

如果两边都写 `insert`，会出现两份实例 → 两个 `/session-purge/api` 前缀路由 → 整棵插件树启动失败。
本仓库的 `cordis.patch.yml` 只在**单独打包发布**时才有意义；作为 profile 内联挂载时，
配置写在 profile 根即可。

## 卸载

1. 从 `dsh.profile.bundles` 删掉 `"dsh-session-purge"`
2. 删掉 `dependencies` 里那行 `link:...`
3. 删掉 `node_modules\dsh-session-purge` 这个 junction
4. 删掉 `cordis.patch.yml` 末尾的 `- id: session-purge` 配置块
5. 重启

## 排错

| 现象 | 检查 |
|------|------|
| 菜单里没有「彻底删除会话」 | 重启了吗？`bundles` 加了吗？浏览器控制台有无 `session-purge` 报错 |
| 点确认后提示「宿主未响应」 | Host 半边没加载；查 `/session-purge/api` 路由是否注册 |
| 删了但列表没消失 | 看结果里的「列表已实时移除 / 列表已重拉」；都没有说明 `ctx.get('sessions')` 为 undefined |
| `workspace.json` 里 id 复活 | 走了文件层兜底但注册表内存状态覆盖了；说明 `workspaceRegistry` 不可达 |

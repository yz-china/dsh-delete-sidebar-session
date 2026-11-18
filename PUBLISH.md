# 发布说明

本机没有 `git` / `npm` / `gh`，所以**推送与发布必须在你自己的环境里执行**。
下面每一步都是可直接复制的命令（已填好 `yz-china`）。

---

## 0. 前置检查

需要：Node ≥ 22、git、npm（或 pnpm）、GitHub 账号。npm 发布还需 `npm login`。

```bash
node -v && git --version && npm -v
```

---

## 1. 初始化仓库并首次提交

```bash
cd dsh-session-purge
git init -b main
git add -A
git commit -m "feat: dsh-session-purge v1.0.0 — 侧边栏右键彻底删除会话"
```

> 校验：`git log --oneline` 应看到一次提交；`git status` 应干净（`node_modules` 被忽略）。

先跑一遍测试再提交更稳妥：

```bash
node test.mjs && node test-suppress.mjs && node test-locale.mjs && node e2e.mjs
```

预期：11 + 6 + 8 项自测全过、e2e 全过。

---

## 2. 推到 GitHub

先建**空**仓库（不要勾 README / .gitignore / LICENSE，避免冲突），然后：

```bash
git remote add origin https://github.com/yz-china/dsh-delete-sidebar-session.git
git push -u origin main
```

`package.json` 里的 `repository` / `homepage` / `bugs` 已经指向 `yz-china`，无需再改。

---

## 3. 发布到 npm（插件市场默认用这个源）

```bash
npm login
npm publish --access public
```

> 校验：`npm view dsh-session-purge version` 应返回 `1.0.0`。

如果 `dsh-session-purge` 这个包名已被占用，改 `package.json` 的 `name`
（例如 `@yz-china/dsh-delete-sidebar-session`），并同步修改 `market-index.json` 里的
`name` 字段——两处必须完全一致。

### 想用 GitHub Release 的 tarball 而不是 npm？

在 `package.json` 的 `dsh` 里加：

```json
"install": {
  "preferred": "tarball",
  "tarball": "https://github.com/yz-china/dsh-delete-sidebar-session/releases/download/v1.0.0/dsh-session-purge-1.0.0.tgz",
  "git": "https://github.com/yz-china/dsh-delete-sidebar-session.git"
}
```

打 tarball 并发布：

```bash
npm pack
gh release create v1.0.0 dsh-session-purge-1.0.0.tgz --title "v1.0.0" --notes "首个版本"
```

---

## 4. 上线插件市场索引

市场**不自动抓 GitHub**，它读一个你自己托管的 `format: 1` JSON 索引。

### 4.1 只剩一处要改

| 字段 | 说明 |
|---|---|
| `publishTimestamp` | 换成真实发布时刻（Unix 秒），`date +%s` 可取 |

GitHub 用户名已填好 `yz-china`，`homepage` 与 `repository.url` 都指向
`https://github.com/yz-china/dsh-delete-sidebar-session`。

### 4.2 如果改用 git 来源而不是 npm

把 `versions[0].source` 换成：

```json
{ "type": "git", "url": "https://github.com/yz-china/dsh-delete-sidebar-session", "commit": "<40位小写十六进制SHA>" }
```

> `commit` 必须是**真实提交的完整 SHA**（`git rev-parse HEAD` 的输出）。
> 留占位符会被 DSH 官方校验器直接拒绝：
> `source.commit must be a lowercase 40-hex-digit commit SHA`。
> 这也是默认用 `{ "type": "npm" }` 的原因——不用钉 commit，改版本号即可。

### 4.3 校验索引

```bash
node -e "
const m = await import('@deepseek-ai/dsh-plugin-market-index');
const fs = await import('node:fs');
const raw = JSON.parse(fs.readFileSync('market-index.json','utf8'));
const idx = m.parseMarketIndex(raw, 'https://example.com/index.json');
console.log('OK:', idx.plugins.map(p => p.name + '@' + p.versions[0].version));
" --input-type=module
```

### 4.4 托管

索引必须是可公开访问的 **https** 地址，不带凭据和 `#` 片段，返回 JSON。

用 GitHub Pages 最省事：

```bash
mkdir -p docs && cp market-index.json docs/index.json
git add docs && git commit -m "chore: publish market index" && git push
```

然后：仓库 Settings → Pages → Source 选 `main` / `/docs`。

索引地址即：

```
https://yz-china.github.io/dsh-delete-sidebar-session/index.json
```

### 4.5 在 DSH 里添加索引

DSH → 插件市场 → 设置 → 索引源，粘贴上面的 URL。
之后就能搜到「会话彻底删除」并一键安装。

---

## 5. 版本升级流程

1. 改代码 → 跑测试
2. `npm version patch`（或 minor / major）
3. `npm publish`
4. `market-index.json` 里**新增**一个 version 条目（旧的保留，用户可回退），更新 `publishTimestamp`
5. 重新部署索引（`cp market-index.json docs/index.json && git commit && git push`）

---

## 6. 常见坑

| 现象 | 原因 |
|---|---|
| 市场里搜不到 | 索引 URL 不是 https；或 `versions` 为空；或 `name` 与 npm 包名不一致 |
| 安装失败 `not-a-bundle` | `package.json` 缺 `dsh.bundle.patch` |
| 装上但菜单没有 | 忘记把包名加进 `dsh.profile.bundles`，或没重启 |
| 索引校验报 commit 错 | git 来源的 `commit` 不是 40 位小写 SHA |
| 图标不显示 | `icon` 不是 svg/png/jpeg/webp，或超过 256 KiB |

---

## 7. Trusted Publishing（OIDC，推荐长期方案）

长期 token 会过期（bypass-2FA 的 GAT 在 2027-01 后逐步失效），OIDC 发布不需要任何 token。

### 7.1 前提

| 前提 | 说明 |
|---|---|
| 账号已开 2FA | npm 强制要求；不开则无法配置 |
| 包已发布过 | npm 不允许为不存在的包配置 trusted publisher |
| 网页 + 交互式 2FA | 该配置**没有 API**，GAT 也不能改这项 |

### 7.2 配置路径

```
npmjs.com → 你的包 → Settings 标签
  → Trusted publishing → Add trusted publisher
  → Provider: GitHub Actions
```

填三个字段（**提交后不可更改**，填错要删掉重建）：

| 字段 | 本包的值 |
|---|---|
| Repository owner | `yz-china` |
| Repository name | `dsh-delete-sidebar-session` |
| Workflow name | `release.yml`（只写文件名） |
| Environment | 留空 |

### 7.3 「允许操作」必须勾「直接发布」

默认只允许 `npm stage publish`。若不勾**直接发布**，CI 的 `npm publish` 会走
两阶段流程：先建 `0.0.0-stage` 占位包，然后卡住等人工批准——CI 里没人批准，
表现为发布失败（本包 1.0.0 就踩过这个坑）。

### 7.4 workflow 的三个必要改动

已完成，见 `.github/workflows/release.yml`：

1. `permissions.id-token: write` —— 否则 runner 无法签发 OIDC 令牌
2. **Node 24** 而不是 22 —— npm 10.x 在 publish 的 PUT 上不带 OIDC 认证头，
   registry 回 404/401
3. **从 `.npmrc` 删掉空的 `_authToken` 行** —— `setup-node` 会写入
   `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`，secret 不存在时值为空
   但**行还在**，npm 会认为要走 token 认证，从而跳过 OIDC 交换。这一条最隐蔽。

### 7.5 验证是否真的走了 OIDC

打 tag 后看 `publish-npm` 的日志：

- 出现 `尝试通过 Trusted Publishing (OIDC) 发布` → 走的是 OIDC ✅
- 出现 `使用 NPM_TOKEN secret 发布` → 还有 secret 没删，走的是 token
- 出现 `未配置 NPM_TOKEN secret，跳过 npm 发布` → **注意**：旧版 workflow 用
  `exit 0` 跳过，job 会显示成功但什么都没发。判断发布是否真的发生，要以
  registry 上的版本号为准，不能只看 job 状态。

### 7.6 验证通过后收紧访问策略

包设置页的「出版访问」可切到：

> 要求双因素认证并禁止绕过双步验证令牌（推荐）

切换后，带 `bypass_2fa` 的旧 GAT 立即失去发布能力，但 **OIDC 完全不受影响**。
所以务必先确认 OIDC 能发布，再收紧。

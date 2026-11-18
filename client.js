/**
 * Browser half of dsh-delete-sidebar-session.
 *
 * 只贡献一条界面：`sidebar.workspaces.session.menu.item` 插槽里的
 * 「彻底删除会话」菜单项。数据来自 Host 侧 `/session-purge/api` 前缀路由。
 *
 * 手写在 `__ModuleLoader__` 闭包格式里，所以本包不需要构建步骤。
 * `require()` 只用来拿平台种子（react）；弹层与提示都用原生 DOM 挂到 body，
 * 不依赖任何 `@deepseek-ai/…` 运行时包，避免装不上就崩。
 */

window.__ModuleLoader__.load({
  id: 'dsh-delete-sidebar-session',
  factory(require) {
    const React = require('react')

    const NS = 'session-purge'
    const API = '/session-purge/api'

    /** 单次删除的超时上限（毫秒）。超过即在弹窗里报错并恢复按钮，绝不无限等待。 */
    const TIMEOUT_MS = 45000

    const ZH = {
      menuLabel: '彻底删除会话',
      menuLabelRunning: '彻底删除会话（运行中）',
      confirmTitle: '彻底删除这个会话？',
      confirmBody: '会同时删除：会话日志目录、投影缓存条目、工作区索引里的登记、以及本地备份副本。删除后无法从 DSH 里恢复。',
      confirmId: '会话 ID',
      confirmDir: '会话目录',
      confirmNoDir: '未找到会话目录（索引或缓存里的残留仍会一并清理）',
      confirmRunning: '⚠ 这个会话正在运行：删除前会先归档以停掉当前回合，然后清空文件。',
      cancel: '取消',
      confirm: '确认删除',
      working: '删除中…',
      done: '已删除',
      partial: '部分失败',
      failed: '删除失败',
      timeout: '宿主响应超时，删除可能未完成',
    }
    const EN = {
      menuLabel: 'Delete session permanently',
      menuLabelRunning: 'Delete session permanently (running)',
      confirmTitle: 'Delete this session permanently?',
      confirmBody: 'This removes the session log directory, projection cache entries, the workspace index entry and local backup copies. It cannot be undone from DSH.',
      confirmId: 'Session id',
      confirmDir: 'Session directory',
      confirmNoDir: 'No session directory found (index or cache residue is still cleaned)',
      confirmRunning: '⚠ This session is running: it is archived first to stop the current turn, then the files are removed.',
      cancel: 'Cancel',
      confirm: 'Delete',
      working: 'Deleting…',
      done: 'Deleted',
      partial: 'Partly failed',
      failed: 'Delete failed',
      timeout: 'Host did not respond in time; the delete may not have completed',
    }

    const STYLE = `
.sp-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.44)}
.sp-card{width:min(540px,92vw);border-radius:14px;padding:20px 22px 16px;box-sizing:border-box;
  background:#ffffff;color:#1d1d1f;box-shadow:0 20px 56px rgba(0,0,0,.32);border:1px solid rgba(0,0,0,.08);
  font:13px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
@media (prefers-color-scheme:dark){
  .sp-card{background:#232326;color:#ececf1;border-color:rgba(255,255,255,.10)}
  .sp-kv dd{color:#d7d7de}
  .sp-btn{color:#ececf1;border-color:rgba(255,255,255,.22)}
}
.sp-title{margin:0 0 10px;font-size:16px;font-weight:600;line-height:1.4}
.sp-body{margin:0 0 14px;font-size:12.5px;opacity:.82}
.sp-warn{margin:0 0 12px;padding:9px 11px;border-radius:9px;font-size:12px;
  background:rgba(214,133,0,.14);color:#a8630a;border:1px solid rgba(214,133,0,.3)}
.sp-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0 0 14px;font-size:12px}
.sp-kv dt{opacity:.62;white-space:nowrap}
.sp-kv dd{margin:0;font-family:ui-monospace,Consolas,monospace;word-break:break-all;color:#40404a}
.sp-err{margin:0 0 12px;padding:9px 11px;border-radius:9px;font-size:12px;
  background:rgba(214,58,58,.13);color:#c23b3b;border:1px solid rgba(214,58,58,.28)}
.sp-actions{display:flex;justify-content:flex-end;gap:10px}
.sp-btn{appearance:none;border-radius:9px;padding:7px 16px;font-size:12.5px;cursor:pointer;
  border:1px solid rgba(0,0,0,.18);background:transparent;color:#1d1d1f;font-family:inherit}
.sp-btn:disabled{opacity:.5;cursor:default}
.sp-btn-danger{background:#d64545;border-color:#d64545;color:#fff}
.sp-btn-danger:hover:not(:disabled){background:#c33a3a}
.sp-toast{position:fixed;right:20px;bottom:20px;z-index:2147483000;max-width:360px;box-sizing:border-box;
  padding:11px 14px;border-radius:10px;font:12.5px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  background:#232326;color:#f2f2f5;box-shadow:0 12px 30px rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.12)}
.sp-toast-title{font-weight:600;margin-bottom:3px}
.sp-toast-detail{margin-top:4px;opacity:.76;font-family:ui-monospace,Consolas,monospace;word-break:break-all}
`

    /**
     * 读 DSH 实际生效的界面语言。
     *
     * 优先用 DSH 自己的 locale 服务（`ctx.get('locale')` → `getSnapshot().active`），
     * 那才是界面上真正生效的那一个。**不能**只看 `navigator.language`：
     * 系统是英文、但 DSH 被设成中文时，会误判成英文，菜单就变英文了。
     * @param {object} ctx - 客户端上下文。
     * @returns {string} 语言 id（如 `zh` / `en`），读不到返回空串。
     */
    function activeLocale(ctx) {
      try {
        const snapshot = ctx?.get?.('locale')?.getSnapshot?.()
        const id = typeof snapshot === 'string' ? snapshot : (snapshot?.active ?? snapshot?.locale ?? snapshot?.id)
        if (typeof id === 'string' && id.length > 0) return id
      } catch { /* 退回下面的探测 */ }
      try {
        const html = document?.documentElement?.lang
        if (typeof html === 'string' && html.length > 0) return html
      } catch { /* 忽略 */ }
      try {
        const nav = navigator?.language
        if (typeof nav === 'string' && nav.length > 0) return nav
      } catch { /* 忽略 */ }
      return ''
    }

    /**
     * 按界面语言选文案。只有明确是英文才用英文，其余一律中文。
     * @param {object} ctx - 客户端上下文。
     * @returns {typeof ZH} 文案表。
     */
    function pickLocale(ctx) {
      const id = activeLocale(ctx).toLowerCase()
      return id.startsWith('en') ? EN : ZH
    }

    /**
     * 调 Host 路由。
     * @param {string} action - `inspect` 或 `purge`。
     * @param {object} payload - 请求体。
     * @returns {Promise<any>} Host 返回的 value。
     */
    async function callHost(action, payload, timeoutMs = TIMEOUT_MS) {
      // AbortController 让挂住的请求能被真正中断，而不是只靠外层竞速把它当成失败。
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(`${API}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          signal: controller.signal,
          body: JSON.stringify(payload),
        })
        const text = await res.text()
        let doc = null
        try { doc = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
        if (!res.ok || doc === null) throw new Error(doc?.error ?? `HTTP ${res.status}`)
        if (doc.ok !== true) throw new Error(doc.error ?? 'unknown host failure')
        return doc.value
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error(`宿主响应超时（${Math.round(timeoutMs / 1000)}s）：${action}`)
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * 原生 DOM 弹层：不依赖 React 渲染树，侧边栏菜单一关它也在。
     * @param {typeof ZH} t - 文案。
     * @param {{sessionId: string, dirs: string[], exists: boolean, running: boolean, onConfirm: () => Promise<void>}} state - 展示状态。
     * @returns {Promise<boolean>} 是否确认删除。
     */
    function confirmDialog(t, state) {
      return new Promise((resolvePromise) => {
        const overlay = document.createElement('div')
        overlay.className = 'sp-overlay'

        const card = document.createElement('div')
        card.className = 'sp-card'
        card.setAttribute('role', 'dialog')
        card.setAttribute('aria-modal', 'true')

        const title = document.createElement('h2')
        title.className = 'sp-title'
        title.textContent = t.confirmTitle

        const body = document.createElement('p')
        body.className = 'sp-body'
        body.textContent = t.confirmBody

        card.append(title, body)

        if (state.running) {
          const warn = document.createElement('p')
          warn.className = 'sp-warn'
          warn.textContent = t.confirmRunning
          card.append(warn)
        }

        const list = document.createElement('dl')
        list.className = 'sp-kv'
        const addRow = (label, value) => {
          const dt = document.createElement('dt')
          dt.textContent = label
          const dd = document.createElement('dd')
          dd.textContent = value
          list.append(dt, dd)
        }
        addRow(t.confirmId, state.sessionId)
        addRow(t.confirmDir, state.exists && state.dirs.length > 0 ? state.dirs.join('\n') : t.confirmNoDir)
        card.append(list)

        const errorBox = document.createElement('p')
        errorBox.className = 'sp-err'
        errorBox.style.display = 'none'
        card.append(errorBox)

        const actions = document.createElement('div')
        actions.className = 'sp-actions'
        const cancelBtn = document.createElement('button')
        cancelBtn.type = 'button'
        cancelBtn.className = 'sp-btn'
        cancelBtn.textContent = t.cancel
        const confirmBtn = document.createElement('button')
        confirmBtn.type = 'button'
        confirmBtn.className = 'sp-btn sp-btn-danger'
        confirmBtn.textContent = t.confirm
        actions.append(cancelBtn, confirmBtn)
        card.append(actions)
        overlay.append(card)

        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          window.removeEventListener('keydown', onKey, true)
          overlay.remove()
          resolvePromise(value)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); finish(false) }
          if (event.key === 'Enter' && document.activeElement === confirmBtn) { event.preventDefault(); confirmBtn.click() }
        }
        window.addEventListener('keydown', onKey, true)
        overlay.addEventListener('mousedown', (event) => {
          if (event.target === overlay) finish(false)
        })
        // 取消按钮始终可用：即使删除流程挂住，也必须能关掉这个框。
        cancelBtn.addEventListener('click', () => finish(false))
        confirmBtn.addEventListener('click', () => {
          if (confirmBtn.disabled) return
          const run = async () => {
            confirmBtn.disabled = true
            cancelBtn.disabled = false          // 关键：不允许把用户困在弹窗里
            cancelBtn.textContent = t.cancel
            confirmBtn.textContent = t.working
            errorBox.style.display = 'none'

            // 超时保护：任何一步挂住（宿主无响应、事件循环被占）都会在 45 秒后结束，
            // 把错误显示在框内并恢复按钮，而不是永远停在「删除中…」。
            let timedOut = false
            const timer = setTimeout(() => { timedOut = true }, TIMEOUT_MS)

            try {
              await Promise.race([
                state.onConfirm(),
                new Promise((_, reject) => setTimeout(() => reject(new Error(t.timeout)), TIMEOUT_MS)),
              ])
              clearTimeout(timer)
              if (settled) return
              finish(true)
            } catch (failure) {
              clearTimeout(timer)
              if (settled) return
              confirmBtn.disabled = false
              cancelBtn.disabled = false
              confirmBtn.textContent = t.confirm
              const message = failure instanceof Error ? failure.message : String(failure)
              errorBox.textContent = timedOut ? `${message}（${TIMEOUT_MS / 1000}s）` : message
              errorBox.style.display = ''
            }
          }
          void run()
        })

        document.body.append(overlay)
        setTimeout(() => cancelBtn.focus(), 0)
      })
    }

    /**
     * 已删除会话的抑制表。
     *
     * 为什么必须要有它：宿主的 `sessionQuery.listSessions()` 会把
     * `ctx.sessions.list()` 里所有 **live session 无条件合并进列表**。
     * 会话文件删了，但那个 live 条目还在内存里，于是每次 refresh 都会把它
     * 「复活」到侧边栏。`handleSessionRemoved` 只是写一条 remove mutation，
     * 随后的 refresh 用磁盘 baseline 重建、再重放 mutations，live 条目又回来了。
     *
     * 所以删除成功后要把 id 记在这里，并在每次列表重建后把它剔掉。
     * 抑制只活在本次页面会话里，刷新页面即失效（届时宿主侧通常已 dispose）。
     */
    const suppressedSessions = new Set()

    /**
     * 从会话列表里剔除所有被抑制的 id。
     *
     * `sessions.handleSessionRemoved(id)` 会同步写 summaries 并 markDirty，
     * 所以这里对每个 id 调一次就能让侧边栏立刻少一行。
     * @param {object | undefined} sessions - `ctx.get('sessions')`。
     * @returns {number} 实际剔除的数量。
     */
    function enforceSuppression(sessions) {
      if (suppressedSessions.size === 0) return 0
      if (typeof sessions?.handleSessionRemoved !== 'function') return 0
      let evicted = 0
      for (const sessionId of suppressedSessions) {
        try { sessions.handleSessionRemoved(sessionId); evicted += 1 } catch { /* 下一个 */ }
      }
      return evicted
    }

    /**
     * 安装两个抑制触发器：
     * 1. 列表快照一变就检查，防止 refresh / 宿主推帧把已删行带回来；
     * 2. 定期补扫一次，兜住不触发订阅的边缘情况。
     * @param {object} ctx - 客户端插件上下文。
     * @returns {() => void} 卸载函数。
     */
    function installSuppression(ctx) {
      let stopped = false
      const sweep = () => {
        if (stopped) return
        enforceSuppression(ctx.get('sessions'))
      }
      let unsubscribe = null
      try {
        const sessions = ctx.get('sessions')
        // list 是 ObservableSnapshot：有 subscribe 就挂上，没有就退回轮询。
        if (typeof sessions?.list?.subscribe === 'function') {
          unsubscribe = sessions.list.subscribe(sweep)
        }
      } catch { /* 订阅失败就走轮询 */ }

      const timer = setInterval(sweep, 1500)
      return () => {
        stopped = true
        clearInterval(timer)
        try { unsubscribe?.() } catch { /* 忽略 */ }
      }
    }

    /**
     * 读当前打开的会话 id。
     *
     * `uiSession` 的 current 是 BindingSource（`getSnapshot()` 返回会话标识或 absent）。
     * 结构不确定，所以按几种常见形状依次探测，读不到就当「不知道」。
     * @param {object} ctx - 客户端插件上下文。
     * @returns {string | undefined} 当前会话 id。
     */
    function currentSessionId(ctx) {
      try {
        const uiSession = ctx.get('uiSession')
        const snapshot = uiSession?.current?.getSnapshot?.()
        if (typeof snapshot === 'string') return snapshot
        if (snapshot && typeof snapshot === 'object') {
          const id = snapshot.sessionId ?? snapshot.id ?? snapshot.value?.sessionId ?? snapshot.value?.id
          if (typeof id === 'string') return id
        }
      } catch { /* 读不到按未知处理 */ }
      try {
        // 兜底：前端持久化的「当前选中」。
        const raw = window.localStorage.getItem('dsh.sessions.current')
        if (typeof raw === 'string') {
          const parsed = JSON.parse(raw)
          if (typeof parsed?.sessionId === 'string') return parsed.sessionId
        }
      } catch { /* 同上 */ }
      return undefined
    }

    /**
     * 清掉浏览器侧关于这个会话的持久化残留。
     *
     * DSH 前端在 Local Storage 里按会话存草稿、右栏布局和「当前选中」，
     * 键名形如 `dsh.conversation.session-<id>`、`dsh.sidebar-right.v1.session-<id>`。
     * 不清的话，会话已经删了但草稿键还在——下次刷新时偶尔会把旧行「带回来」，
     * 或者点进新会话时冒出上一条的草稿。
     * @param {string} sessionId - 会话 id。
     * @returns {string[]} 被清掉的键名。
     */
    function clearClientResidue(sessionId) {
      const touched = []
      try {
        const store = window.localStorage
        for (let i = store.length - 1; i >= 0; i--) {
          const key = store.key(i)
          if (typeof key !== 'string' || !key.includes(sessionId)) continue
          store.removeItem(key)
          touched.push(key)
        }
      } catch { /* 存储不可用（隐私模式等）时忽略，不影响主流程 */ }

      // 「当前选中」如果还指着它，一并清掉，避免重启后尝试打开已删会话。
      try {
        const store = window.localStorage
        const currentKey = 'dsh.sessions.current'
        const raw = store.getItem(currentKey)
        if (typeof raw === 'string' && raw.includes(sessionId)) {
          store.setItem(currentKey, '{}')
          touched.push(currentKey)
        }
      } catch { /* 同上 */ }

      return touched
    }

    /**
     * 右下角轻提示。
     * @param {string} title - 标题。
     * @param {string} detail - 细节。
     * @param {number} hold - 停留毫秒。
     */
    function showToast(title, detail, hold = 5000) {
      const box = document.createElement('div')
      box.className = 'sp-toast'
      box.setAttribute('role', 'status')
      const head = document.createElement('div')
      head.className = 'sp-toast-title'
      head.textContent = title
      box.append(head)
      if (detail) {
        const line = document.createElement('div')
        line.className = 'sp-toast-detail'
        line.textContent = detail
        box.append(line)
      }
      document.body.append(box)
      setTimeout(() => box.remove(), hold)
    }

    /**
     * 安装插件。
     * @param {object} ctx - 客户端插件上下文。
     */
    function apply(ctx) {
      const style = document.createElement('style')
      style.textContent = STYLE
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'session-purge: styles')

      // 抑制扫描：列表一变就把已删会话再剔一次，挡住 refresh / 宿主推帧的复活。
      ctx.effect(() => installSuppression(ctx), 'session-purge: suppression')

      /**
       * 菜单行。注册期不读会话列表，点击时才读，避免把快照冻结在注册那一刻。
       * @param {object} props - 插槽注入的运行时属性。
       * @returns {any} 菜单行元素。
       */
      const MenuRow = (props) => {
        const { sessionId, displayTitle, useMenuOpenState } = props
        const state = useMenuOpenState()
        const setMenuOpen = state[1]

        // 每次渲染都重新判定语言：用户在设置里切了语言，菜单行立刻跟上。
        const rowText = pickLocale(ctx)

        // 菜单行显示「运行中」需要知道该会话是否在跑；这里只读一次快照。
        let rowRunning = false
        try {
          const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
          rowRunning = snapshot?.items?.find((item) => item.sessionId === sessionId)?.running === true
        } catch { /* 列表未就绪按未运行处理 */ }

        const onClick = () => {
          setMenuOpen(false)
          const run = async () => {
            // 打开确认框时再取一次，保证弹窗与当前界面语言一致。
            const dialogText = pickLocale(ctx)
            let entry = null
            try {
              const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
              entry = snapshot?.items?.find((item) => item.sessionId === sessionId) ?? null
            } catch { /* 列表未就绪时按未知处理 */ }
            const running = entry?.running === true

            let inspected = { exists: false, dirs: [] }
            try {
              inspected = await callHost('inspect', { sessionId, cwd: entry?.cwd })
            } catch { /* 只用于提示，失败不阻塞删除 */ }

            const ok = await confirmDialog(dialogText, {
              sessionId,
              exists: inspected?.exists === true,
              dirs: Array.isArray(inspected?.dirs) ? inspected.dirs : [],
              running,
              onConfirm: async () => {
                // 运行中的会话先归档，让宿主停掉当前回合并释放写入句柄。
                if (running) {
                  try {
                    await ctx.get('workspaces')?.archiveSession?.(sessionId, { stopActivity: true })
                  } catch { /* 归档失败不阻塞文件清理，结果以 purge 回报为准 */ }
                }
                const result = await callHost('purge', { sessionId, cwd: entry?.cwd })

                // —— 实时生效 ——
                // 1) 先登记抑制。必须在任何 refresh 之前：宿主列表会把 live session
                //    无条件合并回来，抑制表是唯一能挡住「删完又冒出来」的机制。
                suppressedSessions.add(sessionId)

                const sessions = ctx.get('sessions')
                // 2) 立刻把这一行从客户端列表里摘掉（同步写 summaries + markDirty）。
                let evicted = false
                try {
                  if (typeof sessions?.handleSessionRemoved === 'function') {
                    sessions.handleSessionRemoved(sessionId)
                    evicted = true
                  }
                } catch { /* 交给下面的抑制扫描 */ }

                // 3) 清掉浏览器侧持久化残留（草稿、右栏布局、当前选中）。
                const residue = clearClientResidue(sessionId)

                // 3.5) 如果删的就是当前打开的会话，先离开它再刷新。
                //      `startSession(undefined, …)` 在 workspace 导航不可用时走 clearMain()，
                //      把主视图退回「新会话」，避免停在「会话不可用」的死页面上。
                const wasCurrent = currentSessionId(ctx) === sessionId
                if (wasCurrent) {
                  try {
                    const nav = ctx.get('uiWorkspace')
                    if (typeof nav?.startSession === 'function') {
                      nav.startSession(undefined, { clearPreviousDraft: true })
                    }
                  } catch { /* 回落失败不影响删除结果 */ }
                }

                // 4) 与磁盘对齐。refresh 之后 live 条目可能被合并回来，
                //    所以每次 refresh 完都要再执行一遍抑制。
                const refresh = async () => {
                  try { await sessions?.refresh?.() } catch { /* 下次拉取会自愈 */ }
                  enforceSuppression(sessions)
                }
                await refresh()
                setTimeout(() => { void refresh() }, 300)
                setTimeout(() => { void refresh() }, 1200)

                const removed = result?.removed ?? {}
                const summary = [
                  `会话目录 ${removed.sessionDirs?.length ?? 0}`,
                  `缓存 ${removed.projectionCache?.length ?? 0}`,
                  `索引 ${removed.workspaceIndex?.length ?? 0}`,
                  `备份 ${removed.backups?.length ?? 0}`,
                  evicted ? '列表已实时移除' : '列表已重拉',
                  residue.length > 0 ? `前端残留 ${residue.length} 项` : '无前端残留',
                ].join(' · ')

                if (Array.isArray(result?.failures) && result.failures.length > 0) {
                  showToast(`${dialogText.partial}：${displayTitle || sessionId}`, result.failures.join('；'), 12000)
                } else {
                  showToast(`${dialogText.done}：${displayTitle || sessionId}`, summary)
                }
              },
            })
            if (!ok) return
          }
          void run().catch((error) => {
            showToast(`${pickLocale(ctx).failed}：${displayTitle || sessionId}`,
              error instanceof Error ? error.message : String(error), 12000)
          })
        }

        return React.createElement('button', {
          type: 'button',
          role: 'menuitem',
          title: sessionId,
          style: {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 0,
            color: '#d64545',
            font: 'inherit',
            padding: '6px 12px',
            cursor: 'pointer',
          },
          onClick,
        }, rowRunning ? rowText.menuLabelRunning : rowText.menuLabel)
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
        { name: 'sidebar.workspaces.session.menu.item', id: NS, order: 550 },
        MenuRow,
      ))
    }

    const exported = {}
    exported.inject = ['slots']
    exported.apply = apply
    return exported
  },
})

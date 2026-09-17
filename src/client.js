// dsh-session-trash — 客户端（浏览器端）。
//
// 打包格式（client-modules 协议）：经典脚本，通过 window.__ModuleLoader__.load({id, factory})
// 注册工厂；factory 拿到 require 并返回插件导出。id 必须等于包名。
// 只用 React.createElement，不引入任何外部资源，也不访问任何外部域名：
// 所有请求都是本机同源相对路径 /__dsh-session-trash/*。
//
// 界面位置：设置 → 「会话与回收站」（settings.section，官方支持的入口）。
// 不往侧栏会话行菜单里注入 DOM —— 那是官方 API 的缺口，靠 MutationObserver 打补丁既脆又危险。

window.__ModuleLoader__.load({
  id: 'dsh-session-trash',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const Modal = primitives.Modal

    const NS = 'session-trash'
    const ROUTE = '/__dsh-session-trash'

    // --- 文案（中英双语，跟随 DSH 语言；服务不可用时按浏览器语言兜底）----------------

    const dict = {
      zh: {
        nav: '会话与回收站',
        title: '会话与回收站',
        intro: '删除的会话会移到本机回收站（{root}），保留 {days} 天，之后自动彻底删除。删除不联网，全部在本机完成。',
        refresh: '刷新',
        sweep: '清理过期条目',
        loading: '读取中…',
        error: '出错了：{error}',
        sessionsTitle: '会话（{total} 个，可删除 {deletable} 个）',
        trashTitle: '回收站（{count} 个，{size}）',
        trashEmpty: '回收站是空的。',
        colSession: '会话',
        colWorkspace: '工作区',
        colFlags: '状态',
        colTime: '时间',
        labelCreated: '创建',
        labelUpdated: '最近',
        colActions: '操作',
        colDeleted: '删除时间',
        colRemain: '剩余',
        untitled: '未命名会话',
        flagRunning: '运行中',
        flagOpen: '打开中',
        flagOk: '可删除',
        flagBroken: '条目异常',
        delete: '删除到回收站',
        restore: '恢复',
        purge: '彻底删除',
        days: '{n} 天',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟前',
        hoursAgo: '{n} 小时前',
        daysAgo: '{n} 天前',
        confirmDeleteTitle: '删除会话',
        confirmDeleteDesc: '把 {n} 个会话移进本机回收站，{days} 天内都可以恢复；超过保留期会自动彻底删除。',
        confirmPurgeTitle: '彻底删除',
        confirmPurgeDesc: '把回收站里的 {n} 个条目从磁盘上永久删除，**无法恢复**。',
        ackDelete: '我确认把这些会话移入回收站',
        ackPurge: '我确认永久删除，且无法恢复',
        cancel: '取消',
        confirm: '确认',
        busy: '处理中…',
        resultOk: '完成',
        doneDeleted: '已移入回收站：{n} 个',
        doneRestored: '已恢复：{n} 个',
        donePurged: '已彻底删除：{n} 个',
        partial: '部分失败：',
        needReload: '恢复后如未立刻出现在列表，刷新页面即可。',
      },
      en: {
        nav: 'Sessions & Trash',
        title: 'Sessions & trash',
        intro: 'Deleted sessions move to a local trash folder ({root}) and are kept for {days} days, then removed automatically. Everything happens on this machine — no network.',
        refresh: 'Refresh',
        sweep: 'Purge expired',
        loading: 'Loading…',
        error: 'Failed: {error}',
        sessionsTitle: 'Sessions ({total}, {deletable} deletable)',
        trashTitle: 'Trash ({count}, {size})',
        trashEmpty: 'Trash is empty.',
        colSession: 'Session',
        colWorkspace: 'Workspace',
        colFlags: 'State',
        colTime: 'Time',
        labelCreated: 'created',
        labelUpdated: 'last',
        colActions: 'Actions',
        colDeleted: 'Deleted',
        colRemain: 'Kept for',
        untitled: 'Untitled session',
        flagRunning: 'running',
        flagOpen: 'open',
        flagOk: 'deletable',
        flagBroken: 'broken entry',
        delete: 'Move to trash',
        restore: 'Restore',
        purge: 'Delete forever',
        days: '{n} d',
        justNow: 'just now',
        minutesAgo: '{n} min ago',
        hoursAgo: '{n} h ago',
        daysAgo: '{n} d ago',
        confirmDeleteTitle: 'Delete session',
        confirmDeleteDesc: 'Move {n} session(s) to the local trash. They can be restored within {days} days; after that they are removed automatically.',
        confirmPurgeTitle: 'Delete forever',
        confirmPurgeDesc: 'Permanently remove {n} trash entr(ies) from disk. This **cannot** be undone.',
        ackDelete: 'I understand these sessions move to the trash',
        ackPurge: 'I understand this is permanent and cannot be undone',
        cancel: 'Cancel',
        confirm: 'Confirm',
        busy: 'Working…',
        resultOk: 'Done',
        doneDeleted: 'Moved to trash: {n}',
        doneRestored: 'Restored: {n}',
        donePurged: 'Permanently deleted: {n}',
        partial: 'Some failed: ',
        needReload: 'If a restored session does not show up right away, refresh the page.',
      },
    }

    function langFallback() {
      try {
        const tags = (navigator.languages || []).concat([navigator.language])
        for (const tag of tags) {
          const primary = String(tag || '').toLowerCase().split('-')[0]
          if (primary === 'zh') return 'zh'
          if (primary === 'en') return 'en'
        }
      } catch {
        /* navigator 不可用 */
      }
      return 'zh'
    }

    let localeService = null

    function t(key, params) {
      let text
      if (localeService && typeof localeService.translate === 'function') {
        const fromService = localeService.translate(NS, key)
        if (typeof fromService === 'string' && fromService !== key) text = fromService
      }
      if (text === undefined) {
        const table = dict[langFallback()] || dict.zh
        text = table[key] !== undefined ? table[key] : dict.zh[key] !== undefined ? dict.zh[key] : key
      }
      if (params) {
        for (const name of Object.keys(params)) {
          text = text.split(`{${name}}`).join(String(params[name]))
        }
      }
      return text
    }

    function fmtSize(bytes) {
      if (!bytes || bytes < 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
    }

    function fmtAgo(ms) {
      if (!ms) return '—'
      const diff = Date.now() - ms
      if (diff < 60 * 1000) return t('justNow')
      if (diff < 3600 * 1000) return t('minutesAgo', { n: Math.floor(diff / 60000) })
      if (diff < 86400 * 1000) return t('hoursAgo', { n: Math.floor(diff / 3600000) })
      return t('daysAgo', { n: Math.floor(diff / 86400000) })
    }

    // 绝对时间（本地时区），用于"创建 / 最近活动"
    function fmtTime(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function remainText(entry) {
      const until = entry.retainUntil || (entry.deletedAt || 0) + 15 * 86400000
      const left = until - Date.now()
      if (left <= 0) return t('days', { n: 0 })
      return t('days', { n: Math.max(1, Math.round(left / 86400000)) })
    }

    // --- 与本机端点通信（只有相对路径）--------------------------------------------

    async function fetchState() {
      const response = await fetch(`${ROUTE}/state`, { headers: { accept: 'application/json' } })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    async function postAction(action, payload) {
      const response = await fetch(`${ROUTE}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    // --- 样式（只用主题变量，跟随明暗）--------------------------------------------

    const styles = {
      wrap: { padding: '4px 0', fontSize: 13, color: 'var(--dsw-alias-text-primary, inherit)' },
      intro: { opacity: 0.72, lineHeight: 1.6, margin: '4px 0 14px' },
      bar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 },
      btn: {
        padding: '4px 12px',
        fontSize: 13,
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
      },
      btnDanger: {
        padding: '4px 12px',
        fontSize: 13,
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      },
      btnPrimary: {
        padding: '4px 12px',
        fontSize: 13,
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
        background: 'var(--dsw-alias-state-error-primary, #e5484d)',
        color: '#fff',
      },
      disabled: { opacity: 0.45, cursor: 'default' },
      sectionTitle: { fontWeight: 600, margin: '16px 0 8px' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        opacity: 0.6,
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
      },
      td: {
        padding: '7px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14))',
        verticalAlign: 'top',
      },
      tag: {
        display: 'inline-block',
        padding: '0 6px',
        marginRight: 4,
        borderRadius: 4,
        fontSize: 11,
        lineHeight: '17px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        opacity: 0.85,
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', opacity: 0.6, fontSize: 11.5 },
      empty: { opacity: 0.55, padding: '10px 0' },
      ackRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12.5 },
      err: { color: 'var(--dsw-alias-state-error-primary, #e5484d)', marginTop: 10, fontSize: 12.5 },
      ok: { opacity: 0.8, marginTop: 8, fontSize: 12.5 },
    }

    // --- 设置页面板 ----------------------------------------------------------------

    function SessionTrashSection(props) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [pending, setPending] = useState(null) // { kind: 'delete' | 'purge', ids: [], label: '' }
      const [acked, setAcked] = useState(false)

      const load = useCallback(async () => {
        try {
          setError(null)
          setState(await fetchState())
        } catch (reason) {
          setError(reason && reason.message ? reason.message : String(reason))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const refreshSessions = useCallback(async () => {
        try {
          const sessions = rootSessions
          if (sessions && typeof sessions.refresh === 'function') await sessions.refresh()
        } catch {
          /* 尽力而为 */
        }
      }, [])

      const run = useCallback(
        async (action, payload, onDone) => {
          setBusy(true)
          setNotice(null)
          try {
            const data = await postAction(action, payload)
            const results = Array.isArray(data.results) ? data.results : []
            const failed = results.filter((item) => item.ok === false)
            if (failed.length > 0) {
              setNotice(`${t('partial')}${failed.map((item) => item.error).join('; ')}`)
            } else if (onDone) {
              setNotice(onDone(results.filter((item) => item.ok !== false).length))
            }
            await load()
            await refreshSessions()
          } catch (reason) {
            setError(reason && reason.message ? reason.message : String(reason))
          } finally {
            setBusy(false)
            setPending(null)
            setAcked(false)
          }
        },
        [load, refreshSessions],
      )

      const sessions = (state && state.sessions && state.sessions.items) || []
      const trash = (state && state.trash && state.trash.items) || []

      const onDelete = useCallback((row) => {
        setAcked(false)
        setPending({ kind: 'delete', ids: [row.sessionId], label: row.title || row.sessionId })
      }, [])
      const onPurge = useCallback((entry) => {
        setAcked(false)
        setPending({ kind: 'purge', ids: [entry.trashId], label: entry.title || entry.sessionId || entry.trashId })
      }, [])

      const confirm = useCallback(() => {
        if (!pending || !acked) return
        if (pending.kind === 'delete') {
          void run('delete', { sessionIds: pending.ids }, (n) => t('doneDeleted', { n }))
        } else {
          void run('purge', { trashIds: pending.ids }, (n) => t('donePurged', { n }))
        }
      }, [pending, acked, run])

      const rows = sessions.slice(0, 200)

      return React.createElement(
        'div',
        { style: styles.wrap },
        React.createElement(
          'div',
          { style: styles.bar },
          React.createElement(
            'button',
            { type: 'button', style: { ...styles.btn, ...(busy ? styles.disabled : {}) }, disabled: busy, onClick: () => void load() },
            t('refresh'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: { ...styles.btn, ...(busy || trash.length === 0 ? styles.disabled : {}) },
              disabled: busy || trash.length === 0,
              onClick: () => void run('sweep', {}, null),
            },
            t('sweep'),
          ),
          state
            ? React.createElement('span', { style: styles.mono }, `${ROUTE} · ${t('days', { n: state.retentionDays })}`)
            : null,
        ),

        React.createElement(
          'div',
          { style: styles.intro },
          t('intro', { root: (state && state.trashRoot) || '~/.dsh/session-trash', days: (state && state.retentionDays) || 15 }),
        ),

        notice ? React.createElement('div', { style: styles.ok }, notice) : null,
        error ? React.createElement('div', { style: styles.err, role: 'alert' }, t('error', { error })) : null,
        !state && !error ? React.createElement('div', { style: styles.empty }, t('loading')) : null,

        state
          ? React.createElement(
              'div',
              null,
              React.createElement('div', { style: styles.sectionTitle }, t('trashTitle', { count: state.trash.count, size: fmtSize(state.trash.bytes) })),
              trash.length === 0
                ? React.createElement('div', { style: styles.empty }, t('trashEmpty'))
                : React.createElement(
                    'table',
                    { style: styles.table },
                    React.createElement(
                      'thead',
                      null,
                      React.createElement(
                        'tr',
                        null,
                        React.createElement('th', { style: styles.th }, t('colSession')),
                        React.createElement('th', { style: styles.th }, t('colDeleted')),
                        React.createElement('th', { style: styles.th }, t('colRemain')),
                        React.createElement('th', { style: styles.th }, t('colActions')),
                      ),
                    ),
                    React.createElement(
                      'tbody',
                      null,
                      trash.map((entry) =>
                        React.createElement(
                          'tr',
                          { key: entry.trashId },
                          React.createElement(
                            'td',
                            { style: styles.td },
                            React.createElement('div', null, entry.title || t('untitled')),
                            React.createElement('div', { style: styles.mono }, entry.sessionId || entry.trashId),
                          React.createElement('div', { style: styles.mono }, `${t('labelCreated')} ${fmtTime(entry.createdAt)}`),
                          ),
                          React.createElement('td', { style: styles.td }, fmtAgo(entry.deletedAt)),
                          React.createElement('td', { style: styles.td }, remainText(entry)),
                          React.createElement(
                            'td',
                            { style: styles.td },
                            React.createElement(
                              'button',
                              {
                                type: 'button',
                                style: { ...styles.btn, marginRight: 6, ...(busy ? styles.disabled : {}) },
                                disabled: busy,
                                onClick: () => void run('restore', { trashIds: [entry.trashId] }, (n) => t('doneRestored', { n })),
                              },
                              t('restore'),
                            ),
                            React.createElement(
                              'button',
                              { type: 'button', style: { ...styles.btnDanger, ...(busy ? styles.disabled : {}) }, disabled: busy, onClick: () => onPurge(entry) },
                              t('purge'),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),

              React.createElement('div', { style: styles.sectionTitle }, t('sessionsTitle', { total: state.sessions.total, deletable: state.sessions.deletable })),
              React.createElement(
                'table',
                { style: styles.table },
                React.createElement(
                  'thead',
                  null,
                  React.createElement(
                    'tr',
                    null,
                    React.createElement('th', { style: styles.th }, t('colSession')),
                    React.createElement('th', { style: styles.th }, t('colWorkspace')),
                    React.createElement('th', { style: styles.th }, t('colTime')),
                    React.createElement('th', { style: styles.th }, t('colFlags')),
                    React.createElement('th', { style: styles.th }, t('colActions')),
                  ),
                ),
                React.createElement(
                  'tbody',
                  null,
                  rows.map((row) =>
                    React.createElement(
                      'tr',
                      { key: row.sessionId },
                      React.createElement(
                        'td',
                        { style: styles.td },
                        React.createElement('div', null, row.title || t('untitled')),
                        React.createElement('div', { style: styles.mono }, row.sessionId),
                      ),
                      React.createElement(
                        'td',
                        { style: styles.td },
                        React.createElement('div', null, `${t('labelUpdated')} ${fmtTime(row.updatedAt)}`),
                        React.createElement('div', { style: styles.mono }, `${fmtAgo(row.updatedAt || row.createdAt)}`),
                        React.createElement('div', { style: styles.mono }, `${t('labelCreated')} ${fmtTime(row.createdAt)}`),
                      ),
                      React.createElement('td', { style: styles.td }, row.workspaceTitle || '—'),
                      React.createElement(
                        'td',
                        { style: styles.td },
                        row.running ? React.createElement('span', { style: styles.tag }, t('flagRunning')) : null,
                        row.open ? React.createElement('span', { style: styles.tag }, t('flagOpen')) : null,
                        row.deletable ? React.createElement('span', { style: styles.tag }, t('flagOk')) : null,
                      ),
                      React.createElement(
                        'td',
                        { style: styles.td },
                        React.createElement(
                          'button',
                          {
                            type: 'button',
                            title: row.deletable ? t('delete') : row.blockReason === 'running' ? t('flagRunning') : t('flagOpen'),
                            style: { ...styles.btn, ...(busy || !row.deletable ? styles.disabled : {}) },
                            disabled: busy || !row.deletable,
                            onClick: () => onDelete(row),
                          },
                          t('delete'),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              React.createElement('div', { style: styles.empty }, t('needReload')),
            )
          : null,

        pending
          ? React.createElement(
              Modal,
              {
                open: true,
                onClose: () => {
                  setPending(null)
                  setAcked(false)
                },
                title: pending.kind === 'delete' ? t('confirmDeleteTitle') : t('confirmPurgeTitle'),
                closeLabel: t('cancel'),
                description:
                  pending.kind === 'delete'
                    ? t('confirmDeleteDesc', { n: pending.ids.length, days: (state && state.retentionDays) || 15 })
                    : t('confirmPurgeDesc', { n: pending.ids.length }).split('**').join(''),
                footer: [
                  React.createElement(
                    'button',
                    {
                      key: 'cancel',
                      type: 'button',
                      disabled: busy,
                      style: { ...styles.btn, ...(busy ? styles.disabled : {}) },
                      onClick: () => {
                        setPending(null)
                        setAcked(false)
                      },
                    },
                    t('cancel'),
                  ),
                  React.createElement(
                    'button',
                    {
                      key: 'confirm',
                      type: 'button',
                      disabled: busy || !acked,
                      onClick: confirm,
                      style: {
                        ...(pending.kind === 'delete' ? styles.btnPrimary : styles.btnDanger),
                        ...(busy || !acked ? styles.disabled : {}),
                      },
                    },
                    busy ? t('busy') : t('confirm'),
                  ),
                ],
              },
              [
                React.createElement('div', { key: 'label', style: styles.mono }, pending.label),
                React.createElement(
                  'label',
                  { key: 'ack', style: styles.ackRow },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: acked,
                    disabled: busy,
                    onChange: (event) => setAcked(event.target.checked),
                  }),
                  pending.kind === 'delete' ? t('ackDelete') : t('ackPurge'),
                ),
              ],
            )
          : null,
      )
    }

    // --- 插件入口 ------------------------------------------------------------------

    let rootSessions = null

    function apply(ctx) {
      // 只声明必需要的 slots；其余服务用 ctx.get / ctx.inject 惰性获取，
      // 这样即使某个服务缺失也不会让整个 web 启动检查失败。
      rootSessions = ctx.get('sessions')
      if (!rootSessions) {
        ctx.inject(['sessions'], (sub) => {
          rootSessions = sub.sessions
        })
      }

      const locale = ctx.get('locale')
      if (locale) {
        localeService = locale
        try {
          ctx.effect(() => locale.register(NS, { zh: dict.zh, en: dict.en }), 'session-trash: 文案')
        } catch {
          /* 命名空间已注册：沿用既有文案 */
        }
      }
      if (!localeService) {
        ctx.inject(['locale'], (sub) => {
          localeService = sub.locale
          try {
            sub.effect(() => sub.locale.register(NS, { zh: dict.zh, en: dict.en }), 'session-trash: 文案')
          } catch {
            /* ignore */
          }
        })
      }

      ctx.slots.inject('settings.section', () => {
        const dispose = ctx.slots.register(
          {
            name: 'settings.section',
            id: 'session-trash',
            order: 26,
            label: () => t('nav'),
            locale: NS,
          },
          SessionTrashSection,
        )
        return dispose
      })
    }

    return { apply, inject: ['slots'] }
  },
})

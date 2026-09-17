// dsh-session-trash — 宿主端（Host half）。
//
// 设计目标（用户要求）：本地、零依赖、零网络、删除必须可恢复、回收站保留 15 天后自动清理。
//
// 提供的本机端点（只有相对路径，浏览器同源访问，不涉及任何外部域名）：
//   GET  /__dsh-session-trash/state    列出会话 + 回收站内容
//   POST /__dsh-session-trash/delete   { sessionIds: [...] }  会话 → 回收站
//   POST /__dsh-session-trash/restore  { trashIds: [...] }    回收站 → 原位
//   POST /__dsh-session-trash/purge    { trashIds: [...] }    彻底删除
//   POST /__dsh-session-trash/sweep    立即清理超过保留期的条目
//
// 删除步骤（顺序是刻意的，和官方存储服务保持内存/磁盘一致）：
//   1. 拒绝运行中（agents.status === 'running'）与当前已打开（sessions.get）的会话；
//   2. 把会话目录整体 rename 进回收站（不是 rm），保持可恢复；
//   3. 确认原目录已消失后，再清理投影缓存行与工作区记账（sessionIds / archivedSessionIds）。
//
// 全程只用 node 内置模块，不引入任何第三方依赖，也不发起任何网络请求。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'session-trash'

// 只声明真正必须的服务；其余（webServer / agents / sessions / sessionPersistence）
// 通过 ctx.get 惰性获取，缺失时优雅降级，避免插件因少一个服务而完全不加载。
export const inject = ['storageDomain']

const ROUTE_PREFIX = '/__dsh-session-trash'
const RETENTION_DAYS = 15
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 每 6 小时自动清理一次
const MAX_BODY_BYTES = 64 * 1024

// 会话 id 会被拼进回收站路径，所以字符集收紧到十六进制 + 短横线。
const SESSION_ID_RE = /^(session-)?[0-9a-fA-F-]{8,}$/

// --- 路径 --------------------------------------------------------------------

// 优先级与官方 resolveDshHome 一致：非空白的 DSH_HOME，其次 ~/.dsh。
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim().length > 0) return path.resolve(env.trim())
  return path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

function trashRoot() {
  return path.join(dshHome(), 'session-trash')
}

// --- 小工具 ------------------------------------------------------------------

function log(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(message)
    else console.log(message)
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}

function warn(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  } catch {
    /* ignore */
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

class TrashError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status || 500
  }
}

// 会话 id 在磁盘/存储里可能有两种拼法：裸 uuid 与 session- 前缀形式。
function sessionIdVariants(sessionId) {
  const out = new Set([sessionId])
  if (sessionId.startsWith('session-')) out.add(sessionId.slice('session-'.length))
  else if (SESSION_ID_RE.test(sessionId)) out.add(`session-${sessionId}`)
  return [...out]
}

function dirSizeBytes(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          /* 文件可能已被外部删除 */
        }
      }
    }
  }
  return total
}

// --- 定位会话目录 ------------------------------------------------------------

// 优先问持久化层要权威路径（不猜工作区 slug 编码），失败时退回扫描。
async function locateSessionDirs(ctx, sessionId) {
  const found = new Set()
  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.list === 'function' && typeof persistence.locate === 'function') {
    try {
      const headers = await persistence.list()
      for (const header of headers) {
        if (!sessionIdVariants(sessionId).includes(String(header.id))) continue
        const location = persistence.locate(header)
        if (location && typeof location.path === 'string') found.add(path.dirname(location.path))
      }
    } catch (error) {
      warn(ctx, `[session-trash] locate via persistence failed: ${error && error.message}`)
    }
  }

  if (found.size === 0) {
    // 兜底：扫描 $DSH_HOME/sessions/<slug>/<id>（两种 id 拼法都试）。
    const root = sessionsRoot()
    let slugs = []
    try {
      slugs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
    for (const slug of slugs) {
      for (const variant of sessionIdVariants(sessionId)) {
        const candidate = path.join(root, slug, variant)
        try {
          if (fs.statSync(candidate).isDirectory()) found.add(candidate)
        } catch {
          /* 不存在就继续 */
        }
      }
    }
  }
  return [...found]
}

// --- 读取会话与回收站 --------------------------------------------------------

async function listSessions(ctx) {
  const rows = new Map()

  // 1) 持久化的会话头（权威的存在性来源）
  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.list === 'function') {
    try {
      for (const header of await persistence.list()) {
        // 时间：createdAt 来自会话头；"最后活动"用日志文件的 mtime（每条事件都会追加写）。
        let updatedAt = null
        try {
          const location = typeof persistence.locate === 'function' ? persistence.locate(header) : undefined
          if (location && typeof location.path === 'string') updatedAt = fs.statSync(location.path).mtimeMs
        } catch {
          /* 文件可能刚被移走 */
        }
        rows.set(String(header.id), {
          sessionId: String(header.id),
          title: typeof header.title === 'string' ? header.title : null,
          cwd: typeof header.cwd === 'string' ? header.cwd : null,
          createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
          updatedAt,
          running: false,
          open: false,
          workspaceId: null,
          workspaceTitle: null,
        })
      }
    } catch (error) {
      warn(ctx, `[session-trash] list headers failed: ${error && error.message}`)
    }
  }

  // 2) 投影缓存：标题与创建时间（补全 1 里没有的字段）
  const storage = ctx.get('storageDomain')
  const projcache = storage && typeof storage.get === 'function' ? storage.get('session_projcache') : undefined
  if (projcache && typeof projcache.table === 'function') {
    try {
      for (const [id, record] of projcache.table('sessions').entries()) {
        const key = String(id)
        const row = rows.get(key) || { sessionId: key, cwd: null, updatedAt: null, running: false, open: false }
        const recordRows = record && typeof record.rows === 'object' && record.rows !== null ? record.rows : {}
        const titleCell = recordRows.title && typeof recordRows.title.val === 'string' ? recordRows.title.val : null
        const identity = record && typeof record.identity === 'object' && record.identity !== null ? record.identity : {}
        row.title = row.title || titleCell
        if (typeof identity.createdAt === 'number') row.createdAt = identity.createdAt
        if (typeof identity.cwd === 'string') row.cwd = row.cwd || identity.cwd
        rows.set(key, row)
      }
    } catch (error) {
      warn(ctx, `[session-trash] read projection cache failed: ${error && error.message}`)
    }
  }

  // 3) 工作区归属（哪个工作区、按什么顺序分组）
  if (storage && typeof storage.get === 'function') {
    const workspace = storage.get('workspace')
    if (workspace && typeof workspace.table === 'function') {
      try {
        for (const [workspaceId, record] of workspace.table('workspaces').entries()) {
          const ids = record && Array.isArray(record.sessionIds) ? record.sessionIds : []
          for (const id of ids) {
            const key = String(id)
            const row = rows.get(key)
            if (!row) continue
            row.workspaceId = String(workspaceId)
            row.workspaceTitle = typeof record.title === 'string' ? record.title : null
            row.workspacePath = typeof record.path === 'string' ? record.path : null
          }
        }
      } catch (error) {
        warn(ctx, `[session-trash] read workspaces failed: ${error && error.message}`)
      }
    }
  }

  // 4) 运行中 / 已在本进程打开（这两类都不允许删除）
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  for (const row of rows.values()) {
    if (agents && typeof agents.get === 'function') {
      try {
        const agent = agents.get(row.sessionId)
        row.running = !!(agent && agent.status === 'running')
      } catch {
        /* ignore */
      }
    }
    if (sessions && typeof sessions.get === 'function') {
      try {
        row.open = sessionIdVariants(row.sessionId).some((variant) => sessions.get(variant) !== undefined)
      } catch {
        /* ignore */
      }
    }
    row.deletable = !row.running && !row.open
    row.blockReason = row.running
      ? 'running'
      : row.open
        ? 'open'
        : null
  }

  return [...rows.values()].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
}

function readTrashEntries() {
  const root = trashRoot()
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const out = []
  for (const name of entries) {
    const dir = path.join(root, name)
    try {
      const raw = fs.readFileSync(path.join(dir, 'entry.json'), 'utf8')
      const meta = JSON.parse(raw)
      out.push({
        trashId: name,
        sessionId: String(meta.sessionId || ''),
        title: typeof meta.title === 'string' ? meta.title : null,
        cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
        createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : null,
        deletedAt: typeof meta.deletedAt === 'number' ? meta.deletedAt : 0,
        retainUntil: typeof meta.retainUntil === 'number' ? meta.retainUntil : 0,
        dirs: Array.isArray(meta.dirs) ? meta.dirs : [],
        bytes: dirSizeBytes(path.join(dir, 'payload')),
      })
    } catch {
      // 缺少/损坏的 entry.json：列出来但标记为异常，绝不自动删（除非已过期）。
      out.push({
        trashId: name,
        sessionId: '',
        title: null,
        cwd: null,
        deletedAt: (() => {
          try {
            return fs.statSync(dir).mtimeMs
          } catch {
            return 0
          }
        })(),
        retainUntil: 0,
        dirs: [],
        bytes: dirSizeBytes(dir),
        broken: true,
      })
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}

async function stripStorageAccounting(ctx, sessionId) {
  const storage = ctx.get('storageDomain')
  if (!storage || typeof storage.get !== 'function') return { projRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(sessionId)
  let projRemoved = false
  let workspaceRemoved = false

  const projcache = storage.get('session_projcache')
  if (projcache && typeof projcache.table === 'function') {
    try {
      const table = projcache.table('sessions')
      for (const variant of variants) {
        if (table.get(variant) !== undefined) {
          await table.delete(variant)
          projRemoved = true
        }
      }
    } catch {
      /* 域未打开或表不存在 */
    }
  }

  const workspace = storage.get('workspace')
  if (workspace && typeof workspace.table === 'function') {
    try {
      const table = workspace.table('workspaces')
      for (const [workspaceId, record] of table.entries()) {
        if (!record || !Array.isArray(record.sessionIds)) continue
        if (!variants.some((variant) => record.sessionIds.includes(variant))) continue
        await table.put(workspaceId, {
          ...record,
          sessionIds: record.sessionIds.filter((id) => !variants.includes(id)),
        })
        workspaceRemoved = true
      }
    } catch {
      /* ignore */
    }
    try {
      const global = workspace.global
      if (global && typeof global.get === 'function' && typeof global.set === 'function') {
        const state = global.get()
        if (state && Array.isArray(state.archivedSessionIds)) {
          if (variants.some((variant) => state.archivedSessionIds.includes(variant))) {
            await global.set({
              ...state,
              archivedSessionIds: state.archivedSessionIds.filter((id) => !variants.includes(id)),
            })
            workspaceRemoved = true
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  return { projRemoved, workspaceRemoved }
}

// --- 核心动作 ----------------------------------------------------------------

function trashIdFor(sessionId) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z')
  return `${stamp}-${sessionId}`
}

async function deleteToTrash(ctx, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) throw new TrashError(`非法的会话 id: ${sessionId}`, 400)

  const agents = ctx.get('agents')
  if (agents && typeof agents.get === 'function') {
    const agent = agents.get(sessionId)
    if (agent && agent.status === 'running') {
      throw new TrashError('该会话正在运行，请先停止它再删除', 409)
    }
  }
  const sessions = ctx.get('sessions')
  if (sessions && typeof sessions.get === 'function') {
    const live = sessionIdVariants(sessionId).some((variant) => sessions.get(variant) !== undefined)
    if (live) {
      throw new TrashError('该会话当前处于打开状态，请先切换到其他会话再删除（避免宿主把日志回写回来）', 409)
    }
  }

  const dirs = await locateSessionDirs(ctx, sessionId)
  if (dirs.length === 0) throw new TrashError('找不到该会话的日志目录（可能已被删除）', 404)

  const sessionsList = await listSessions(ctx)
  const info = sessionsList.find((row) => row.sessionId === sessionId) || {}

  const trashId = trashIdFor(sessionId)
  const entryDir = path.join(trashRoot(), trashId)
  const payloadDir = path.join(entryDir, 'payload')
  fs.mkdirSync(payloadDir, { recursive: true })

  const moved = []
  const root = sessionsRoot()
  for (const dir of dirs) {
    // locate 与 rename 之间目录可能已被外部删掉：给干净的 404，而不是裸 ENOENT。
    if (!fs.existsSync(dir)) throw new TrashError('找不到该会话的日志目录（可能刚被删除）', 404)
    const relative = path.relative(root, dir)
    const destination = path.join(payloadDir, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.renameSync(dir, destination) // 同盘 rename：原子且可逆
    moved.push({ from: dir, relative })
  }

  // 确认原目录确实不见了，再写记账；否则回滚。
  const survivors = moved.filter((item) => fs.existsSync(item.from))
  if (survivors.length > 0) {
    for (const item of moved) {
      const backup = path.join(payloadDir, item.relative)
      if (fs.existsSync(backup) && !fs.existsSync(item.from)) {
        try {
          fs.mkdirSync(path.dirname(item.from), { recursive: true })
          fs.renameSync(backup, item.from)
        } catch {
          /* 尽力回滚 */
        }
      }
    }
    throw new TrashError('会话目录被占用，无法移动（已回滚）', 500)
  }

  const now = Date.now()
  const meta = {
    version: 1,
    trashId,
    sessionId,
    title: info.title || null,
    cwd: info.cwd || null,
    createdAt: info.createdAt || null,
    workspaceId: info.workspaceId || null,
    workspaceTitle: info.workspaceTitle || null,
    deletedAt: now,
    retainUntil: now + RETENTION_MS,
    dirs: moved,
  }
  fs.writeFileSync(path.join(entryDir, 'entry.json'), JSON.stringify(meta, null, 2), 'utf8')

  const stripped = await stripStorageAccounting(ctx, sessionId)
  log(ctx, `[session-trash] 已移入回收站: ${sessionId} -> ${trashId}`)
  return { trashId, sessionId, title: meta.title, dirs: moved.length, projRemoved: stripped.projRemoved, workspaceRemoved: stripped.workspaceRemoved }
}

function readEntry(trashId) {
  if (!/^[0-9A-Za-z._-]+$/.test(trashId)) throw new TrashError('非法的回收站条目 id', 400)
  const entryDir = path.join(trashRoot(), trashId)
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(entryDir, 'entry.json'), 'utf8'))
  } catch {
    throw new TrashError('回收站条目不存在或已损坏', 404)
  }
  return { entryDir, payloadDir: path.join(entryDir, 'payload'), meta }
}

async function restoreFromTrash(ctx, trashId) {
  const { entryDir, payloadDir, meta } = readEntry(trashId)
  const moved = Array.isArray(meta.dirs) ? meta.dirs : []
  let restored = 0

  for (const item of moved) {
    const backup = path.join(payloadDir, item.relative)
    if (!fs.existsSync(backup)) continue
    if (fs.existsSync(item.from)) throw new TrashError(`原位置已有同名目录，未覆盖: ${item.from}`, 409)
    fs.mkdirSync(path.dirname(item.from), { recursive: true })
    fs.renameSync(backup, item.from)
    restored += 1
  }
  if (restored === 0) throw new TrashError('回收站里没有可恢复的内容', 404)

  // 把会话重新挂回原来的工作区（会话列表读的是持久化，这里只补分组记账）。
  const storage = ctx.get('storageDomain')
  let workspaceRestored = false
  if (storage && typeof storage.get === 'function' && meta.workspaceId) {
    const workspace = storage.get('workspace')
    if (workspace && typeof workspace.table === 'function') {
      try {
        const table = workspace.table('workspaces')
        const record = table.get(String(meta.workspaceId))
        if (record && Array.isArray(record.sessionIds) && !record.sessionIds.includes(meta.sessionId)) {
          await table.put(String(meta.workspaceId), { ...record, sessionIds: [meta.sessionId, ...record.sessionIds] })
          workspaceRestored = true
        }
      } catch {
        /* ignore */
      }
    }
  }

  fs.rmSync(entryDir, { recursive: true, force: true })
  log(ctx, `[session-trash] 已从回收站恢复: ${meta.sessionId}`)
  return { sessionId: meta.sessionId, restored, workspaceRestored }
}

function purgeEntry(ctx, trashId) {
  const { entryDir, meta } = readEntry(trashId)
  fs.rmSync(entryDir, { recursive: true, force: true })
  log(ctx, `[session-trash] 已彻底删除: ${meta.sessionId || trashId}`)
  return { trashId, sessionId: meta.sessionId || null }
}

function sweepExpired(ctx) {
  const now = Date.now()
  const purged = []
  for (const entry of readTrashEntries()) {
    const expireAt = entry.retainUntil || entry.deletedAt + RETENTION_MS
    if (expireAt > now) continue
    try {
      purgeEntry(ctx, entry.trashId)
      purged.push(entry.trashId)
    } catch (error) {
      warn(ctx, `[session-trash] 清理失败 ${entry.trashId}: ${error && error.message}`)
    }
  }
  if (purged.length > 0) log(ctx, `[session-trash] 自动清理了 ${purged.length} 个超过 ${RETENTION_DAYS} 天的条目`)
  return purged
}

// --- 插件入口 ----------------------------------------------------------------

export function apply(ctx) {
  async function handleState(_req, res) {
    try {
      const sessions = await listSessions(ctx)
      const trash = readTrashEntries()
      sendJson(res, 200, {
        ok: true,
        retentionDays: RETENTION_DAYS,
        sweepIntervalHours: SWEEP_INTERVAL_MS / 3600000,
        trashRoot: trashRoot(),
        sessions: {
          total: sessions.length,
          deletable: sessions.filter((row) => row.deletable).length,
          items: sessions,
        },
        trash: {
          count: trash.length,
          bytes: trash.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
          items: trash,
        },
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  function makePost(handler) {
    return async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let args = {}
      try {
        const raw = await readBody(req)
        if (raw) args = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      try {
        sendJson(res, 200, await handler(args))
      } catch (error) {
        const status = error instanceof TrashError ? error.status : 500
        sendJson(res, status, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    }
  }

  function registerRoutes(host) {
    host.register({ kind: 'exact', path: `${ROUTE_PREFIX}/state`, handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      await handleState(req, res)
    } })

    host.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/delete`,
      handler: makePost(async (args) => {
        const ids = Array.isArray(args.sessionIds) ? args.sessionIds.map(String) : []
        if (ids.length === 0) throw new TrashError('缺少 sessionIds', 400)
        const results = []
        for (const id of ids) {
          try {
            results.push({ sessionId: id, ok: true, ...(await deleteToTrash(ctx, id)) })
          } catch (error) {
            results.push({ sessionId: id, ok: false, error: error && error.message ? error.message : String(error) })
          }
        }
        return { ok: true, results }
      }),
    })

    host.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/restore`,
      handler: makePost(async (args) => {
        const ids = Array.isArray(args.trashIds) ? args.trashIds.map(String) : []
        if (ids.length === 0) throw new TrashError('缺少 trashIds', 400)
        const results = []
        for (const id of ids) {
          try {
            results.push({ trashId: id, ok: true, ...(await restoreFromTrash(ctx, id)) })
          } catch (error) {
            results.push({ trashId: id, ok: false, error: error && error.message ? error.message : String(error) })
          }
        }
        return { ok: true, results }
      }),
    })

    host.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/purge`,
      handler: makePost(async (args) => {
        const ids = Array.isArray(args.trashIds) ? args.trashIds.map(String) : []
        if (ids.length === 0) throw new TrashError('缺少 trashIds', 400)
        const results = []
        for (const id of ids) {
          try {
            results.push({ ok: true, ...purgeEntry(ctx, id) })
          } catch (error) {
            results.push({ trashId: id, ok: false, error: error && error.message ? error.message : String(error) })
          }
        }
        return { ok: true, results }
      }),
    })

    host.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/sweep`,
      handler: makePost(async () => ({ ok: true, purged: sweepExpired(ctx) })),
    })
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => {
      registerRoutesShim(webServer)
      return () => {}
    })
  } else {
    ctx.inject(['webServer'], (sub) => {
      sub.effect(() => {
        registerRoutesShim(sub.webServer)
        return () => {}
      })
    })
  }

  // registerRoutes 内部调用 host.register（返回 disposer）——集中收集，便于卸载。
  function registerRoutesShim(host) {
    const disposers = []
    const original = host.register
    // 直接调用即可：host.register 的返回值就是移除函数，这里逐个收集。
    const proxy = {
      register(route) {
        const dispose = original.call(host, route)
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
    }
    registerRoutes(proxy)
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 启动后先扫一次过期的，之后每 6 小时一次；定时器随插件 fiber 一起释放。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        sweepExpired(ctx)
      } catch (error) {
        warn(ctx, `[session-trash] 启动清理失败: ${error && error.message}`)
      }
    }, 3000)
    const sweep = () => {
      try {
        sweepExpired(ctx)
      } catch (error) {
        warn(ctx, `[session-trash] 定时清理失败: ${error && error.message}`)
      }
    }
    // 取 timer 服务必须走 ctx.get：直接读 ctx.interval 会命中 cordis 的服务代理，
    // 而未写进 inject 的服务名一读就抛（cannot get property "timer" without inject），
    // typeof 兜底根本走不到，插件会整个加载失败。ctx.get 是「不需要 inject」的读取口，
    // 拿不到就退回原生 setInterval，两种返回的都是可调用的清理函数。
    let timerService
    try {
      timerService = ctx.get('timer')
    } catch {
      timerService = undefined
    }
    const interval =
      timerService && typeof timerService.interval === 'function'
        ? timerService.interval(sweep, SWEEP_INTERVAL_MS)
        : setInterval(sweep, SWEEP_INTERVAL_MS)
    return () => {
      clearTimeout(timer)
      if (typeof interval === 'function') interval()
      else clearInterval(interval)
    }
  }, 'session-trash: 15 天回收站清理')

  log(ctx, `[session-trash] 已加载：回收站 ${trashRoot()}，保留 ${RETENTION_DAYS} 天`)
}

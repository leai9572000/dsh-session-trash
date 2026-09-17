# dsh-session-trash

给 DeepSeek Harness 的会话删除加一个**本机回收站**：删掉的会话进 `~/.dsh/session-trash`，
可以恢复、可以彻底删除，15 天后自动过期清理。

零依赖、零网络请求——只用 Node 内置模块，只访问本机同源端点。

## 为什么需要它

DSH 原生的删除是直接移除会话目录，误删无法找回。这个插件把删除变成可逆操作：
会话目录整体 `rename` 进回收站（不是 `rm`），保留期到了才真正清掉。

## 界面位置

**设置 → 「会话与回收站」**（`settings.section`，官方支持的插槽）。

不往侧栏会话行菜单里注入 DOM——那是官方 API 的缺口，靠 `MutationObserver` 打补丁既脆又危险。

## 端点

只有相对路径，浏览器同源访问，不涉及任何外部域名：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__dsh-session-trash/state` | 列出会话 + 回收站内容 |
| POST | `/__dsh-session-trash/delete` | `{ sessionIds: [...] }` 会话 → 回收站 |
| POST | `/__dsh-session-trash/restore` | `{ trashIds: [...] }` 回收站 → 原位 |
| POST | `/__dsh-session-trash/purge` | `{ trashIds: [...] }` 彻底删除 |
| POST | `/__dsh-session-trash/sweep` | 立即清理超过保留期的条目 |

## 删除流程

顺序是刻意设计的，用来和官方存储服务保持内存/磁盘一致：

1. 拒绝运行中（`agents.status === 'running'`）与当前已打开（`sessions.get`）的会话；
2. 把会话目录整体 `rename` 进回收站（**不是** `rm`），保持可恢复；
3. 确认原目录已消失后，再清理投影缓存行与工作区记账（`sessionIds` / `archivedSessionIds`）。

## 保留策略

| 项 | 值 |
|---|---|
| 保留期 | 15 天 |
| 自动清理间隔 | 每 6 小时 |
| 请求体上限 | 64 KB |

会话 id 会被拼进回收站路径，所以字符集收紧到十六进制 + 短横线
（`/^(session-)?[0-9a-fA-F-]{8,}$/`）。

## 安全边界

- 全程只用 Node 内置模块，不引入第三方依赖，不发起任何外部网络请求。
- 服务依赖（`webServer` / `agents` / `sessions` / `sessionPersistence`）通过 `ctx.get`
  惰性获取，缺失时优雅降级，避免插件因少一个服务而完全不加载。
- 遵循 `DSH_HOME` 环境变量，未设置时退回 `~/.dsh`。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:leai9572000/dsh-session-trash
```

`dsh plugin` 会转发给 pnpm，在 profile 目录完成安装。装完后把包名登记进
`~/.dsh/profiles/web/package.json` 的 bundle 列表（DSH 0.1.2-rc.1 需要手工登记）：

```json
{
  "dsh": { "profile": { "bundles": ["…已有 bundle…", "dsh-session-trash"] } }
}
```

然后重启 `dsh web`。

### 从本机源码安装（开发时）

```json
{
  "dependencies": { "dsh-session-trash": "file:/绝对路径/dsh-session-trash" },
  "dsh": { "profile": { "bundles": ["…已有 bundle…", "dsh-session-trash"] } }
}
```

在该目录执行 `pnpm install` 并重启 `dsh web`。

### ⚠️ 改了源码却不生效？先看这里

`nodeLinker: hoisted` 模式下，pnpm 把 `file:` 依赖**拷贝**进
`~/.dsh/profiles/web/node_modules/<name>`，不是软链。所以直接改源码目录后重启服务，
跑的还是那份旧拷贝。

处理方式（二选一）：

1. 在 `~/.dsh/profiles/web` 重新跑 `pnpm install`，让拷贝刷新；
2. 把安装位置换成指向源码的软链（推荐，之后改源码即生效）：

```bash
cd ~/.dsh/profiles/web/node_modules/dsh-session-trash
rm -rf src && ln -s /绝对路径/dsh-session-trash/src src
```

注意：后续再次 `pnpm install` 可能把软链改回拷贝，到时重做一次。

另外，纯改源码**不会**热重载：DSH 启动时 HMR 用的是空监听根（`root: []`），
且 Node 已缓存该模块。必须重启 `dsh web`。

## License

MIT

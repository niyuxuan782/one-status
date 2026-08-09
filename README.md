# One Status

**One user. One status. Every AI. Private by design.**

One Status 是面向多 Agent 的通用能力包、身份授权和状态同步层。它把工具、Skills、Instructions、Memory 与权限定义为平台无关的 Capability Pack，并通过 Adapter Engine 逐步适配 Codex、Claude Code、Cursor、ChatGPT 和普通 Agent。

完整产品边界见 [产品架构](docs/product-architecture.md)，开源与托管边界见 [Open Core](docs/open-core.md)。

当前仓库实现了 Phase 1 的第一个可运行闭环：

- 账号注册、登录与设备会话
- 注册事务内原子创建首个加密 Status vault
- 覆盖 Identity、Preferences、Memory、Projects、Workspace、Permissions、Tools、Tasks 的 Status Schema
- Capability Pack 严格 YAML/JSON 协议、稳定摘要和 E2EE 安装状态
- Codex Plugin、Claude Skill、Cursor Rules、Markdown 与 Local MCP Adapter Engine
- 客户端 AES-256-GCM 加密，AAD 绑定同步 revision，服务端仅保存密文 envelope
- 带版本条件写入、`mutationId` 幂等和冲突重试的双向同步
- 非回环 API 强制 HTTPS，客户端请求默认 10 秒超时
- 本地 CLI 与权限为 `0600` 的设备配置
- 可供 Codex、Claude Code 等客户端连接的 stdio MCP Server
- 带 bearer 认证和独立 session 的 Streamable HTTP MCP Server
- npm 单文件包、Docker 镜像与 Homebrew Formula
- 两台设备、两个独立 MCP 进程之间的状态交接 Demo
- 本地图形工作台、独立加密 Permission Vault 和 Agent 权限配置
- 图形化首次注册、恢复密钥生成和新设备登录
- 14 个 Provider、14 个 Capability Packs 与 69 个固定 actions
- Permission Vault 二次加密同步，设备间恢复后使用本机密钥重新落盘
- MCP `tools_list`、`tools_execute` 统一工具入口
- 稳定 installation ID、设备 heartbeat 与在线状态
- Codex / Claude Code 项目、MCP、Skills、Plugins、Rules 只读清单
- 本机 Git checkout 映射、Handoff 预览、Secret 扫描和显式文件写入
- 用户确认后的 GitHub Handoff commit/push、精确 commit clone/update 与 Codex/Claude Code 启动 Adapter
- Handoff 源 commit 与文件 SHA-256 校验，打开时验证加密 Status reference
- 记忆候选确认、来源标记、编辑与删除；未确认候选默认不进入 Agent 正常检索
- Task State 图形化管理与本机扫描项目的显式导入
- 脱敏工具审计 Activity 与 Security / Agent Permission Firewall 页面
- 密文 Sync API、Caddy HTTPS 与 SQLite 备份生产栈
- Electron 桌面应用与 macOS、Windows、Linux 原生安装包
- 官网、一键安装器、Homebrew Cask 和跨平台 Release 校验和

Google Workspace、GitHub 和 Slack 已完成真实账号授权、Codex/Claude Code grant 与 Provider API 调用验收。v0.6.0 新增 Microsoft 365、Notion、Dropbox、Zoom、Canva、Asana、Trello、Airtable、Linear、Figma 和 Box 的 OAuth/凭据协议、固定 action schema、响应裁剪与 Capability Pack；这些新增连接仍需配置各 Provider OAuth App 并逐个完成真实账号验收。完整配置矩阵见 [Provider 集成](docs/provider-integrations.md)。腾讯云同步服务已在 `https://os.furesta.top` 启用公网 HTTPS。

## 60 秒 Demo

环境要求：Node.js 22+、pnpm 10+。

```bash
pnpm install
pnpm demo
```

Demo 会在临时目录中完成以下流程：

1. 注册账号及两台独立设备。
2. Claude Code 模拟进程写入 One Status 项目、Rust 技术栈、pnpm 偏好和 OAuth 任务。
3. 关闭 Claude Code 模拟进程。
4. Codex 模拟进程读取完整状态并更新任务进度。
5. 重启 Claude Code 模拟进程，读取 Codex 留下的最新交接状态。
6. 扫描服务端持久化文件，确认测试 Status、密码、Status Key 和原始 Token 未出现。

两个 Agent 通过官方 MCP Client 与两个独立 stdio MCP Server 通信，设备之间只共享同步服务和 Status Key。

## 安装

官网由 GitHub Pages 托管：<https://niyuxuan782.github.io/one-status/>

macOS、Linux 一键安装桌面应用：

```bash
curl -fsSL https://niyuxuan782.github.io/one-status/install.sh | bash
```

Windows PowerShell 一键安装：

```powershell
irm https://niyuxuan782.github.io/one-status/install.ps1 | iex
```

安装器从 [GitHub Releases](https://github.com/niyuxuan782/one-status/releases/latest) 下载对应平台附件，并强制使用同一 Release 的 `SHA256SUMS.txt` 校验。当前桌面版属于未签名 Preview，操作系统会执行正常的安全检查。

Homebrew 桌面 App：

```bash
brew tap niyuxuan782/tap
brew install --cask niyuxuan782/tap/one-status
```

CLI / MCP 一键安装：

```bash
curl -fsSL https://niyuxuan782.github.io/one-status/install.sh | bash -s -- --cli
one-status app
```

从源码运行：

```bash
git clone https://github.com/niyuxuan782/one-status.git
cd one-status
pnpm install
pnpm --filter @one-status/desktop dev
```

Homebrew Formula、npm、本地构建与发布流程见 [安装与发布](docs/installation.md)。

## 本地使用

通过 Homebrew 启动常驻同步 API：

```bash
brew services start one-status/local/one-status
```

前台调试可运行 `one-status server`。常驻服务的数据保存在 Homebrew `var/one-status` 目录，目录权限为 `0700`，数据库权限为 `0600`。

在设备 A 注册账号。使用隐藏输入，密码值不会出现在命令历史中：

```bash
read -rs ONE_STATUS_PASSWORD
export ONE_STATUS_PASSWORD
one-status register \
  --email you@example.com \
  --device "Mac A"
```

CLI 会在注册网络请求前显示一次 `Status Key`。请将它保存在离线密码管理器中；即使注册响应丢失，也可以用账号密码和该密钥重新登录。

写入首批状态：

```bash
one-status set-project \
  --id one-status \
  --name "One Status" \
  --tech-stack "TypeScript,Rust" \
  --goal "Build MCP Gateway"

one-status set-preference \
  --key packageManager \
  --value pnpm

one-status remember \
  --scope user \
  --content "Prefer pnpm. Do not use npm."
```

设备 B 使用账号密码和恢复密钥连接：

```bash
export ONE_STATUS_HOME="$HOME/.config/one-status-device-b"
read -rs ONE_STATUS_PASSWORD
export ONE_STATUS_PASSWORD
read -rs ONE_STATUS_STATUS_KEY
export ONE_STATUS_STATUS_KEY
one-status login \
  --email you@example.com \
  --device "Mac B"

one-status show
one-status doctor
one-status devices
one-status heartbeat
one-status use-server --url https://status.example.com
```

丢失或停用设备时执行 `one-status revoke-device --id <device-id>`。当前设备退出使用 `one-status logout`，服务端 session、本地 profile 和对应 macOS Keychain item 会同时删除。

macOS 默认 profile 只保存设备和 Keychain 引用等非敏感元数据，设备 session Token 与 Status Key 存入系统 Keychain。首次读取旧版明文 profile 时会自动完成原子迁移。显式传入 profile path 的开发、测试和多 profile 场景继续使用权限为 `0600` 的便携文件格式。

长驻 MCP 会在每次 Status 或 Tool Gateway 操作前重新加载当前 profile。工作台重新登录、切换账号或轮换 Secret 文件后，已经连接的 Codex 与 Claude Code MCP 进程会在下一次调用时采用新会话和 Status Key。

## 图形界面

桌面 App 会启动本机后台服务并在独立窗口显示工作台。CLI 用户可以运行 `one-status app`；该命令优先打开已安装 App，缺少 App 时会启动本机服务并打开浏览器工作台。

Homebrew service 或 `one-status server` 在回环地址运行时也会启用工作台：

```text
http://127.0.0.1:8787/
```

本机后台服务每 30 秒向当前 Sync API 发送设备 heartbeat；关闭服务或网络不可用后，设备会在服务端在线窗口结束时转为离线。

工作台提供首次注册/登录、概览、身份与上下文、偏好、项目、Handoff、记忆、设备、OAuth 连接和 Agent 动作授权。注册成功时恢复密钥会在本机页面显示一次；日常页面只持有同源 Dashboard session 与 CSRF token，设备 Token 和 OAuth Token 不会发送到前端。

`Agents 与工具` 页面读取本机 Codex、Claude Code 配置并生成只读清单。MCP Secret 值、URL query、Skill 正文和 Rule 正文不会进入清单；扫描结果不会自动上传。

OAuth App 在 `连接与权限` 页面配置。界面会为 13 个 OAuth2 Provider 显示各自需要登记的 Callback URL；Trello 使用 API key 与 user Token 连接。授权完成后可分别为 `codex` 和 `claude-code` 开放具体 action。

GitHub 还提供本机快速导入：点击 `从 gh 导入` 后，One Status 调用已登录的 GitHub CLI 获取当前 OAuth 会话，向 GitHub `/user` 验证账号和 scope，再加密写入 Permission Vault。该凭据归 GitHub CLI 管理；从 One Status 断开时只删除 Vault 副本，不影响 `gh` 登录。导入流程不会把 Token 放入命令参数、页面响应或 Activity。

GitHub OAuth App 会申请 `repo`，用于用户在 Handoff 页面明确确认后的私有仓库 push/clone。该 Provider scope 不会自动开放给 Agent；Agent 仍只能调用权限页面勾选的资料与仓库读取动作。规模化版本会迁移到可按仓库安装的 GitHub App token。

Slack 使用 user-token public client PKCE，只填写 Client ID。可直接导入 [Slack App manifest](docs/slack-app-manifest.yaml)，完整配置和验收步骤见 [Slack OAuth 配置](docs/slack-oauth.md)。其余 OAuth2 Provider 的 Client 类型、scope、审核要求和断开语义见 [Provider 集成](docs/provider-integrations.md)。

`Handoff` 页面将便携项目映射到当前设备上的 Git 仓库根目录。程序采集 branch、commit、dirty state 和变更文件，扫描 Git 变更与待生成内容，然后显示 `HANDOFF.md` 预览。Secret 扫描通过并获得显式确认后，写入：

```text
HANDOFF.md
.one-status/handoff.json
```

已有文件需要额外确认覆盖。发布时用户还要分别确认提交当前 Git 变更和推送 GitHub；程序会禁用 commit/push Git hooks，推送后通过 `ls-remote` 校验精确 commit，再把仓库、branch、commit 和来源设备写入加密 Status。本机绝对路径只保存在设备本地数据库，不进入云端。

已完成项目映射后，也可以从终端运行同一条 Handoff 流程。默认回环 Dashboard 尚未运行时，CLI 会先启动本机后台服务：

```bash
one-status handoff --project one-status --agent claude-code
one-status handoff --project one-status --agent claude-code --publish
```

第一条命令只执行预检，输出 worktree、Secret 扫描、源 commit 和 Status version。`--publish` 代表更新现有 Handoff 文件、提交当前 Git 改动并推送 GitHub 的明确授权；成功结果同时返回 source commit、published commit 和同步后的 Status version。CLI 仅连接回环 Dashboard，并使用 Dashboard 发放的 session cookie 与 CSRF token 调用现有 Handoff API。

另一台 macOS 设备可选择 `Continue with Codex` 或 `Continue with Claude Code`。没有本机映射时，One Status 克隆到用户确认的新目录；已有映射时只接受 clean worktree。fetch 后会从已发布 commit 建立独立的 `one-status/continue/...` 本地分支，既保证起点精确，也允许 Agent 正常提交后续工作。程序验证 `HANDOFF.md`、`.one-status/handoff.json` 和 Status reference 一致后，通过 Terminal 打开 Agent，并要求 Agent 先读取 Handoff、调用 `status_get_context`。

当前 `handoff.json` 的测试状态仍记录为 `not_run`。发布要求 GitHub origin、有效 Git author 配置和已连接的 GitHub OAuth 账号。One Status 会按仓库 owner 选择 Permission Vault 连接，只通过 Git 子进程环境注入认证并禁用交互式 credential helper；Token 不进入 remote URL、命令参数、错误、返回值或 Activity。

本地 Permission Vault 默认位于同步数据库旁：

```text
one-status.sqlite.permissions
one-status.sqlite.permission-key
one-status.sqlite.workspace
```

Provider Client Secret、PKCE verifier、access token 和 refresh token 使用 AES-256-GCM 加密；文件权限为 `0600`。单用户受信任部署需要公网 OAuth callback 时设置：

```bash
ONE_STATUS_PUBLIC_URL=https://status.example.com one-status server
```

桌面 MVP 统一使用 `http://127.0.0.1:8787/oauth/<provider>/callback`。共享云只保存密文 Sync 状态，不接收本机 OAuth flow。Permission Vault bundle 使用 Status Key 派生出的独立密钥再次加密后进入 Status；新设备解密 bundle，再用该设备的 Permission Vault key 重新加密保存。Agent 的 Status 工具只能看到 `one-status.encrypted-permission-vault` envelope。

## Agent 接入

先在当前设备完成 `register` 或 `login`。安装后的单文件命令不会向 MCP stdout 写入包管理器日志。

Codex：

```bash
codex mcp add one-status \
  -- one-status mcp --transport stdio --agent codex
```

Codex Desktop 可在 `Settings > MCP servers` 查看服务状态，也可以在输入框键入 `/mcp`。终端检查命令为 `codex mcp list` 和 `codex mcp get one-status`。

MCP 工具由 Agent 按需调用；仅重启客户端不会自动把 Status 渲染到每个新会话。可以用以下提示验证完整工具链：

```text
必须调用 One Status 的 status_get_context 工具，然后显示 version、workspace、project 和 openTasks；不要使用 shell 命令。
```

使用第三方模型 API 时，服务端需要完整兼容 Responses API 的工具调用事件。One Status MCP 与模型 API 使用独立连接。

Claude Code：

```bash
claude mcp add --scope user one-status \
  -- one-status mcp --transport stdio --agent claude-code
```

连接成功后，One Status 会向 Agent 提供 Gateway 优先策略。涉及邮件、日历、文件、协作、项目管理或设计服务时，Agent 应先调用 `tools_list`，再用返回的 `connectionId` 与 `action` 调用 `tools_execute`。模型供应商、API Key 类型和 Agent 自带集成不会改变这条链路；Provider Token 始终留在本机 Permission Vault。

MCP 会在回环 Gateway 上自动把设备会话换成绑定当前 Agent 的短期凭据。工具请求不发送 `agentId` query/body，也不会把设备 Token 当作工具调用凭据。远程 Tool Gateway 需要通过 `ONE_STATUS_AGENT_TOKEN` 或 `ONE_STATUS_AGENT_TOKEN_FILE` 提供预签发凭据。

当前 Gateway action：

| Service | Read actions | Confirmed write actions |
| --- | --- | --- |
| Google Calendar | `calendar.calendars.list`、`calendar.events.list`、`calendar.events.get`、`calendar.freebusy.query` | 后续加入日程写入 |
| Gmail | `gmail.messages.list`、`gmail.messages.get` | `gmail.messages.send` |
| Google Drive / Docs | `drive.files.list`、`drive.files.get`、`docs.documents.get` | — |
| GitHub | `github.viewer.get`、`github.repositories.list`、`github.issues.list`、`github.pull_requests.list`、`github.contents.get` | `github.issues.create` |
| Slack | `slack.channels.list`、`slack.conversations.history`、`slack.search.messages` | `slack.messages.post` |
| Microsoft 365 | `outlook.messages.list/get`、`outlook.calendar.events.list`、`teams.chats.list`、`teams.chat_messages.list`、`onedrive.children.list`、`sharepoint.site_files.list` | `outlook.messages.send` |
| Notion | `notion.search`、`notion.pages.get`、`notion.blocks.children.list` | `notion.pages.create` |
| Dropbox | `dropbox.files.list`、`dropbox.files.metadata.get`、`dropbox.files.search` | `dropbox.files.upload` |
| Zoom | `zoom.meetings.list`、`zoom.meetings.get` | `zoom.meetings.create` |
| Canva | `canva.profile.get`、`canva.designs.list/get`、`canva.design_pages.list`、`canva.folder_items.list` | — |
| Asana | `asana.workspaces.list`、`asana.tasks.list/get` | `asana.tasks.create` |
| Trello | `trello.boards.list`、`trello.lists.list`、`trello.cards.list` | `trello.cards.create` |
| Airtable | `airtable.bases.list`、`airtable.tables.list`、`airtable.records.list` | `airtable.records.create` |
| Linear | `linear.teams.list`、`linear.issues.list/get` | `linear.issues.create` |
| Figma | `figma.project_files.list`、`figma.file_metadata.get`、`figma.file_nodes.get`、`figma.comments.list` | `figma.comments.create` |
| Box | `box.folders.items.list`、`box.files.get`、`box.search` | `box.folders.create` |

`tools_list` 只显示当前连接已授予 scope 且用户已为该 Agent 勾选的 action，并为每项能力返回与执行校验同源的 `inputSchema`。对于标记为 `requiresConfirmation` 的操作，Agent 先调用 `tools_request_approval`，用户在 One Status Dashboard 核对并批准精确请求，随后 Agent 携带返回的 `approvalId` 调用 `tools_execute`。无可用 action 时，Agent 会引导用户前往 One Status 的 `连接与权限` 页面连接、授权或重新连接服务。

Capability Pack 可以从桌面 App 的“能力包”页面选择目标平台，也可以通过 CLI 查看并安装。CLI 安装先返回文件预览和 `approvalId`，确认阶段会重新验证文件摘要和路径：

```bash
one-status capability list
one-status capability preview --pack google-workspace --target codex
one-status capability install \
  --pack google-workspace \
  --target codex \
  --approval <approvalId> \
  --confirm
```

Codex 输出会进入 One Status 管理的本地 Marketplace 并调用 `codex plugin add`；Claude Code 只安装生成的 Skill；Markdown 与 Local MCP 输出进入 One Status 受管目录。Cursor manifest 编译已经可用，平台安装仍需完成确认流程；ChatGPT 当前同步安装意图，Apps SDK 输出和 Remote MCP 平台安装仍在路线图中。

MCP 当前提供：

- `read_status`
- `write_status`
- `status_get_profile`
- `status_get_memory`
- `status_search_memory`
- `status_get_project`
- `status_get_context`
- `capabilities_get`
- `status_update_context`
- `tools_list`
- `tools_request_approval`
- `tools_execute`

开发环境可用两个独立 Agent MCP 进程执行真实 OAuth 冒烟测试：

```bash
pnpm --filter @one-status/demo live:tools slack.channels.list
pnpm --filter @one-status/demo live:tools calendar.events.list
pnpm --filter @one-status/demo live:tools github.repositories.list
```

每次读取都会从 API 拉取最新密文并在本地解密。每次写入都以版本号、稳定 `mutationId` 和逻辑摘要提交，发生冲突时 SDK 会重新读取并重放当前变更；提交后的网络响应丢失时，服务端返回去重结果。同一个 ID 携带不同逻辑摘要会得到明确冲突。`tools_list` 只返回当前 Agent 获准使用的连接和动作，`tools_execute` 在 Gateway 内部刷新和使用 OAuth Token。

同步地址指向远端云时，MCP 默认从本机 `http://127.0.0.1:8787` 调用 Permission Vault；密文 Status 仍从远端读取。若本机工作台使用其他端口，可为 Codex 或 Claude Code 的 MCP 配置设置 `ONE_STATUS_TOOL_GATEWAY_URL`。

## One Status Cloud

面向多设备同步的生产部署只运行密文 Sync API。服务器保存账号元数据、设备 presence 和加密 Status，不配置用户 Status Key：

```bash
export ONE_STATUS_SSH_HOST=124.220.104.225
export ONE_STATUS_SSH_USER=ubuntu
export ONE_STATUS_DOMAIN=os.furesta.top
export ONE_STATUS_ACME_EMAIL=you@example.com
export ONE_STATUS_SEED_DB=/path/to/one-status.sqlite
export ONE_STATUS_SSH_IDENTITY="$HOME/.config/one-status/deploy/lhins-8owupwdq-ed25519"
./scripts/deploy-production.sh
```

生产拓扑、备份和恢复步骤见 [云端部署](deploy/README.md)。

迁移数据库后运行 `one-status use-server --url https://...`。该命令会先验证远端设备 session 和 Status 解密，再原子更新本机 profile。

## Trusted Remote MCP

HTTP 模式适合部署到用户信任的 VPS、容器或私有运行环境：

```bash
export ONE_STATUS_URL='https://status.example.com'
read -rsp 'Device token: ' ONE_STATUS_TOKEN; export ONE_STATUS_TOKEN; printf '\n'
read -rsp 'Status Key: ' ONE_STATUS_STATUS_KEY; export ONE_STATUS_STATUS_KEY; printf '\n'
read -rsp 'MCP bearer: ' ONE_STATUS_MCP_BEARER_TOKEN; export ONE_STATUS_MCP_BEARER_TOKEN; printf '\n'

one-status mcp --transport http --host 127.0.0.1 --port 3000
```

MCP endpoint 为 `http://127.0.0.1:3000/mcp`，存活检查为 `/health`，上游就绪检查为 `/ready`。反向代理连接本机端口并负责公网 HTTPS；不要直接暴露该 HTTP 端口。Bearer 至少需要 32 字节，并且不能复用 `ONE_STATUS_TOKEN`。

Codex 连接线上 endpoint：

```bash
read -rsp 'Remote MCP bearer: ' ONE_STATUS_REMOTE_TOKEN; export ONE_STATUS_REMOTE_TOKEN; printf '\n'
codex mcp add one-status-remote \
  --url https://mcp.example.com/mcp \
  --bearer-token-env-var ONE_STATUS_REMOTE_TOKEN
```

Docker Compose：

```bash
docker compose up --build
```

HTTP MCP 运行时持有 Status Key，属于受信任设备。面向陌生用户的共享托管网关需要新的密钥协议，当前版本不提供该部署形态。更多说明见 [在线部署](docs/deployment.md)。

## 工程命令

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack:local
pnpm brew:install:local
pnpm check
pnpm demo
```

## 安全边界

- 账号密码只用于服务端认证，不参与 Status Key 派生。
- Status Key 在首台设备本地随机生成，不上传服务端。
- 服务端可见账号、设备、版本、时间和密文大小等元数据。
- MCP 进程可以读取解密后的 Status；Agent 只能通过已暴露的 MCP 工具获得返回内容。
- macOS 默认 profile 的设备 Token 与 Status Key 存入系统 Keychain，磁盘文件只保留非敏感元数据和随机 Keychain 引用。显式 profile path 仍使用权限为 `0600` 的便携文件格式；Windows Credential Manager 与 Linux Secret Service 尚待接入。
- OAuth bundle 跨设备同步前使用 HKDF 派生密钥和 AES-256-GCM 二次加密；云端与 Agent 的 Status 返回都不含原始 Provider Token。
- 设备 session 有效期为 30 天，可通过 `logout` 或设备撤销立即失效；创建新 session 时会清理过期记录。
- 本地开发 API 使用明文 HTTP。任何跨机器环境都必须部署 TLS。
- MCP 的 `ONE_STATUS_URL`、`ONE_STATUS_TOKEN`、`ONE_STATUS_STATUS_KEY` 必须整组提供；未提供时整组读取本地 profile。
- `ONE_STATUS_TOOL_GATEWAY_URL` 与 Status Sync 地址独立；远端同步场景默认使用本机 `http://127.0.0.1:8787`。
- 网络请求默认 10 秒超时，可用 `ONE_STATUS_TIMEOUT_MS` 调整。
- 当前整份 Status 文档作为一个密文 envelope 同步，适合验证体验；规模化版本将迁移到逐记录加密与变更游标。
- 当前 profile 与 Coding Agent 运行在同一个操作系统用户下。本版本只接入用户信任的本地 Agent；Keychain 访问仍受同一用户会话和系统授权策略约束。
- HTTP MCP 在非回环地址上强制 bearer token；每个 MCP session 使用独立 server/transport，并带空闲回收和数量上限。
- 无 bearer 的回环 HTTP MCP 会校验 `Host` 与 `Origin`，阻断 DNS rebinding 请求。
- 线上 HTTP MCP 持有 Status Key，需要作为受信任设备运维。
- 服务端幂等 receipt 只保存逻辑摘要和结果版本，每用户最多 10,000 条并保留 30 天。

详细设计见 [Phase 1 技术路线](docs/technical-roadmap.md)、[LobeHub MCP 参考记录](docs/lobehub-mcp-reference.md) 和 [威胁模型](docs/threat-model.md)。

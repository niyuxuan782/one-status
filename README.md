# One Status

**一处管理所有设备上的 AI 工具、密钥、模型和记忆。**

One Status 是跨设备的个人 AI 控制中心。它自动扫描 Codex、Claude Code、Cursor 等工具的本机配置，把模型 API Key、常用账号、SSH、云平台凭据、卡密和其他可复用 Secret 收进加密密钥钱包，并持续同步项目、记忆、连接与工作状态。

```text
设备 -> AI 工具 -> 密钥钱包 -> 可配模型 -> 使用与同步状态
```

[官网](https://niyuxuan782.github.io/one-status/) · [下载最新版](https://github.com/niyuxuan782/one-status/releases/latest) · [安装文档](docs/installation.md) · [Open Core](docs/open-core.md)

> 当前桌面导航收敛为：概览、密钥钱包、项目、记忆、连接、安全。Handoff 保留在 CLI 与 Agent 工作流中，Capability Pack 位于连接详情中，记忆由后台持续生成和整理。

## 核心体验

### 概览

打开 One Status，先看到所有设备的实时状态：

```text
Ryan's MacBook Pro                         在线
├── Codex          GPT-5.6 Sol    可配 7 个模型    近期 24.8M tokens
├── Claude Code    Claude Opus    可配 4 个模型    近期 8.1M tokens
└── Cursor         未配置          可配 5 个模型    --

Office Mac mini                            离线 · 18 分钟前
├── Codex          GPT-5.4        可配 6 个模型    近期 9.7M tokens
└── Claude Code    Claude Sonnet  可配 3 个模型    近期 3.2M tokens
```

概览只保留高频信息：

- 设备在线状态、系统与后台版本
- 已安装的 AI 工具及当前模型
- 每个工具可以切换到哪些模型
- Codex、Claude Code 本机会话日志中的近期 Token 与请求量
- 配置健康、待同步与失败状态

### 密钥钱包

密钥钱包接管过去分散的模型配置入口。后台以只读方式扫描所有已登记设备的 Agent 配置、Codex 的全部 `model_providers`、环境变量引用，以及 CC Switch 保存的 Codex / Claude Profile，在本机识别可用 Endpoint、协议、密钥引用与模型列表。

```text
扫描设备配置
-> 本机识别密钥、Endpoint 与请求格式
-> 加密写入钱包
-> 每条凭据独立加密并同步到 Cloud Vault
-> 选择设备、工具和模型
-> Model Gateway 转换目标工具协议
-> 本机原子应用并报告结果
```

同一钱包也保存用户交给 Agent 的其他可复用凭据：

```text
用户提供账号、密码、Token、SSH、云凭据或卡密
-> Remote Agent 调用 credentials_request_approval 提交精确写入摘要
-> 用户在密钥钱包批准，Agent 取得 10 分钟一次性 approvalToken
-> Agent 同轮调用 credentials_register
-> One Status 加密存储并同步
-> 后续任务按用途、服务、主机、账号和项目匹配
-> credentials_get 只为当前任务返回所需 Secret
-> 凭据轮换时用同一审批流程调用 credentials_update 更新原条目
```

通用条目支持 `account`、`ssh`、`cloud_console`、`github`、`database`、`api`、`oauth`、`license`、`card_key`、`model`、`email`、`vpn`、`certificate`、`signing`、Registry、域名、远程桌面、Webhook 和自定义类型。列表、匹配和普通响应只返回脱敏元数据；Agent 明文读取与用户查看都会留下不含 Secret 的云端审计记录。

当前本机 Model Gateway 支持 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages、Azure OpenAI 和 Ollama 常用接口。Codex 统一接收 Responses，Claude Code 统一接收 Anthropic Messages；上游密钥继续留在 Permission Vault，Agent 配置只保存本机 Gateway Token。OpenAI 来源可以配置到 Claude Code，Anthropic 来源也可以配置到 Codex。Cursor 的原生模型选择器尚未公开自定义 Provider 写入接口，当前版本会明确阻止配置，等待 One Status Cursor 扩展接管。

安全交互保持简单：

- **查看或复制密钥**：必须输入钱包密码。
- **初始钱包密码**：`123456`，可以在密钥钱包页修改；OPAQUE 保证密码不进入服务端。
- **切换模型**：无需输入钱包密码，后台只使用已授权的加密引用。
- **Agent 调用模型**：常规模型请求使用本机 Gateway Token；明确请求模型凭据时可通过 `credentials_get` 获取当前任务所需 API Key。
- **Agent 使用凭据**：无需钱包密码，受 Agent、项目、用途和标签策略约束；返回值禁止写入普通 Status、Persona、Activity 与错误信息。
- **远程凭据写入**：登记、更新和删除必须先在密钥钱包批准精确请求；审批 Token 绑定 Agent Session、操作、参数与 10 分钟有效期，使用后立即失效。
- **设备同步**：Cloud Vault 为每条凭据生成独立 DEK，使用 AES-256-GCM 加密，再由腾讯云 KMS 包装 DEK。
- **配置写入**：先预览目标文件，在线设备原子应用，失败时恢复原配置；离线设备保存加密意图。

密钥详情显示协议、Endpoint 域名、兼容工具、可配模型、最后验证时间和当前授权。本机绝对路径不会随钱包同步，普通 Status、Agent 上下文与 Activity 日志不会保存密钥明文。

### 记忆

记忆页面统一展示用户偏好、项目决策、工作习惯、长期目标和待确认观察。后台记忆生成机制从用户允许的数据源提炼结构化候选：

- Agent 对话中的明确记忆请求
- 项目 README、Instructions 与 Handoff
- Git commit、已完成任务和架构决策
- 语言风格、技术习惯和重复出现的偏好

每条记录保留观察时间、来源 Agent、项目、置信度和出现次数。用户可以确认、编辑、删除或禁止某一类别继续生成。完整原始会话默认留在本机，跨设备同步经过 E2EE 的结构化记忆。

### 连接

GitHub、Google Calendar、Slack 等服务统一出现在连接页面。每个连接直接显示它能提供的工具能力、授权范围和 Agent 访问策略：

```text
GitHub                         已连接
能力：仓库读取 · Issue 创建 · PR 评论
Agent：Codex 读写 · Claude Code 只读

Google Calendar               已连接
能力：日程读取 · 空闲时间查询 · 创建日程
Agent：Codex 读取 · Claude Code 禁止
```

Capability Pack 继续作为内部能力定义和 Adapter 输入，由连接页面承载安装、授权与管理体验。第三方服务只连接 One Status 一次，每个 Agent 再连接 One Status Gateway。

### 项目与 Handoff

项目页面保留项目元数据和任务状态。GitHub 映射、同步状态及 Claude Code / Codex Handoff 继续由后台、CLI 和 Agent 工作流处理：

```text
设备 A 采集 branch / commit / dirty state
-> 生成 HANDOFF.md 与 .one-status/handoff.json
-> Secret 扫描和用户确认
-> 推送 GitHub 并同步加密引用
-> 设备 B 校验精确 commit 与文件摘要
-> Continue with Codex / Claude Code
```

Git 与测试事实由程序采集，Agent 负责目标、决策、完成项和下一步。项目代码与大文件由 GitHub 承载，本机绝对路径按设备独立保存。

命令行可以调用同一条工作流：

```bash
one-status handoff --project one-status --agent claude-code
one-status handoff --project one-status --agent claude-code --publish
```

## 安装

### Desktop App

macOS、Linux：

```bash
curl -fsSL https://niyuxuan782.github.io/one-status/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://niyuxuan782.github.io/one-status/install.ps1 | iex
```

### Homebrew

桌面 App：

```bash
brew tap niyuxuan782/tap
brew install --cask niyuxuan782/tap/one-status
```

CLI、MCP 与本机后台服务：

```bash
brew tap niyuxuan782/tap
brew trust --formula niyuxuan782/tap/one-status 2>/dev/null || true
brew install --formula niyuxuan782/tap/one-status
brew link --overwrite --force niyuxuan782/tap/one-status
brew services start niyuxuan782/tap/one-status
```

### CLI

```bash
curl -fsSL https://niyuxuan782.github.io/one-status/install.sh | bash -s -- --cli
one-status app
```

安装器从 GitHub Releases 下载原生产物并校验 `SHA256SUMS.txt`。CLI 安装会同时安装对应平台的 Device Sidecar。`v0.9.0` 先公开未公证预览，再由 GitHub Actions 构建 Developer ID 版本并提交 Apple；Homebrew stable 会在 stapling 与 Gatekeeper 验证完成后更新。Windows Authenticode 仍待接入。

[查看最新 Release 附件](https://github.com/niyuxuan782/one-status/releases/latest) · [阅读完整安装文档](docs/installation.md)

## 隐私边界

- Status Key 在首台设备本地生成；云端只保存由 OPAQUE `exportKey` 经 HKDF 派生密钥加密后的封装密文。
- 账号密码和钱包密码只在客户端参与 OPAQUE，Sync API、OAuth Server 与 Vault Service 只接收协议消息。
- Memory、Preferences、Task State 与配置意图继续在设备端 E2EE。
- 密钥钱包持久层只保存凭据密文和 KMS Wrapped DEK；授权请求期间，隔离的 Vault Runtime 只在内存中解密指定凭据。
- 查看或复制密钥需要钱包密码，日常模型切换不会显示密钥明文。
- macOS 的设备 Token 与 Status Key 默认存入系统 Keychain。
- Desktop 概览可开启开机自启动；系统登录只启动 `127.0.0.1:8787` 后台，点击 App 时再显示界面。
- OAuth Token 与 API Key 保存在加密 Vault；同步前再次使用设备状态密钥加密。
- Agent 通过 One Status Gateway 获得按 action 控制的连接能力，并可按用途读取用户允许的钥匙串条目。
- 写操作和外部副作用要求精确参数审批，Activity 只保存脱敏审计信息。
- 原始 Agent 会话默认留在本机。

[Threat Model](docs/threat-model.md) 记录当前安全假设与剩余风险。

## Agent 接入

云端和移动端 Agent 使用 OAuth 2.1 + PKCE 连接：

```text
https://mcp.os.furesta.top/mcp
```

Remote MCP 读取 Profile、Context、Memory 和云端密钥钱包；Calendar、Slack、GitHub 等设备连接通过出站 WSS 路由到在线 Desktop。设备离线时，状态和本机连接调用返回明确的 `device_offline`，Cloud Vault 仍可按授权独立工作。

Codex：

```bash
codex mcp add one-status \
  -- one-status mcp --transport stdio --agent codex
```

Claude Code：

```bash
claude mcp add --scope user one-status \
  -- one-status mcp --transport stdio --agent claude-code
```

连接后，Agent 先通过 `tools_list` 查看连接允许的第三方 action，再用 `tools_execute` 调用 One Status Gateway。用户提供可复用凭据时，Agent 会自动使用 `credentials_register`；凭据变化时使用 `credentials_update`；任务需要时按 `credentials_resolve`、`credentials_get` 的顺序选取。模型 API 的供应方式不会改变 Gateway 权限边界。

## 开发

环境要求：Node.js 22+、pnpm 10+、Rust stable。

```bash
git clone https://github.com/niyuxuan782/one-status.git
cd one-status
pnpm install
pnpm --filter @one-status/desktop dev
```

提交前运行：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm demo
```

当前系统由 Desktop、Local Background Service、Agent Adapters、Device Sidecar、E2EE Status Cloud、Key Vault、Connections Gateway 与 GitHub Handoff 组成。Desktop、CLI、MCP、加密实现和 Sync API 使用 Apache-2.0。Device Sidecar 保留 CC Switch 3.19.2 的固定来源 commit、MIT notice 与版权声明，详情见 [`apps/device-sidecar/SOURCES.md`](apps/device-sidecar/SOURCES.md)。

## 文档

- [安装与发布](docs/installation.md)
- [产品架构](docs/product-architecture.md)
- [Provider 集成](docs/provider-integrations.md)
- [Open Core](docs/open-core.md)
- [云端部署](docs/deployment.md)
- [Threat Model](docs/threat-model.md)
- [技术路线](docs/technical-roadmap.md)

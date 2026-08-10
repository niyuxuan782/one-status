# One Status

**一处管理所有设备上的 AI 工具、密钥、模型和记忆。**

One Status 是跨设备的个人 AI 控制中心。它自动扫描 Codex、Claude Code、Cursor 等工具的本机配置，把可用密钥和模型能力收进端到端加密的密钥钱包，并持续同步项目、记忆、连接与工作状态。

```text
设备 -> AI 工具 -> 密钥钱包 -> 可配模型 -> 使用与同步状态
```

[官网](https://niyuxuan782.github.io/one-status/) · [下载 v0.8.0](https://github.com/niyuxuan782/one-status/releases/tag/v0.8.0) · [安装文档](docs/installation.md) · [Open Core](docs/open-core.md)

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
-> 本机识别密钥与模型能力
-> 加密写入钱包
-> E2EE 同步到其他设备
-> 选择设备、工具和模型
-> 本机应用并报告结果
```

安全交互保持简单：

- **查看或复制密钥**：必须输入钱包密码。
- **初始钱包密码**：`123456`，可以在安全页修改；服务端不保存密码明文。
- **切换模型**：无需输入钱包密码，后台只使用已授权的加密引用。
- **Agent 调用模型**：拿到受控调用能力，不接触钱包中的密钥明文。
- **设备同步**：钱包条目在客户端加密后上传，云端保存密文 envelope。
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

安装器从 GitHub Releases 下载原生产物并校验 `SHA256SUMS.txt`。CLI 安装会同时安装对应平台的 Device Sidecar。当前桌面包尚未完成 Apple Developer ID notarization 和 Windows Authenticode 签名，操作系统会执行正常的安全检查。

[查看全部 v0.8.0 附件](https://github.com/niyuxuan782/one-status/releases/tag/v0.8.0) · [阅读完整安装文档](docs/installation.md)

## 隐私边界

- Status Key 在首台设备本地生成，不上传服务端。
- 密钥钱包、Memory、Preferences、Task State 与配置意图在设备端加密。
- 查看或复制密钥需要钱包密码，日常模型切换不会显示密钥明文。
- macOS 的设备 Token 与 Status Key 默认存入系统 Keychain。
- OAuth Token 与 API Key 保存在加密 Vault；同步前再次使用设备状态密钥加密。
- Agent 通过 One Status Gateway 获得按 action 控制的调用能力。
- 写操作和外部副作用要求精确参数审批，Activity 只保存脱敏审计信息。
- 原始 Agent 会话默认留在本机。

[Threat Model](docs/threat-model.md) 记录当前安全假设与剩余风险。

## Agent 接入

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

连接后，Agent 先通过 `tools_list` 查看连接允许的第三方 action，再用 `tools_execute` 调用 One Status Gateway。模型 API 的供应方式不会改变 Gateway 权限边界。

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

# One Status Desktop-first MVP 技术路线

## 产品目标

第一阶段验证一句话：

> 换设备，换 Agent，继续当前工作。

验收场景固定为两个设备、两个 Agent、同一个账号。Agent A 写入项目与偏好，Agent B 无需重新解释即可继续任务；Agent B 更新进度后，Agent A 重启仍能获得最新状态。

## 当前架构

```text
Device A / Agent A                         Device B / Agent B
       |                                          |
 Local MCP + Status Key                    Local MCP + Status Key
       |        Encrypt / Decrypt locally         |
       +------------------+-----------------------+
                          |
                    Sync API + Auth
                          |
              Account / Device / Ciphertext
```

代码边界：

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| Protocol | `packages/protocol` | Status Schema、API DTO、密文 envelope |
| Crypto | `packages/crypto` | Status Key、AES-256-GCM、AAD、完整性校验 |
| Client | `packages/client` | HTTP SDK、客户端解密、冲突重试 |
| Local Config | `packages/local-config` | macOS Keychain、便携 profile 与安装身份配置 |
| API | `apps/api` | 账号、设备会话、密文同步、CAS 版本控制 |
| CLI | `apps/cli` | 注册、登录、状态读写与诊断 |
| MCP | `apps/mcp` | Agent 可调用的 Status 工具 |
| Demo | `apps/demo` | 双设备、双 MCP 进程的端到端证明 |
| Local Inventory | `apps/api/src/local-inventory.ts` | 只读发现项目、Agent、MCP、Skills、Plugins、Rules |
| Production Deploy | `deploy` | 密文 Sync API、Caddy HTTPS、持久化与备份 |

## Status v2

Status 顶层从第一天保留完整产品边界：

```ts
interface StatusDocument {
  schemaVersion: 2;
  identity: Identity;
  preferences: Record<string, PreferenceValue>;
  memory: MemoryEntry[];
  projects: Record<string, Project>;
  workspace: WorkspaceState;
  permissions: PermissionState;
  tools: ToolState;
  tasks: Record<string, TaskState>;
}
```

首轮实际使用三个记忆层级：

- `user`：稳定习惯、技术偏好、输出风格
- `project`：项目技术栈、目标、决策和长期上下文
- `session`：短生命周期的任务交接信息

所有业务字段进入同一个加密 envelope。服务端无法针对明文内容建立索引；搜索在本地 MCP 进程中完成。

## 账号、设备与密钥

账号密码经 `scrypt` 加盐后保存。设备登录成功后获得随机会话 Token，服务端只保存 Token 的 SHA-256 摘要。

Status Key 是独立的 256 位随机值：

1. 首台设备本地生成并显示 Status Key。
2. 客户端加密空 Status，注册事务原子创建账号、设备会话和 revision 1 vault。
3. Status 使用 AES-256-GCM 加密，AAD 绑定协议版本和同步 revision。
4. 新设备通过离线渠道取得 Status Key。
5. 服务端始终接收密文 envelope。

当前新设备凭账号密码可以下载密文，只有持有 Status Key 的设备可以解密。后续将加入已有设备审批、设备公钥和 Root Key 封装，让新设备授权拥有明确的可撤销流程。

## 同步协议

```text
GET /v1/status
-> { version, envelope, updatedAt }

PUT /v1/status
<- { mutationId, mutationDigest, baseVersion, envelope }
-> { version, envelope, updatedAt, deduplicated? }
```

写入执行 compare-and-swap：

1. 客户端读取版本 `N`，校验 envelope revision 并解密。
2. 本地应用单项 mutation。
3. 客户端用目标 revision `N+1` 生成 AAD，加密后以 `mutationId`、逻辑摘要和 `baseVersion=N` 提交。
4. 服务端版本仍为 `N` 时写入 `N+1`。
5. 出现 `409 version_conflict` 时重新读取并再次应用该 mutation。
6. 提交响应丢失时重送同一 `mutationId` 和摘要，服务端返回去重结果。
7. 已使用 ID 携带不同逻辑摘要时返回 `409 mutation_id_conflict`。

服务端保存固定大小的 mutation receipt 来保证追加操作幂等，receipt 包含逻辑摘要、结果版本和创建时间。每用户最多保留 10,000 条，保留期 30 天。逐记录同步上线后将增加 append-only revision 与批量 cursor。

## Phase 1 里程碑

### M0：Core Vertical Slice（当前）

- [x] Account 注册与登录
- [x] Device session
- [x] Session logout 与设备撤销
- [x] Status v1 Schema
- [x] 客户端 E2EE
- [x] 密文云端同步协议
- [x] 冲突检测与重试
- [x] Mutation 幂等与响应丢失恢复
- [x] Mutation receipt 保留与清理
- [x] Revision-bound AAD
- [x] 原子注册与加密 vault 初始化
- [x] 非回环 HTTPS 约束与请求超时
- [x] CLI
- [x] stdio MCP Server
- [x] Streamable HTTP MCP Server
- [x] npm、Homebrew、Docker 分发骨架
- [x] 两个独立 Agent 进程 Demo
- [x] 服务端持久化明文泄漏检查

### M1：可持续同步

- [ ] 每条 Status record 独立加密
- [ ] append-only revision 与变更 cursor
- [ ] 离线 pending mutation 队列
- [ ] 删除 tombstone 与版本历史
- [ ] Keychain / Credential Manager / Secret Service（macOS 默认 profile 已完成）
- [ ] 设备公钥、已有设备审批与 Root Key 封装
- [ ] Root Key 恢复包和密钥轮换
- [ ] PostgreSQL 与生产迁移

### M2：Permission Vault

- [x] 本地加密 Permission Vault 与图形界面
- [x] Permission Vault 二次加密跨设备同步
- [x] OAuth Authorization Code、PKCE、state 防重放和 Token refresh
- [x] Google、GitHub、Slack Provider adapter
- [x] Google Calendar OAuth
- [x] GitHub 真实凭据接入（本机 `gh` 导入）
- [x] Slack OAuth
- [x] Service Permission → Agent Permission → Action Permission
- [ ] Agent 加密身份与短时调用凭证
- [x] `tools_list` 与 `tools_execute`
- [x] Gateway 优先的 MCP instructions 与缺失授权引导
- [x] Action 风险元数据（`readOnly`、`requiresConfirmation`）
- [x] Calendar 日历列表、单事件与忙闲查询
- [x] GitHub Issue、Pull Request 与仓库内容读取
- [x] Slack 消息历史、搜索与受确认发送
- [x] 调用审计与显式拒绝记录

基础实现覆盖三方真实 OAuth endpoint、14 个固定 action、Agent 级授权、scope 过滤、Token 刷新和脱敏审计。Google Calendar、GitHub 与 Slack 已完成真实账号、两种 Agent grant、跨 Vault 恢复和 Provider API 调用。GitHub 首版可导入本机 `gh` 会话，生产权限模型将迁移到 GitHub App installation token。

Agent instructions 将 Calendar、Slack、GitHub 和后续服务统一导向 One Status Gateway。Agent 先调用 `tools_list` 获取当前允许的能力，再调用 `tools_execute`；Provider Token 不进入模型上下文。读取 action 可以直接运行，外部写入 action 需要风险提示和用户明确确认。缺少连接、scope 或 grant 时，Agent 引导用户回到 One Status 完成对应设置。

Slack adapter 已切换到 user-token public client PKCE：`user_scope`、S256 challenge、`authed_user` token、无 Client Secret refresh、单次 refresh token 轮换和 `auth.revoke` 均有协议级测试。可导入 `docs/slack-app-manifest.yaml` 创建对应 Slack App。

### M3：产品体验

- [x] 图形化首次注册、登录与设备管理
- [x] 项目、记忆、偏好编辑器
- [ ] 同步状态与冲突提示
- [x] 权限授权和 Agent 防火墙 UI
- [x] 稳定 installation ID、heartbeat 与 90 秒在线状态
- [x] Codex / Claude Code 本机 Inventory
- [x] MCP、Skills、Plugins、Rules 脱敏清单
- [x] 本机项目显式确认导入与路径映射
- [x] Memory 候选确认、来源与编辑
- [x] Task State 编辑器
- [x] Activity 与 Security 页面
- [ ] 跨平台安装器
- [x] 云端 Docker、Caddy、持久化与备份配置
- [x] 腾讯云 VPS 公网部署、TLS 与健康检查验收

### M4：GitHub Handoff

- [x] 本机 checkout 与便携 Project 映射
- [ ] GitHub OAuth 真实账号闭环
- [x] 手动 `Publish Handoff`（Secret 扫描、显式确认、commit、push 与远端 commit 校验）
- [x] 程序采集 branch、commit、dirty state；测试状态明确记录为 `not_run`
- [x] Secret scan 与操作确认
- [x] `HANDOFF.md` 与 `.one-status/handoff.json`
- [x] 源 commit 与 Handoff 文件 SHA-256 写入加密 Status 并在打开时校验
- [x] 精确 commit 的 `Open and Continue`（clone 或 clean checkout update）
- [x] Codex 与 Claude Code macOS Terminal Adapter
- [x] 本机 Handoff Activity timeline

## Phase 1 完成标准

Core 进入可邀请用户测试的标准：

- 新设备加入全流程少于 90 秒
- 同步延迟 P95 小于 3 秒
- 网络中断后变更可以恢复上传
- 两台设备并发写入不会静默丢失数据
- 服务端数据库、日志和错误上报不含 Status 明文、密码、Status Key、原始 Token
- 设备撤销后立即失去同步资格
- MCP stdout 只承载协议消息
- `pnpm check` 与 `pnpm demo` 可从干净环境稳定复现

## 明确延后

Phase 1 期间不进入 Marketplace、Reputation、Agent Economy、Token、链上资产、Agent Discovery 和大规模编排。它们依赖真实用户、稳定身份、权限和交接协议，排期放在 Core 与 Tool Layer 获得使用数据之后。

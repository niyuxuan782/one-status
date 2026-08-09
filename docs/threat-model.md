# One Status v0.1 威胁模型

## 保护资产

- Status 明文：身份、偏好、记忆、项目、工作区和任务
- Status Key
- 账号密码
- 设备会话 Token
- 短期 Agent credential
- 后续接入的 OAuth Token 与工具调用权限

## 当前信任边界

可信组件：

- 用户控制的本地设备
- 本地 One Status CLI 与 MCP 进程
- 操作系统提供的文件权限

低信任组件：

- 同步 API 与数据库
- 网络链路
- 接入的 Agent

服务端可以观察账号、设备、请求时间、密文大小和版本。服务端持有的密文无法在缺少 Status Key 时解密。

## 已覆盖风险

| 风险 | 当前控制 |
| --- | --- |
| 数据库读取 | AES-256-GCM 密文，Status Key 不上传 |
| 密文篡改与跨 revision 替换 | GCM authentication tag 与 revision-bound AAD |
| 密码泄漏 | `scrypt` 独立 salt 与 constant-time comparison |
| 会话库泄漏 | 随机 Token 只以 SHA-256 摘要保存 |
| 并发覆盖 | 版本条件写入与客户端冲突重试 |
| 提交响应丢失 | 稳定 `mutationId` 与服务端幂等结果 |
| Mutation ID 误复用 | 逻辑摘要绑定与明确的 `mutation_id_conflict` |
| 空 vault 错误密钥 | 注册事务原子写入首个加密 envelope |
| 凭据端点混用 | MCP 环境凭据整组加载，非回环端点强制 HTTPS |
| 无响应服务 | 客户端统一请求超时 |
| HTTP MCP 未授权访问 | 非回环监听强制独立 bearer token |
| MCP session 状态混用 | 每个 session 独立 server/transport |
| Session 资源耗尽 | session 数量上限、请求大小限制和空闲回收 |
| 回环 HTTP DNS rebinding | 无 bearer 模式校验 `Host` 与 `Origin` |
| 容器明文端口误暴露 | Compose 默认仅发布到宿主机 `127.0.0.1` |
| 弱 bearer 或设备 Token 复用 | bearer 最少 32 字节，且与上游 Token 比较拒绝复用 |
| MCP 协议污染 | 运行日志仅写 stderr |
| 本地配置误读 | macOS 默认 profile 仅含 Keychain 引用；Token 与 Status Key 存入系统 Keychain；文件权限 `0600` |
| 长驻进程继续使用旧凭据 | MCP 每次操作重新加载 profile 或 Secret 文件，并为该次操作固定客户端与 Status Key |
| 跨账号 Status 读取 | 所有 Status 查询绑定认证后的 `userId` |
| OAuth 凭据落盘 | 独立 Permission Vault、AES-256-GCM、独立 256 位本地 key、文件权限 `0600` |
| OAuth 凭据跨设备 | HKDF 派生同步密钥、独立 AES-256-GCM envelope、目标设备本地重新加密 |
| OAuth callback 重放 | state 只保存 SHA-256 摘要、10 分钟 TTL、消费后删除、PKCE |
| Slack Client Secret 落盘 | Slack 使用 public client PKCE，只保存 Client ID；exchange 与 refresh 不发送 Client Secret |
| Dashboard 跨站写入 | 回环 Host 校验、HttpOnly SameSite cookie、Origin 与 CSRF 双校验、CSP |
| Agent 越权调用 | 24 小时 Agent credential 绑定 user、device 与 agent，叠加 connection + agent + action grant 校验、固定 action registry 和 allow/deny 审计 |
| Agent 绕过 Gateway 索要 Token | MCP instructions 要求第三方任务先调用 `tools_list`，无 action 时只提供连接与授权引导 |
| 写 action 未获确认 | `tools_request_approval` 创建绑定用户、Agent、连接、action 和规范化参数的 10 分钟审批；Dashboard 决策后，Gateway 才接受匹配的 `approvalId` |
| Provider API 被当成任意 HTTP 代理 | 每个 action 固定 endpoint、method、参数 schema、响应 schema 和大小上限 |

## 已知限制

- Windows 与 Linux 默认 profile 尚未接入 Credential Manager 或 Secret Service；显式自定义 path 为便携场景保留明文 `0600` 文件模式。
- 账号登录会创建可下载密文的新设备会话，尚未要求已有设备批准。
- 用户需要通过离线渠道传递 Status Key。
- 整份 Status 共用一个 envelope，大文档会增加同步流量和冲突概率。
- 服务端仍可同时回放旧版本号和旧密文，客户端目前没有设备侧可信版本锚点。
- 客户端在线执行 mutation，尚未持久化离线写入队列。
- 本地 MCP 对当前 Status 拥有完整解密能力，细粒度 Agent 数据授权尚未实现。
- 本地 Permission Vault key 与本机密文位于同一受信任设备，尚未接入系统安全存储；同步 bundle 的派生密钥依赖 Status Key 保密。
- Tool API 使用哈希落库、可撤销且最长 24 小时的 Agent credential；凭据签发仍由设备会话授权，持有设备 Token 的本地进程可以请求其他 `agentId`，设备签名和 Agent 加密身份仍待实现。
- 写 action 已使用 Dashboard 审批和参数绑定；审批记录暂存于单进程内存，服务重启后失效，多实例共享与持久化尚未实现。
- Google、GitHub 与 Slack 已完成真实账号验收；新增 Provider 需要各自 OAuth App、scope 审核和真实账号验收，未建立连接与 Agent grant 时不会出现在 `tools_list`。
- 在线 MCP runtime 持有 Status Key，部署平台管理员可以读取运行时内存和环境变量。
- HTTP MCP bearer 提供 endpoint 访问控制，公网机密性依赖外部 TLS reverse proxy。
- 开发服务器使用 Node.js 内置 SQLite，当前 Node 版本仍标记该 API 为 experimental。
- SQLite 为同步驱动，写锁等待期间仍会短暂阻塞单进程 API；当前锁等待上限为 500ms，繁忙错误返回可重试的 503。
- 本地 HTTP 只适用于回环地址。远程部署需要 TLS、限流、CSRF/Origin 策略和安全响应头。

## 上线前强制项

1. Windows Credential Manager、Linux Secret Service 和后续设备私钥接入系统安全存储。
2. 新设备采用公钥注册、已有设备批准和 sealed Root Key envelope。
3. 短时 access token、可轮换 refresh token 和 Token version。
4. 逐记录密钥派生，AAD 绑定 account、record、revision 和 key version。
5. API 限流、密码爆破防护、TLS、日志全局脱敏和安全审计。
6. OAuth Token 使用独立 Permission Vault，Agent 永远只获得受控动作结果。
7. 加入密钥丢失、设备丢失、恶意服务端、重放、跨账号隔离和日志泄漏测试。

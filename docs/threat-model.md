# One Status v0.1 威胁模型

## 保护资产

- Status 明文：身份、偏好、记忆、项目、工作区和任务
- Status Key
- 账号密码
- 设备会话 Token
- 短期 Agent credential
- OAuth Token、模型 API Key、账号密码、SSH、云平台凭据、卡密与工具调用权限

## 当前信任边界

可信组件：

- 用户控制的本地设备
- 本地 One Status CLI 与 MCP 进程
- 操作系统提供的文件权限
- 隔离的 Vault Runtime 与服务器 root 管理的自托管 KEK

低信任组件：

- 同步 API、Remote MCP 与数据库持久层
- 网络链路
- 接入的 Agent

服务端可以观察账号、设备、请求时间、密文大小和版本。Status 密文无法在缺少 Status Key 时解密。Cloud Vault 的 PostgreSQL 持久层缺少 KEK 时无法解密凭据；Vault Runtime 在授权请求期间具备临时解密能力。

## 已覆盖风险

| 风险 | 当前控制 |
| --- | --- |
| 数据库读取 | Status 与封装后的 Status Key 均为 AES-256-GCM 密文 |
| 密文篡改与跨 revision 替换 | GCM authentication tag 与 revision-bound AAD |
| 密码泄漏 | RFC 9807 OPAQUE；服务端只保存 registration record，密码不进入 Sync API、OAuth Server 或 Vault Service |
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
| 通用钥匙串落盘 | 每条凭据使用独立 DEK 和 AES-256-GCM；PostgreSQL 只保存密文、IV、Auth Tag 与 KMS Wrapped DEK |
| 自托管 KEK 泄露到发布配置 | Canonical KEK 为服务器 root:root `0600` 文件；容器挂载副本位于 root:root `0700` 目录并保持 uid 1000、mode `0400`；容器环境、release env、数据库与普通备份不保存 KEK |
| 自托管 KEK 泄露到进程参数 | root-owned Compose 启动器原子刷新受限挂载副本；部署、回滚、备份和恢复命令只传文件路径与 Compose 参数 |
| 部署 Secret 泄露到 SSH 参数 | release env 与长期 bootstrap identity 均通过 SSH stdin 写入受限临时文件，再原子改名 |
| Wrapped DEK 混用 | `oswk1.self-hosted-kek` 前缀和 envelope provider/version；AAD 绑定 provider、version、KEK ID 与完整凭据上下文 |
| 错误 KEK 启动 | PostgreSQL 保存 KEK 绑定哨兵；Vault 就绪前验证历史 Wrapped DEK，并执行随机 DEK 的 generate、wrap、unwrap round trip；失败时服务不监听端口 |
| 部署误覆盖 KEK | 部署脚本比较现有 Secret，值不一致时拒绝覆盖并要求先执行 rewrap migration |
| 通用钥匙串迁移 | Desktop 经 TLS Backfill；Vault Runtime 立即重新加密，并用一次性 HMAC 摘要校验数量和内容 |
| 本机旧钱包覆盖云端新密钥 | Backfill 只接受相同记录重放或补齐缺失 ID；内容差异或云端额外条目返回 `migration_conflict`；钱包 OPAQUE record 独立迁移 |
| Agent 凭据登记与读取 | Remote OAuth Token、最长一小时的 Vault Session、Agent Grant 与凭据策略共同约束 user、agent、project 和 purpose |
| Agent 伪造 Project ID | Project ID 必须包含在服务端签发的 Vault Session 中；请求体不能扩大 Session 范围 |
| Remote Agent 修改钱包 | `credentials_request_approval` 生成绑定 Session、操作和完整参数 HMAC 的 10 分钟一次性 Token；密钥钱包负责批准或拒绝 |
| Secret 误放明文索引 | 服务端与 MCP Schema 拒绝 password、token、API key、private key、client secret 等 Secret 字段名进入 `fields` |
| 凭据元数据响应 | register、list、resolve、update 和 delete 统一遮罩全部 Secret；`credentials_get` 只返回当前任务读取结果 |
| 凭据错误与日志泄漏 | MCP 客户端将凭据 API 失败统一为固定错误；普通 Status、Persona、Activity 与审计记录不保存 Secret |
| 凭据轮换产生重复项 | MCP instructions 要求先 resolve 原条目，再调用 update；Secret 按字段合并并保留稳定 ID |
| Agent 凭据读取审计 | 每次读取记录 Agent、项目、用途、决策、原因与时间，不记录明文 Secret |
| 凭据写入与审计不一致 | Cloud Vault 凭据变更与对应审计事件使用同一个 PostgreSQL 事务提交 |
| Remote OAuth 重放与撤销 | Authorization Code + PKCE；Refresh Token 轮换；重放或撤销会原子失效同 family 的 Access/Refresh Token |
| Remote Status 过度暴露 | Desktop 只返回 Profile、Context 或 Memory 的最小投影视图，Relay 不接收完整解密 Status |
| Relay 本机暴露 | Desktop 主动建立出站 WSS，本机不开放公网端口；异常 Upgrade 路径立即关闭 |
| OAuth callback 重放 | state 只保存 SHA-256 摘要、10 分钟 TTL、消费后删除、PKCE |
| Slack Client Secret 落盘 | Slack 使用 public client PKCE，只保存 Client ID；exchange 与 refresh 不发送 Client Secret |
| Dashboard 跨站写入 | 回环 Host 校验、HttpOnly SameSite cookie、Origin 与 CSRF 双校验、CSP |
| Agent 越权调用 | 24 小时 Agent credential 绑定 user、device 与 agent，叠加 connection + agent + action grant 校验、固定 action registry 和 allow/deny 审计 |
| Agent 绕过 Gateway 索要 Token | MCP instructions 要求第三方任务先调用 `tools_list`，无 action 时只提供连接与授权引导 |
| 写 action 未获确认 | `tools_request_approval` 创建绑定用户、Agent、连接、action 和规范化参数的 10 分钟审批；Dashboard 决策后，Gateway 才接受匹配的 `approvalId` |
| Provider API 被当成任意 HTTP 代理 | 每个 action 固定 endpoint、method、参数 schema、响应 schema 和大小上限 |

## 已知限制

- Windows 与 Linux 默认 profile 尚未接入 Credential Manager 或 Secret Service；显式自定义 path 为便携场景保留明文 `0600` 文件模式。
- 新设备默认凭账密直接登录；用户可开启“拒绝新设备登录”，并从其他设备撤销 Session、封禁或解除封禁设备。
- 账号密码和钱包密码只在受信任客户端参与 OPAQUE；服务端持有持久化 ServerSetup 和 registration record。客户端仍需校验服务端静态公钥，ServerSetup 丢失会阻断对应账号登录。
- 整份 Status 共用一个 envelope，大文档会增加同步流量和冲突概率。
- 服务端仍可同时回放旧版本号和旧密文，客户端目前没有设备侧可信版本锚点。
- 客户端在线执行 mutation，尚未持久化离线写入队列。
- 本地 MCP 对当前 Status 拥有完整解密能力，细粒度 Agent 数据授权尚未实现。
- Desktop GUI 迁移期仍保留本机 Permission Vault 副本；Cloud Vault 已成为 Remote MCP 的凭据数据源，删除本机持久副本需要等桌面全部 CRUD 切换完成。
- Tool API 使用哈希落库、可撤销且最长 24 小时的 Agent credential；凭据签发仍由设备会话授权，持有设备 Token 的本地进程可以请求其他 `agentId`，设备签名和 Agent 加密身份仍待实现。
- 写 action 已使用 Dashboard 审批和参数绑定；审批记录暂存于单进程内存，服务重启后失效，多实例共享与持久化尚未实现。
- Google、GitHub 与 Slack 已完成真实账号验收；新增 Provider 需要各自 OAuth App、scope 审核和真实账号验收，未建立连接与 Agent grant 时不会出现在 `tools_list`。
- Vault Runtime、服务器 root、Docker 管理权限和进程内存属于高信任边界；管理员可以读取 KEK，并在授权窗口观察运行时内存。
- Node.js 会主动清零 DEK、明文 Buffer 等可变内存；返回给调用方的 JavaScript 字符串及序列化副本由运行时 GC 管理，无法承诺字节级即时清除。
- PostgreSQL 备份在保留期内包含旧 ciphertext 与 Wrapped DEK；只要同一 KEK 仍可用，备份内的历史密文仍具备可恢复性。删除凭据不会追溯改写已有备份。KEK 丢失会使所有自托管 Vault 记录永久无法恢复。
- 自托管 KEK 降低了服务成本，同时把主机 root 纳入高信任边界；主机完全失陷时，攻击者可能组合 KEK 与数据库备份进行离线解密。
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
6. OAuth Token 继续通过固定 Provider action 使用；通用钥匙串明文只允许经绑定身份的 `credentials_get` 按用途读取。
7. 加入密钥丢失、设备丢失、恶意服务端、重放、跨账号隔离和日志泄漏测试。

# One Status 在线部署

## 推荐部署形态：Sync + Remote MCP + Cloud Vault

生产云运行 Sync API、OAuth 2.1 Authorization Server、Streamable HTTP Remote MCP、出站 WSS Device Relay、Vault Runtime 和 PostgreSQL。Status Key、原始会话和本机路径留在用户设备。Status、Memory 与 Persona 保持 E2EE；Cloud Vault 持久层保存逐条凭据密文和腾讯云 KMS Wrapped DEK。

仓库中的生产栈位于：

```text
deploy/compose.production.yaml
deploy/Caddyfile
deploy/backup.sh
scripts/deploy-production.sh
```

该栈包含 Caddy 自动 HTTPS、登录与注册限流、API、Vault、PostgreSQL、持久化数据目录、健康检查和 SQLite + PostgreSQL 一致性备份。`os.furesta.top` 承载 `/v1/*`、`/oauth/*` 和 `/v1/relay`，`mcp.os.furesta.top` 承载 `/mcp`。官网静态资源、安装脚本和安装包由 GitHub 提供。完整命令见 `deploy/README.md`。

当前生产栈运行在腾讯云轻量应用服务器，DNS A 记录由腾讯云 DNS 管理。Caddy 运行在该实例的 Docker Compose 内，仅承担 TLS 证书、HTTPS 和反向代理，不依赖 Cloudflare 网络服务。

## OPAQUE 长期 Setup

账号密码与密钥钱包密码分别使用独立的 OPAQUE server setup：

- `ONE_STATUS_OPAQUE_SERVER_SETUP`：账号注册与登录；
- `ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP`：密钥钱包查看授权。

两项 setup 只生成一次，作为长期 Secret 独立保存，不能互相复用。更换账号 setup 会使已有账号密码记录失效；更换 Vault setup 会使已有钱包密码记录失效。PostgreSQL、SQLite 备份不包含这两个值，灾难恢复时必须从 Secret Manager 恢复原值。

```bash
install -d -m 0700 "$HOME/.config/one-status/deploy"
npx --yes @serenity-kit/opaque@1.1.0 create-server-setup \
  > "$HOME/.config/one-status/deploy/account-opaque.setup"
npx --yes @serenity-kit/opaque@1.1.0 create-server-setup \
  > "$HOME/.config/one-status/deploy/vault-opaque.setup"
chmod 0600 "$HOME/.config/one-status/deploy/"*.setup

export ONE_STATUS_OPAQUE_SERVER_SETUP="$(tr -d '\r\n' < "$HOME/.config/one-status/deploy/account-opaque.setup")"
export ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP="$(tr -d '\r\n' < "$HOME/.config/one-status/deploy/vault-opaque.setup")"
```

生产 Compose 将两项变量设为必填；部署脚本校验其 Base64URL 格式、长度和相互独立性，并原样写入权限为 `0600` 的 release `production.env`。

## Remote MCP 信任边界

### 信任边界

在线 Desktop 只向 Remote MCP 返回 Profile、Context 或 Memory 的最小投影视图。Remote MCP 不持有 Status Key。需要第三方连接或本机能力时，请求经 WSS 路由到在线 Desktop；设备离线时返回 `device_offline`。

Vault Runtime 独占 KMS 权限。每次凭据读取都经过 OAuth scope、短期 Agent Session、Vault Grant、Agent ID、服务端绑定的 Project ID、purpose、凭据策略、过期时间和撤销检查。远程写入还需要密钥钱包签发的 10 分钟一次性精确审批。明文和 DEK 只在请求内存中存在，请求与结果不写普通日志。

首次钱包 Backfill 会验证完整凭据集合，并由 Vault Runtime 逐条重新加密。后续请求发现云端内容更新或云端额外条目时返回 `migration_conflict`。钱包密码通过独立 OPAQUE registration record 管理。生产稳定并完成 Desktop 全部云端 CRUD 切换前，本机 Permission Vault 继续保留副本。

## 拓扑

```text
Remote Agent -> OAuth 2.1 + PKCE -> Remote MCP
Remote MCP -> WSS Relay -> Online Desktop
Remote MCP -> Vault Service -> Tencent KMS + PostgreSQL ciphertext
Desktop Agent -> stdio MCP -> Local Background Service
```

## 独立本机 HTTP MCP 环境变量

以下变量用于单用户本机或私有 HTTP MCP。生产 Remote MCP 与 Cloud Vault 使用 `deploy/production.env.example` 中的 `ONE_STATUS_VAULT_*`、`TENCENTCLOUD_*` 和 PostgreSQL 配置。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ONE_STATUS_URL` | 是 | HTTPS Sync API URL |
| `ONE_STATUS_TOKEN` | 是 | 设备 session token |
| `ONE_STATUS_STATUS_KEY` | 是 | `os1_` Status Key |
| `ONE_STATUS_MCP_BEARER_TOKEN` | 非回环必填 | Agent 访问 HTTP MCP 的独立 bearer |
| `ONE_STATUS_AGENT_ID` | 否 | 用于申请受绑定凭据并记录 context 的 Agent ID |
| `ONE_STATUS_AGENT_TOKEN` | 远程 Tool Gateway 必填 | 预签发的 `osa1_` Agent credential；回环 Gateway 会自动签发 |
| `ONE_STATUS_MCP_HOST` | 否 | 默认 `127.0.0.1` |
| `ONE_STATUS_MCP_PORT` | 否 | 默认 `3000` |
| `ONE_STATUS_MCP_ENDPOINT` | 否 | 默认 `/mcp` |
| `ONE_STATUS_MCP_PUBLIC_URL` | 否 | 日志展示的公网 URL |
| `ONE_STATUS_MCP_MAX_SESSIONS` | 否 | 默认 `100` |
| `ONE_STATUS_MCP_MAX_SESSIONS_PER_PRINCIPAL` | 否 | 默认每个 OAuth principal `5` |
| `ONE_STATUS_MCP_IDLE_TIMEOUT_MS` | 否 | 默认 30 分钟 |

`ONE_STATUS_TOKEN`、`ONE_STATUS_STATUS_KEY`、`ONE_STATUS_AGENT_TOKEN` 和 `ONE_STATUS_MCP_BEARER_TOKEN` 都支持对应的 `*_FILE` 变量，适合 Docker secrets 与 Kubernetes Secret volume。直接值与文件变量不能同时提供。Bearer 至少需要 32 字节，并且必须与设备 Token 不同。

回环 Tool Gateway 会用设备会话签发最长 24 小时的 `osa1_` Agent credential。之后 `/v1/tools`、审批和执行请求只携带 Agent credential，Gateway 从凭据读取 `userId`、`deviceId` 与 `agentId`。设备 Token 直接访问工具端点会收到 `agent_credential_required`。

三个 One Status 凭据必须整组来自环境变量，或整组来自本地 profile。混合来源会被拒绝。

## Docker

构建：

```bash
docker build -t one-status:0.9.0 .
```

运行：

```bash
export ONE_STATUS_URL=https://status.example.com
read -rsp 'Device token: ' ONE_STATUS_TOKEN; export ONE_STATUS_TOKEN; printf '\n'
read -rsp 'Status Key: ' ONE_STATUS_STATUS_KEY; export ONE_STATUS_STATUS_KEY; printf '\n'
read -rsp 'MCP bearer: ' ONE_STATUS_MCP_BEARER_TOKEN; export ONE_STATUS_MCP_BEARER_TOKEN; printf '\n'

docker run --rm -p 127.0.0.1:3000:3000 \
  -e ONE_STATUS_URL \
  -e ONE_STATUS_TOKEN \
  -e ONE_STATUS_STATUS_KEY \
  -e ONE_STATUS_MCP_BEARER_TOKEN \
  one-status:0.9.0
```

Compose：

```bash
docker compose up --build -d
docker compose ps
```

镜像以非 root `node` 用户运行，提供 `/health`，默认启动 Streamable HTTP MCP。
Compose 和 `docker run` 示例都只向宿主机回环地址发布端口，TLS reverse proxy 从同一宿主机连接该端口。
`/health` 只检查进程存活；`/ready` 会读取并解密最新 Status，Docker 健康检查使用后者，因此上游 API 或设备 Token 失效会反映为 unhealthy。

## TLS

Node 服务监听普通 HTTP，公网前必须放置 TLS reverse proxy，例如 Caddy、Traefik、Nginx 或云负载均衡器。代理需要：

- 保留 `Authorization` header
- 保留 `Mcp-Session-Id` header
- 允许长连接与 SSE
- 关闭过短的响应超时
- 将 `/mcp` 转发到容器 `3000`

不要上传或分享 `docker compose config` 输出，其中会展开通过环境变量提供的 bearer、Status Key 与设备 Token。生产部署优先使用 `*_FILE` 和平台 Secret 管理能力。

## Session 模型

实现采用有状态 Streamable HTTP：

- 每个 initialize 请求创建独立 `McpServer` 与 transport。
- 后续请求通过 `Mcp-Session-Id` 返回同一 transport。
- DELETE 关闭 session。
- 空闲 session 自动回收。
- 达到 session 上限后返回 503。
- 未知 session 返回 404。

该结构避免不同 Agent session 复用已初始化 transport 导致协议错误。

## Agent 配置

Codex：

```bash
read -rsp 'Remote MCP bearer: ' ONE_STATUS_REMOTE_TOKEN; export ONE_STATUS_REMOTE_TOKEN; printf '\n'
codex mcp add one-status-remote \
  --url https://mcp.example.com/mcp \
  --bearer-token-env-var ONE_STATUS_REMOTE_TOKEN
```

Claude Code：

```bash
claude mcp add --transport http \
  one-status-remote https://mcp.example.com/mcp \
  --header "Authorization: Bearer $ONE_STATUS_REMOTE_TOKEN"
```

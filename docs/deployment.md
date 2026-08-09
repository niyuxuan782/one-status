# One Status 在线部署

## 推荐部署形态：Ciphertext Sync Cloud

桌面优先产品的共享云只运行 Sync API。它保存账号、设备 presence、session token hash、mutation receipt 和加密 Status envelope。Status Key、原始会话、本机路径和可解密 Permission Vault 留在用户设备；OAuth bundle 在 Status 内仍是独立密文。

仓库中的生产栈位于：

```text
deploy/compose.production.yaml
deploy/Caddyfile
deploy/backup.sh
scripts/deploy-production.sh
```

该栈包含 Caddy 自动 HTTPS、登录与注册限流、只读 API 容器、持久化 SQLite 数据目录、健康检查和停机一致性备份。`/health` 与 `/v1/*` 进入密文 Sync API，其余路径跳转到 GitHub Pages。官网图片、JavaScript、CSS、安装脚本和安装包均由 GitHub 提供。完整命令见 `deploy/README.md`。

当前生产栈运行在腾讯云轻量应用服务器，DNS A 记录由腾讯云 DNS 管理。Caddy 运行在该实例的 Docker Compose 内，仅承担 TLS 证书、HTTPS 和反向代理，不依赖 Cloudflare 网络服务。

## 可选形态：Trusted Remote MCP

### 信任边界

在线 MCP 进程需要解密 Status，因此它等价于一台受信任设备。推荐运行位置：

- 用户自己的 VPS
- 私有容器平台
- 本机常驻服务
- 用户控制的家庭服务器

当前版本不适合将多名陌生用户的 Status Key 汇集到同一个共享网关。共享托管形态需要设备密钥封装、硬件隔离或客户端原生插件配合。

## 拓扑

```text
Agent
  |
  | MCP Streamable HTTP + Bearer + TLS
  v
Trusted One Status MCP runtime
  |
  | Encrypted Status API + Device Token
  v
One Status Sync API
```

MCP runtime 在内存中持有 Status Key。Sync API 继续只保存密文。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ONE_STATUS_URL` | 是 | HTTPS Sync API URL |
| `ONE_STATUS_TOKEN` | 是 | 设备 session token |
| `ONE_STATUS_STATUS_KEY` | 是 | `os1_` Status Key |
| `ONE_STATUS_MCP_BEARER_TOKEN` | 非回环必填 | Agent 访问 HTTP MCP 的独立 bearer |
| `ONE_STATUS_AGENT_ID` | 否 | 写入 context 时记录的 Agent ID |
| `ONE_STATUS_MCP_HOST` | 否 | 默认 `127.0.0.1` |
| `ONE_STATUS_MCP_PORT` | 否 | 默认 `3000` |
| `ONE_STATUS_MCP_ENDPOINT` | 否 | 默认 `/mcp` |
| `ONE_STATUS_MCP_PUBLIC_URL` | 否 | 日志展示的公网 URL |
| `ONE_STATUS_MCP_MAX_SESSIONS` | 否 | 默认 `100` |
| `ONE_STATUS_MCP_IDLE_TIMEOUT_MS` | 否 | 默认 30 分钟 |

`ONE_STATUS_TOKEN`、`ONE_STATUS_STATUS_KEY` 和 `ONE_STATUS_MCP_BEARER_TOKEN` 都支持对应的 `*_FILE` 变量，适合 Docker secrets 与 Kubernetes Secret volume。直接值与文件变量不能同时提供。Bearer 至少需要 32 字节，并且必须与设备 Token 不同。

三个 One Status 凭据必须整组来自环境变量，或整组来自本地 profile。混合来源会被拒绝。

## Docker

构建：

```bash
docker build -t one-status:0.3.0 .
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
  one-status:0.3.0
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

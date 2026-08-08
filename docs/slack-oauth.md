# Slack OAuth 配置

One Status 使用 Slack 的 public client PKCE 流程，并申请用户级只读 scope：

- `channels:read`
- `groups:read`

该模式只需要 Client ID。Client Secret 不会进入 Dashboard、Permission Vault、token exchange 或 refresh 请求。

## 创建 Slack App

1. 在 Slack App 管理页选择 **Create New App → From an app manifest**。
2. 导入 [`slack-app-manifest.yaml`](slack-app-manifest.yaml)。
3. 确认 **OAuth & Permissions → PKCE** 已启用。
4. 确认 **Token Rotation** 已启用。
5. 从 **Basic Information** 复制 Client ID。
6. 在 One Status 的 `连接与权限` 页面配置 Slack，只填写 Client ID。

Slack 将启用 PKCE 视为不可自行撤销的 public client 设置。生产 App 和本地开发 App 建议分开创建。

## Callback URL

manifest 预置桌面回环地址：

```text
http://127.0.0.1:8787/oauth/slack/callback
```

实际授权时，Dashboard 显示的 Callback URL 必须与 Slack App 中登记的地址完全一致。共享云不保存本机 flow state，不能消费桌面 OAuth callback。

## 协议行为

授权请求使用：

```text
user_scope=channels:read,groups:read
code_challenge=<S256 challenge>
code_challenge_method=S256
```

首次 code exchange 发送 `client_id`、`code`、`code_verifier` 和 `redirect_uri`。One Status 从 `authed_user` 读取用户 access token、单次 refresh token、过期秒数和 scope。

刷新请求发送 `client_id`、`grant_type=refresh_token` 和当前 refresh token。Slack 官方流程明确规定 refresh 阶段不发送 `code_verifier`；public client 也不发送 `client_secret`。每次成功刷新后，Permission Vault 会原子替换 access token 和单次 refresh token。

断开连接调用 `auth.revoke` 撤销当前用户 access token，随后删除本地加密凭据和 Agent grants。

## 验收

连接完成后检查：

1. Connections 显示 Slack Workspace 和 `connected` 状态。
2. 只给目标 Agent 开启 `slack.channels.list`。
3. Agent 调用 `tools_list` 能看到 Slack 连接。
4. `tools_execute` 能列出当前用户可访问的公开频道和已加入的私有频道。
5. 令牌临近过期时，只触发一次 refresh，并保存 Slack 返回的新 refresh token。

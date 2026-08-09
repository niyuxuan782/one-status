# Google Workspace OAuth 与 Gateway Actions

One Status 使用同一个 Google OAuth 连接提供 Calendar、Gmail、Drive 和 Docs 能力。Refresh Token 保存在本机 Permission Vault，Agent 只能看到经账号 scope、Agent grant 和 action scope 三层过滤后的固定 actions。

## Google Cloud 配置

在 One Status 使用的 Google Cloud Project 中启用：

- Google Calendar API
- Gmail API
- Google Drive API
- Google Docs API

创建 `Web application` 类型的 OAuth 2.0 Client，并将 Dashboard 显示的 callback URL 加入 `Authorized redirect URIs`。桌面默认地址为：

```text
http://127.0.0.1:8787/oauth/google/callback
```

OAuth consent screen 需要配置应用名称、支持邮箱、隐私政策、授权域名和测试用户。生产发布前应按 Google 要求完成品牌验证、敏感或受限 scope 验证；`gmail.readonly` 通常会触发额外审核要求。

## Scope 与 Action

| Scope | Action | 行为 |
| --- | --- | --- |
| `calendar.readonly` | `calendar.calendars.list` | 读取日历列表 |
| `calendar.readonly` | `calendar.events.list` | 读取时间范围内事件 |
| `calendar.readonly` | `calendar.events.get` | 读取单个事件 |
| `calendar.readonly` | `calendar.freebusy.query` | 查询忙闲状态 |
| `gmail.readonly` | `gmail.messages.list` | 读取邮件 ID、会话 ID 和分页信息 |
| `gmail.readonly` | `gmail.messages.get` | 读取白名单邮件头、标签、摘要和大小 |
| `gmail.send` | `gmail.messages.send` | 发送纯文本邮件；每次要求确认 |
| `drive.metadata.readonly` | `drive.files.list` | 搜索和分页读取文件元数据 |
| `drive.metadata.readonly` | `drive.files.get` | 读取单个文件元数据 |
| `documents.readonly` | `docs.documents.get` | 读取文档 Tab 与纯文本正文 |

代码中使用完整 scope URI，例如：

```text
https://www.googleapis.com/auth/gmail.readonly
```

## 固定请求边界

- Agent 无法传入 URL、HTTP method、Authorization header 或响应字段选择器。
- Gmail 列表最多返回 50 项；单邮件读取固定使用 `format=metadata`，邮件 MIME body 不会进入 Agent 上下文。
- Gmail 发送只接受经过 Zod 校验的 `to`、`cc`、`bcc`、`subject` 和 `textBody`，One Status 在本机生成 base64url MIME payload。
- Drive 列表最多返回 100 项，输出只保留文件 ID、名称、类型、时间、大小、父目录、Owner 和受控状态字段。
- Docs 只提取 text run，包含表格与嵌套 Tab；单次输出最多 50 个 Tab、100,000 个正文字符，并返回 `truncated`。
- Provider 原始 JSON 单次最多 1 MiB。所有新 action 的输入与规范化输出均经过 Zod schema 校验。

## 旧连接升级

已有 Google Calendar 连接只持有 `calendar.readonly` 时，Gateway 会继续提供 Calendar actions，并隐藏 Gmail、Drive 和 Docs actions。升级流程：

1. 在 One Status Connections 中重新发起 Google 授权。
2. 在 Google consent screen 接受新增 scopes。
3. 为 Codex、Claude Code 等目标 Agent 分别勾选需要的 actions。
4. 调用 `tools_list`，确认返回的 action 与预期 scope 一致。
5. 先执行读取 action，再单独验证 `gmail.messages.send` 的确认流程。

重新授权不会自动扩大 Agent grant。撤销某个 Agent grant 不影响其他 Agent；撤销 Google 连接会使该连接下所有 Workspace actions 失效。

## 写操作确认

`gmail.messages.send` 标记为：

```json
{
  "readOnly": false,
  "requiresConfirmation": true
}
```

Agent 先通过 `tools_request_approval` 提交完整参数，用户在 Dashboard 核对并批准后，Gateway 才接受携带匹配 `approvalId` 的 `tools_execute`。审批绑定用户、Agent、连接、action 和规范化参数，并带 10 分钟有效期；缺少、拒绝、过期或参数不匹配都会在 Provider 请求发出前被拦截并记录审计。

## 协议验证

```bash
pnpm exec vitest run \
  apps/api/src/oauth-providers.test.ts \
  apps/api/src/tool-gateway.test.ts
```

测试覆盖 OAuth scope 请求、固定 endpoint、严格参数 schema、Gmail MIME 编码、Drive/Docs 响应裁剪、正文上限、scope 过滤和缺 scope 拒绝。

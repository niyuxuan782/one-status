# Provider 集成

One Status v0.9.0 内置 14 个 Provider、15 个 Capability Packs（含记忆兼容能力）、69 个固定 Gateway actions 和 Remote MCP 状态工具。所有第三方连接共用以下执行链：

```text
Agent
  -> tools_list
  -> connection + action + inputSchema
  -> read action: tools_execute
  -> write action: tools_request_approval -> Dashboard approve -> tools_execute
  -> Agent grant + scope + approval check
  -> Provider API
```

Refresh Token、Access Token、Client Secret 与 Trello user Token 保存在本机加密 Permission Vault。Agent 只会获得规范化后的业务数据。

## Callback URL

本机桌面版使用：

```text
http://127.0.0.1:8787/oauth/<provider>/callback
```

设置 `ONE_STATUS_PUBLIC_URL` 后使用：

```text
https://your-one-status-host/oauth/<provider>/callback
```

`<provider>` 可取 `google`、`github`、`slack`、`microsoft`、`notion`、`dropbox`、`zoom`、`canva`、`asana`、`airtable`、`linear`、`figma`、`box`。Trello 使用 Token 连接，不登记 Callback URL。

## Provider 矩阵

| Provider | 连接模式 | PKCE | Client Secret | 主要能力 | 断开语义 |
| --- | --- | --- | --- | --- | --- |
| Google Workspace | OAuth2 | S256 | 需要 | Calendar、Gmail、Drive、Docs | 调用 Google revoke |
| GitHub | OAuth2 或本机 `gh` 导入 | 无 | OAuth2 需要 | Repository、Issue、PR、Content | 托管 OAuth Token 调用 revoke；`gh` 导入只删除 Vault 副本 |
| Slack | OAuth2 user token | S256 | 无 | Channel、History、Search、Message | 调用 `auth.revoke` |
| Microsoft 365 | OAuth2 organizations tenant | S256 | 需要 | Outlook、Teams、OneDrive、SharePoint | 删除 Vault 凭据；Microsoft 没有普通 per-token revoke endpoint |
| Notion | OAuth2 | 无 | 需要 | Search、Page、Block、Create Page | 调用 Notion revoke |
| Dropbox | OAuth2 offline access | 无 | 需要 | List、Metadata、Search、Upload | 调用 Dropbox token revoke |
| Zoom | OAuth2 | 无 | 需要 | Meeting list/get/create | 调用 Zoom revoke |
| Canva | OAuth2 | S256 | 需要 | Profile、Design、Page、Folder | 调用 Canva revoke，Refresh Token 按 lineage 撤销 |
| Asana | OAuth2 | 无 | 需要 | Workspace、Task | 调用 Asana revoke |
| Trello | API key + user Token | 无 | 无 | Board、List、Card | 删除 Vault 副本；用户可在 Trello 账号中撤销 Token |
| Airtable | OAuth2 | S256 | 需要 | Base、Table、Record | 调用 Airtable revoke |
| Linear | OAuth2 offline access | 无 | 需要 | Team、Issue | 调用 Linear revoke |
| Figma | OAuth2 | S256 | 需要 | Project File、Metadata、Node、Comment | 删除 Vault 凭据；Figma REST OAuth 未提供 revoke endpoint |
| Box | OAuth2 | 无 | 需要 | Folder、File、Search | 调用 Box revoke |

## Scope 与审核

- Google 的 Gmail read scope 属于高敏感度 scope，公开 OAuth App 需要完成 Google 审核。
- Microsoft Teams 与 SharePoint 的部分 delegated permissions 需要组织管理员同意，个人 Microsoft 账号无法覆盖完整能力。
- Notion 的内容读写能力在 Developer Portal 配置；用户授权时还要选择允许访问的页面。
- Dropbox 完整文件访问需要在 App Console 选择 Full Dropbox；App Folder 模式只覆盖应用目录。
- Canva OAuth Token 兑换依赖后端 Client Secret，公开集成需要完成 Canva 审核。
- Figma public OAuth App 需要审核；私有 App 受关联团队或组织限制。
- Box `root_readwrite` 同时支撑当前读取与创建文件夹 actions。

## 上线门槛

代码目录中的新增 Provider 已具备 OAuth/凭据协议、固定 endpoint、严格输入 schema、1 MiB Provider JSON 上限、响应字段裁剪、写操作确认、Agent grant 和协议测试。生产启用还需要逐个完成：

1. 在 Provider Developer Console 创建应用并登记 Callback URL。
2. 配置文档列出的 scopes、capabilities 和 app access mode。
3. 在 One Status `连接与权限` 页面按矩阵保存 Client ID 或 API Key，并在 Provider 要求时保存 Client Secret。
4. 完成真实账号授权，并核对返回 scopes。
5. 只向测试 Agent 开放一个只读 action，完成真实调用。
6. 验证 refresh、断开、重新授权和审计记录。
7. 最后开放写 action，确认 Agent 先通过 `tools_request_approval` 创建精确请求，用户在 Dashboard 批准后才能携带匹配的 `approvalId` 执行；缺少、过期或参数不匹配的审批均应被 Gateway 拒绝。

Google Workspace、GitHub 和 Slack 已完成真实账号验收。其余 Provider 当前处于“代码可运行、等待 OAuth App 凭据验收”状态。

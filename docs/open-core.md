# One Status Open Core

One Status 采用 Open Core 模式。个人用户能够审计、运行和自托管承载其 AI 工作环境的核心代码；托管服务收入用于持续维护同步基础设施、OAuth Provider 运维和企业能力。

## 开源核心

仓库中的下列能力使用 Apache-2.0：

- macOS、Windows、Linux Desktop App 与本机后台服务
- CLI、MCP Server、SDK 和 Status Schema
- Capability Pack schema、YAML/JSON parser、内置目录和 Adapter Engine
- 客户端加密实现、本地 Permission Vault、通用钥匙串与 Agent 凭据工具
- 本机项目、Skills、MCP、Rules 和 Agent 配置扫描
- Memory、Preferences、Task State 和 Handoff 工作流
- Codex 与 Claude Code Adapter
- 可自托管的密文 Sync API
- Docker、Caddy 和基础部署配置

用户可以在自己的设备或服务器上运行完整个人版，并检查敏感 Status 是否在上传前完成加密。

## 托管服务

One Status Cloud 计划提供以下商业能力：

- 托管的高可用密文同步
- Managed OAuth Provider 配置、轮换和可用性维护
- 异地备份、版本历史和恢复流程
- 团队策略、审计记录和企业支持
- 后续 Agent Network 的托管目录、路由与结算服务

客户端加密格式、导出能力和自托管协议保持开放。用户数据不依赖闭源格式才能迁移。

## 安全边界

Status Key 由设备持有。云服务保存密文 envelope、同步 revision、设备 presence 和账号元数据。OAuth Token、模型 API Key、账号密码、SSH、云凭据与卡密保存在本机 Permission Vault；Agent 按连接 action 或钥匙串用途获得授权。

托管 OAuth 会引入额外服务端信任边界。该能力上线前会单独发布威胁模型、Token 存储边界和撤销流程。

## 贡献与分发

- 源码许可证：Apache-2.0
- Issue 与 Pull Request：<https://github.com/niyuxuan782/one-status>
- 正式构建：<https://github.com/niyuxuan782/one-status/releases>
- 官网：<https://niyuxuan782.github.io/one-status/>

正式桌面构建会附带 SHA-256 校验和。未签名的 Preview 构建会在 Release Notes 中明确标注，正式自动更新将在代码签名和发布密钥流程完成后开放。

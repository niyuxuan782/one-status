# One Status 安装与发布

## 交付物

| 交付物 | 生成命令 | 入口 |
| --- | --- | --- |
| 单文件 CLI | `pnpm build` | `dist/one-status.js` |
| npm tarball | `pnpm pack:local` | `dist/one-status-0.5.0.tgz` |
| Desktop App | `pnpm --filter @one-status/desktop dist` | `apps/desktop/release` |
| Homebrew Formula | `pnpm release:prepare` | `Formula/one-status.rb` |
| Homebrew Cask | Release workflow | `Casks/one-status.rb` 与公开 tap |
| 校验和 | Release workflow | `SHA256SUMS.txt` |
| Docker image | `docker build -t one-status:0.5.0 .` | `one-status` |

单文件 CLI 将业务包、Fastify、MCP SDK 与 Zod 打入同一个 ESM 文件。运行时只要求 Node.js 22+，安装阶段无需下载 JavaScript 依赖。
构建过程会生成 `dist/THIRD_PARTY_NOTICES.txt`；npm 包、Homebrew 安装和 Docker 镜像都会携带该文件。

## 官网与一键安装

官网：<https://niyuxuan782.github.io/one-status/>

macOS、Linux 桌面版：

```bash
curl -fsSL https://niyuxuan782.github.io/one-status/install.sh | bash
```

Windows 桌面版：

```powershell
irm https://niyuxuan782.github.io/one-status/install.ps1 | iex
```

CLI：

```bash
curl -fsSL https://niyuxuan782.github.io/one-status/install.sh | bash -s -- --cli
```

安装器从 GitHub Pages 读取当前 Release 清单，再从 GitHub Releases 下载平台附件和 `SHA256SUMS.txt`，校验成功后安装。macOS App 安装到 `~/Applications`，Linux AppImage 安装到 `~/.local/bin/one-status-app`，Windows 运行已校验的 NSIS Setup。CLI 模式要求 Node.js 22+。

## Desktop App

开发启动：

```bash
pnpm --filter @one-status/desktop dev
```

原生构建：

```bash
pnpm --filter @one-status/desktop dist:mac
pnpm --filter @one-status/desktop dist:win
pnpm --filter @one-status/desktop dist:linux
```

Release workflow 在对应操作系统 runner 生成 macOS arm64/x64 DMG 与 ZIP、Windows x64 NSIS 与 portable EXE、Linux x64 AppImage 与 DEB。Desktop App 内嵌本机 API，并在健康检查确认后复用已有 `127.0.0.1:8787` One Status 服务。

Preview 构建尚未完成 Apple Developer ID notarization 和 Windows Authenticode 签名。Release Notes 与 Homebrew Cask 会明确显示该状态，不会自动绕过 Gatekeeper 或 SmartScreen。

## 本地安装

直接安装到 `~/.local/bin`：

```bash
./scripts/install-local.sh
```

可以用 `ONE_STATUS_INSTALL_PREFIX` 改写前缀：

```bash
ONE_STATUS_INSTALL_PREFIX=/usr/local ./scripts/install-local.sh
```

## npm

本地 tarball：

```bash
pnpm pack:local
npm install -g ./dist/one-status-0.5.0.tgz
one-status version
```

发布后：

```bash
npm install -g one-status
```

`package.json` 已声明 public publish、Apache-2.0、Node.js 版本和 `one-status` bin。当前 npm 账号未登录，因此仓库只完成可复现打包，没有执行公开发布。

## Homebrew

Homebrew 6 要求 Formula 位于 tap。仓库提供一条本地完整验证命令：

```bash
pnpm brew:install:local
```

公开安装入口：

Desktop App：

```bash
brew tap niyuxuan782/tap
brew install --cask niyuxuan782/tap/one-status
```

CLI 与后台服务：

```bash
brew tap niyuxuan782/tap
brew trust --formula niyuxuan782/tap/one-status 2>/dev/null || true
brew install niyuxuan782/tap/one-status
brew services start niyuxuan782/tap/one-status
```

Homebrew 6 会要求显式信任第三方 tap；这里仅信任 One Status Formula。旧版 Homebrew 没有 `trust` 子命令，命令中的回退会继续执行安装。

它会执行：

1. 构建 CLI 与 npm tarball。
2. 计算 tarball SHA-256 并更新 Formula。
3. 在 `~/.cache/one-status/homebrew-local` 建立本地 Git tap。
4. 注册 `one-status/local` tap。
5. 安装或重装 Formula。
6. 执行 `one-status version`。
7. 如果升级前服务正在运行，自动恢复服务并检查本地健康端点。

安装后：

```bash
brew test one-status/local/one-status
one-status help
brew services start one-status/local/one-status
```

Homebrew service 在 `127.0.0.1:8787` 启动同步 API 与本地工作台，数据库位于 `$(brew --prefix)/var/one-status/one-status.sqlite`。浏览器打开 `http://127.0.0.1:8787/` 即可管理 Status、设备、OAuth 连接和 Agent 权限。

没有本地 profile 时，工作台直接显示注册与登录界面。默认云地址可通过 `ONE_STATUS_DEFAULT_SYNC_URL` 设置；新设备登录会先验证恢复密钥能够解密远端 Status，再保存 profile。

macOS 默认 profile 文件不保存设备 session Token 和 Status Key，这两项进入系统 Keychain。旧版 v1 明文 profile 会在首次成功读取 Keychain 后原子迁移；迁移失败时旧文件保持原状。通过显式 path 使用多 profile 或测试环境时，继续采用权限为 `0600` 的文件模式。

stdio 与 HTTP MCP 长驻进程会在每次 Status 或 Tool Gateway 操作前重新读取 profile 或完整的环境凭据组。工作台登录新账号、设备 Token 轮换、Status Key 变化或 `_FILE` Secret 更新后，下一次工具调用会建立对应的新客户端，无需重新启动 MCP 进程。

OAuth Permission Vault 使用两个相邻文件：

```text
$(brew --prefix)/var/one-status/one-status.sqlite.permissions
$(brew --prefix)/var/one-status/one-status.sqlite.permission-key
```

桌面 MVP 的 OAuth callback 固定走本机回环地址。`ONE_STATUS_PUBLIC_URL` 只适合同时持有 flow state 与 Permission Vault 的单用户受信任部署，不能指向仅运行密文 Sync API 的共享云。

已运行 `gh auth login` 的设备可在 `连接与权限` 页面点击 `从 gh 导入`。后台只执行无 shell 的 `gh auth token --hostname github.com`，随后直接向 GitHub 验证账号和 scope；导入凭据进入加密 Permission Vault。移除这类连接不会注销 GitHub CLI。Homebrew LaunchAgent 会自动检测 `/opt/homebrew/bin/gh` 和 `/usr/local/bin/gh`；其他安装位置可通过绝对路径 `ONE_STATUS_GH_PATH` 指定。

仓库内 Formula 使用 GitHub Release URL：

```text
https://github.com/niyuxuan782/one-status/releases/download/v<version>/one-status-<version>.tgz
```

本地安装脚本只在缓存 tap 副本中将该 URL 改写为 `file://`，仓库 Formula 保持适合远程 tap 的格式。

正式 Formula 位于 `niyuxuan782/homebrew-tap`。用户运行：

```bash
brew tap niyuxuan782/tap
brew install one-status
```

## Release

1. 更新根 `package.json` 的版本。
2. 执行 `pnpm check`。
3. 执行 `pnpm release:prepare`。
4. 检查 Formula 版本和 SHA。
5. 创建 `v<version>` tag。
6. GitHub Actions 在原生 runner 构建桌面附件。
7. 汇总 CLI、DMG、ZIP、EXE、AppImage、DEB 并生成 SHA-256 校验和与 Cask。
8. GitHub Actions 发布 GitHub Release artifact 与 GHCR image。
9. 配置 `NPM_TOKEN` 时同步发布 npm。
10. 配置 `HOMEBREW_TAP_TOKEN` 时同步更新 Formula 与 Cask。

Release workflow 权限：

- GitHub `contents: write`
- GitHub `packages: write`
- `NPM_TOKEN` 可选，用于 npm 发布
- `HOMEBREW_TAP_TOKEN` 可选，用于自动更新 `niyuxuan782/homebrew-tap`

## 已验证

- npm tarball 全局安装后 `one-status version` 返回 `0.5.0`。
- Formula 安装到 `/opt/homebrew/Cellar/one-status/0.5.0`。
- `brew test one-status/local/one-status` 通过版本与帮助检查。
- 单文件产物启动同步 API 和 HTTP MCP 后，官方 MCP Client 成功列出 Status 与 Tool Gateway 工具并调用 `status_get_profile`。

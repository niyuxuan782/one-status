# One Status 安装与发布

当前 Release 为 `v0.8.0`。设备与 AI 工具概览、端到端加密密钥钱包、后台记忆、独立 Device Sidecar 与跨平台安装产物使用同一版本号。

## 交付物

| 交付物 | 生成命令 | 入口 |
| --- | --- | --- |
| 单文件 CLI | `pnpm build` | `dist/one-status.js` |
| npm tarball | `pnpm pack:local` | `dist/one-status-0.8.0.tgz` |
| Desktop App | `pnpm --filter @one-status/desktop dist` | `apps/desktop/release` |
| Device Sidecar | Release 原生矩阵 | `one-status-device-sidecar-<version>-<platform>-<arch>.tar.gz` |
| Homebrew Formula | Release 汇总阶段 | `one-status.rb` Release 附件与公开 tap |
| Homebrew Cask | Release workflow | `Casks/one-status.rb` 与公开 tap |
| 校验和 | Release workflow | `SHA256SUMS.txt` |
| Docker image | `docker build -t one-status:0.8.0 .` | `one-status` |

单文件 CLI 将业务包、Fastify、MCP SDK 与 Zod 打入同一个 ESM 文件。运行时只要求 Node.js 22+，安装阶段无需下载 JavaScript 依赖。v0.8.0 CLI 安装器还会下载同平台、同架构的 Rust Device Sidecar，校验摘要后放到 CLI 同目录。
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

安装器从 GitHub Pages 读取当前 Release 清单，再从 GitHub Releases 下载平台附件和 `SHA256SUMS.txt`，校验成功后安装。macOS App 安装到 `~/Applications`，Linux AppImage 安装到 `~/.local/bin/one-status-app`，Windows 运行已校验的 NSIS Setup。CLI 模式要求 Node.js 22+，并安装对应的 `one-status-device-sidecar`；缺少该架构附件时安装会停止。

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

公开的 `v0.8.0` macOS 附件已经通过 Developer ID、Apple notarization、stapled ticket 与 Gatekeeper 校验。Release workflow 要求这些检查全部通过后才允许发布；Pages 会按每个 Release 的实际记录显示签名状态。Windows Authenticode 仍待接入。

v0.8.0 构建会把模型配置 Rust Sidecar 放入 Desktop App resources，并同时生成独立原生附件，供 CLI、一键安装与 Homebrew 使用。原生构建需要验证：

- macOS arm64/x64、Windows x64 与 Linux x64 使用对应 Sidecar target
- 每个独立 Sidecar 附件进入 `SHA256SUMS.txt`
- 打包后只从 App resources 中解析 Sidecar，禁止从当前工作目录搜索可执行文件
- Sidecar 不继承无关环境 Secret，Provider Credential 通过一次操作所需的受限输入传递
- 原子写入和恢复 fixture 在每个平台 runner 执行

## 本地安装

直接安装到 `~/.local/bin`：

```bash
./scripts/install-local.sh
```

可以用 `ONE_STATUS_INSTALL_PREFIX` 改写前缀：

```bash
ONE_STATUS_INSTALL_PREFIX=/usr/local ./scripts/install-local.sh
```

该脚本会编译本机 Rust Sidecar，将 CLI 与 Sidecar 安装到同一个 `bin` 目录，并把 CC Switch notice 和 MIT License 放到 `share/one-status`。一键 CLI 安装可通过 `ONE_STATUS_INSTALL_DIR` 与 `ONE_STATUS_SHARE_DIR` 分别调整二进制和归属文件目录。

## npm

本地 tarball：

```bash
pnpm pack:local
npm install -g ./dist/one-status-0.8.0.tgz
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
brew install --formula niyuxuan782/tap/one-status
brew link --overwrite --force niyuxuan782/tap/one-status
brew services start niyuxuan782/tap/one-status
```

Homebrew 6 会要求显式信任第三方 tap；这里仅信任 One Status Formula。旧版 Homebrew 没有 `trust` 子命令，命令中的回退会继续执行安装。
`brew link` 可以重复执行，用于处理同名 Desktop Cask 已经存在时 Homebrew 跳过 Formula 全局命令链接的情况。

它会执行：

1. 构建 CLI、npm tarball 与本机 Device Sidecar。
2. 计算 CLI 与本机 Sidecar SHA-256 并生成本地 Formula。
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

公开 Formula 根据 macOS arm64、macOS x64、Linux x64 选择独立 Sidecar 资源，逐项校验 SHA-256，并安装到 `libexec`。交互式 CLI 可通过同目录或 PATH 自动发现 Sidecar；`brew services` 会设置 `ONE_STATUS_DEVICE_SIDECAR` 为 Cellar 内的固定路径。

没有本地 profile 时，工作台直接显示注册与登录界面。默认云地址可通过 `ONE_STATUS_DEFAULT_SYNC_URL` 设置；新设备输入邮箱和账号密码后，客户端自动解封内部 Status Key、验证远端 Status 并保存 profile。

macOS 默认 profile 文件不保存设备 session Token 和 Status Key，这两项进入系统 Keychain。旧版 v1 明文 profile 会在首次成功读取 Keychain 后原子迁移；迁移失败时旧文件保持原状。通过显式 path 使用多 profile 或测试环境时，继续采用权限为 `0600` 的文件模式。

Desktop App 使用独立后台生命周期。概览页开启“开机自启动”后：

- macOS 创建用户级 `~/Library/LaunchAgents/top.furesta.onestatus.background.plist`；
- Windows 写入当前用户的 `Run` 注册项；
- Linux 创建隐藏的 XDG Autostart 条目。

系统登录时只运行 `one-status --background`，后台监听 `127.0.0.1:8787`，不会创建窗口。用户点击 App 后，已运行的单实例后台进程创建图形界面；关闭窗口会释放 Renderer，后台服务继续响应 MCP、模型 Gateway 和设备心跳。首次手动打开 App 且后台尚未运行时，同一进程会先启动本地服务再显示界面。

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
brew install --formula niyuxuan782/tap/one-status
brew link --overwrite --force niyuxuan782/tap/one-status
```

## Release

1. 更新根 `package.json` 的版本。
2. 执行 `pnpm check`。
3. 执行 `pnpm release:prepare`，生成 CLI tarball 与 Release manifest。
4. 检查 CLI 版本、manifest 与预期原生产物名称。
5. 创建 `v<version>` tag。
6. GitHub Actions 在原生 runner 构建桌面附件与 macOS arm64/x64、Windows x64、Linux x64 Sidecar 附件。
7. 汇总 CLI、Sidecar、DMG、ZIP、EXE、AppImage、DEB，按真实 CLI 和 Sidecar 摘要生成 Formula，再生成 Cask 与 `SHA256SUMS.txt`。
8. GitHub Actions 发布 GitHub Release artifact 与 GHCR image。
9. 配置 `NPM_TOKEN` 时同步发布 npm。
10. 配置 `HOMEBREW_TAP_TOKEN` 时同步更新 Formula 与 Cask。

Rust Sidecar 的 Release 需要固定 Rust toolchain、生成各平台二进制、核对目标架构，并在桌面 smoke test 中执行一次只读工具探测。Sidecar 缺失、架构不符或第三方归属不完整时应终止发布。

Release workflow 权限：

- GitHub `contents: write`
- GitHub `packages: write`
- `NPM_TOKEN` 可选，用于 npm 发布
- `HOMEBREW_TAP_TOKEN` 可选，用于自动更新 `niyuxuan782/homebrew-tap`

## v0.8.0 发布验收

- npm tarball 全局安装后 `one-status version` 返回 `0.8.0`。
- Formula 安装到 `/opt/homebrew/Cellar/one-status/0.8.0`，并包含可执行 Device Sidecar。
- 本地 Formula 重装后，`127.0.0.1:8787/health` 返回 `0.8.0`。
- 单文件产物启动同步 API 和 HTTP MCP 后，官方 MCP Client 成功列出 Status 与 Tool Gateway 工具并调用 `status_get_profile`。
- Codex 与 Claude Code stdio MCP 均可连接，并能读取同一份 E2EE Status 与后台整理的结构化记忆。
- 双设备加密 Demo、文件级模型配置预览、租约重领和原子恢复测试均已通过。

## 第三方代码归属

构建脚本生成 `dist/THIRD_PARTY_NOTICES.txt`，CLI、npm、Homebrew 和 Docker 产物会携带该文件。Desktop 附件也必须保留适用于 App 内 Node.js 与 Sidecar 的第三方 notices。

Device Sidecar 的初始开发实现参照并改写 [CC Switch](https://github.com/farion1231/cc-switch) `3.19.2` 的 MIT 代码。Desktop 与独立原生附件均包含对应 notice 和许可证副本。当前归属记录：

| 字段 | 要求 |
| --- | --- |
| Repository | `https://github.com/farion1231/cc-switch` |
| Commit | `413c09e0790c304506888ae24b9be72820aca126` |
| Upstream files | `src-tauri/src/config.rs`、`codex_config.rs`、`services/provider/live.rs`、`app_config.rs`、`provider.rs` |
| Derived files | `apps/device-sidecar/src/atomic.rs`、`paths.rs`、`adapters/{codex,claude}.rs`、`models.rs`、`inventory.rs` |
| License | MIT，`Copyright (c) 2025 Jason Young` |
| Provenance | `apps/device-sidecar/SOURCES.md` |
| Notice | `apps/device-sidecar/THIRD_PARTY_NOTICES.md` |
| License copy | `apps/device-sidecar/third_party/cc-switch/LICENSE` |

发布流程必须继续使用该固定 commit 或在升级时显式更新来源摘要、归属文件和回归测试。详细范围见 [v0.7 产品边界](v0.7-product.md#cc-switch-归属与引入规则)。

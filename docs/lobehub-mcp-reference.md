# LobeHub MCP 参考记录

## 检查范围

本次参考了：

- [`LobeBuiltinMcpServer.ts`](https://github.com/lobehub/lobehub/blob/20afc09c7163f0b6bd0f94d62afd5a654c84cbc0/packages/heterogeneous-agents/src/builtinMcp/LobeBuiltinMcpServer.ts)
- [`LobeBuiltinMcpServer.test.ts`](https://github.com/lobehub/lobehub/blob/20afc09c7163f0b6bd0f94d62afd5a654c84cbc0/packages/heterogeneous-agents/src/builtinMcp/LobeBuiltinMcpServer.test.ts)
- [`apps/server/src/services/mcp/index.ts`](https://github.com/lobehub/lobehub/blob/20afc09c7163f0b6bd0f94d62afd5a654c84cbc0/apps/server/src/services/mcp/index.ts)
- [`lobehub/mcp-hello-world`](https://github.com/lobehub/mcp-hello-world/tree/9ec2a14b4f0ebd64681149e160a6b7cc7c85ea9f)

参考版本固定为 LobeHub commit `20afc09c7163f0b6bd0f94d62afd5a654c84cbc0` 和 `mcp-hello-world` commit `9ec2a14b4f0ebd64681149e160a6b7cc7c85ea9f`。

## 借鉴的工程模式

### 工具与 transport 分离

LobeHub 将 MCP tool 注册集中到 server factory，再分别连接 transport。One Status 采用相同边界：

- `apps/mcp/src/server.ts` 只定义 Status 工具。
- `apps/mcp/src/stdio.ts` 负责本地 stdio。
- `apps/mcp/src/http.ts` 负责 Streamable HTTP。

### 每个 HTTP session 独立 server/transport

LobeHub 的回归测试指出，共用已经初始化的 transport 会让后续 initialize 失败。One Status 的 HTTP runtime 为每个 session 创建独立组合，并使用 `Mcp-Session-Id` 路由后续请求。

### 分发模式

`mcp-hello-world` 使用 npm `bin`、编译目录和 npx/pnpm dlx 入口。One Status 延续这种安装体验，并进一步生成完全 bundled 的单文件产物，使 Homebrew 安装阶段无需 npm dependency install。

## One Status 增加的能力

- 现行 Streamable HTTP，未采用旧 SSE `/sse + /messages` 组合。
- bearer 认证。
- 非回环监听保护。
- session 上限与空闲回收。
- request body 限制。
- E2EE Status vault 与跨设备同步。
- npm、Homebrew、Docker 共用同一 executable。

## 许可证处理

LobeHub 主仓库使用 LobeHub Community License，衍生作品分发可能需要商业授权。本仓库没有复制该主仓库实现，使用官方 `@modelcontextprotocol/sdk` 独立编写 transport。

`lobehub/mcp-hello-world` 使用 MIT License，适合参考其 npm 包结构。One Status 的实现以 Apache-2.0 发布。

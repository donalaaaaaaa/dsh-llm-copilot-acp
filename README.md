# GitHub Copilot CLI ACP Provider for DeepSeek Harness Desktop

为 **DeepSeek Harness Desktop (DSH)** 提供 GitHub Copilot CLI 的 **ACP（Agent Client Protocol）Provider**。

DSH 作为 ACP Client，通过 stdio JSON-RPC 与本地官方 GitHub Copilot CLI（`copilot --acp`）通信。本项目不调用 Copilot 私有 Chat API，不代理 OpenAI 兼容接口，也不读取或保存 Copilot OAuth Token；认证状态由官方 CLI 自己维护。

## 架构

```text
DeepSeek Harness
      │
      ▼
CopilotAcpAdapter
      │
      ▼
CopilotAcpClient
      │  stdio / JSON-RPC 2.0
      ▼
copilot --acp
      │
      ▼
GitHub Copilot Agent
```

## 当前能力

- Provider 直接继承 DeepSeek Harness 的 `LlmAdapter`，并用 `@deepseek-ai/dsh-llm@0.1.7-rc.2` 的真实 `GenerateOptions` / `StreamChunk` / model 类型做编译期约束，不再维护一份“长得差不多”的本地协议类型。
- ACP `initialize`、`session/new`、`session/prompt`；Client 另外实现 capability-gated `session/load` 基础能力。
- 从会话实际公布的 `configOptions` / `models` 发现模型；未公布时返回空目录，不补猜测模型。
- 模型切换仅对当前 ACP 会话明确提供的模型 ID 生效。
- `agent_thought_chunk` 映射为 DSH reasoning stream，`agent_message_chunk` 映射为正文 stream。
- Copilot ACP 原生 `tool_call` / `tool_call_update` 视为 Copilot 已执行的内部工具事件，不重复交给 DSH 执行。
- DSH 工具通过文本 `<tool_call>...</tool_call>` bridge 传递；标签会在流式解析阶段从正文中隔离，避免先作为正文输出再回滚。
- `session/request_permission` 仅返回 ACP 提供的真实 `optionId`。
- 可选 ACP 文件桥按 `sessionId` 隔离 cwd；只接受 ACP 规定的绝对路径，拒绝 `..`、兄弟目录、跨盘路径以及 symlink/junction 穿越，并支持 `read_text_file` 的 1-based `line` / `limit`。
- 支持请求超时、AbortSignal 取消、stderr 尾部诊断以及子进程退出清理；Windows 使用 `taskkill /T` 处理进程树，强制阶段追加 `/F`。
- 自动识别旧版 `gh-copilot` 废弃提示并给出迁移错误信息。

## 安全默认值

本插件默认使用最小权限：

```yaml
args:
  - --acp
allowAllTools: false
allowFileRequests: false
```

`allowAllTools` 是 `--allow-all-tools` 的唯一权限开关。即使 `args` 或 `COPILOT_ACP_ARGS` 中手工包含该参数，只要 `allowAllTools` 不是显式 `true`，客户端也会移除它。

如确实需要 Copilot 自动批准工具请求：

```yaml
allowAllTools: true
```

如确实需要 ACP 文件桥：

```yaml
allowFileRequests: true
```

文件桥仍受每个 ACP session 的 cwd 路径与链接边界约束。这不是操作系统级沙箱；对不可信工作区仍应使用独立环境。

## 安装

先安装并登录官方 GitHub Copilot CLI：

```bash
npm install -g @github/copilot
copilot login
copilot --help
```

然后把本包加入 DSH Desktop profile 的依赖，并执行：

```bash
pnpm install
```

在 Desktop 的 `cordis.patch.yml` 中配置：

```yaml
- id: github-copilot-acp
  name: "@deepseek-ai/dsh-llm-copilot-acp"
  config:
    command: copilot
    args:
      - --acp
    timeoutMs: 900000
    modelDiscoveryTimeoutMs: 10000
    allowAllTools: false
    allowFileRequests: false
```

如果要配置 DSH 默认模型，请使用 **DSH 模型发现中实际出现的模型 ID**，不要照抄 README 中的静态型号。

## 会话生命周期

`CopilotAcpClient` 已支持按 `sessionId` 路由更新、维护独立 cwd，并在 agent 明确公布 `loadSession` capability 后才调用 `session/load`。

当前 `CopilotAcpAdapter` **仍然每个 DSH model call 创建新的 ACP session**。这是有意设计：DSH 的 `GenerateOptions.messages` 已包含本次请求可见的完整历史，而 ACP session 本身又是有状态的；在没有可靠 replay/state 映射前直接复用同一 ACP 对话，会把历史重复注入。后续若做持久 session，应基于 DSH replay envelope / adapter state 明确记录 ACP session identity，而不是简单按 DSH `sessionId` 缓存进程。

## 环境变量

- `COPILOT_ACP_COMMAND` / `COPILOT_CLI_PATH`：指定 Copilot CLI 可执行文件。
- `COPILOT_ACP_ARGS`：覆盖 CLI 参数。权限相关的 `--allow-all-tools` 最终仍由 `allowAllTools` 控制。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

测试会先重新编译 `src`，测试运行时读取编译后的 `lib`。CI 还会检查：

```bash
git diff --exit-code -- lib
```

因此修改 TypeScript 源码但忘记提交对应 `lib` 产物会直接失败。

当前测试覆盖：

- ACP initialize / session / capability-gated session load / JSON-RPC request ID 冲突。
- 权限默认拒绝与显式授权。
- 多 session cwd 隔离、绝对路径约束、line/limit 读取、写入以及 symlink/junction 越界。
- 模型发现与会话内模型选择。
- 请求超时、缺失 CLI、取消，以及 Windows 进程树终止参数。
- reasoning/text stream 转换。
- 跨 ACP chunk 的 `<tool_call>` 解析。
- abort/error 时禁止产生可执行 DSH tool-call。
- 忽略 Copilot 已执行的 ACP native tool event。
- Cordis / DSH adapter 注册。

## 目录

```text
src/
  index.ts
  adapter.ts
  client.ts
  prompt-bridge.ts
  stream-bridge.ts
  types.ts
test/
lib/
config.example.yml
cordis.patch.yml
```

## 故障排查

### 命中旧版 `gh copilot`

安装新版 CLI：

```bash
npm install -g @github/copilot
```

并显式配置正确的 `copilot` 路径。

### ACP 请求超时

先在外部终端运行：

```bash
copilot login
```

确认官方 CLI 已完成登录，再启动 DSH。

### 模型列表为空

这表示当前 ACP 会话没有公布可选择模型，或模型发现失败。Provider 不会用硬编码型号填充列表。

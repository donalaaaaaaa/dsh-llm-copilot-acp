# GitHub Copilot CLI ACP Provider for DeepSeek Harness Desktop

为 **DeepSeek Harness Desktop (DSH)** 提供的 **GitHub Copilot CLI ACP (Agent Client Protocol)** 提供者插件。

本项目参考 **Hermes Agent** 的 Copilot ACP 集成架构设计，使 DeepSeek Harness 作为 **ACP Client**，通过标准输入输出 (stdio) 与本地官方 GitHub Copilot CLI (`copilot --acp`) 通信。

---

## 🌟 核心设计与特性

1. **纯 ACP Stdio 协议集成**：
   - 绝不调用 GitHub Copilot 私有 Chat API / HTTP 接口。
   - 绝不实现 OAuth 登录逻辑，绝不解析或存储 Copilot Token。
   - 认证完全由官方 GitHub Copilot CLI 自行管理（用户只需在终端执行一次 `copilot login`）。
   - 不做 OpenAI 兼容反向代理，保持纯正的 ACP 消息与事件流驱动。

2. **架构流程**：
   ```text
   DeepSeek Harness Desktop (Core)
                  │
                  ▼
         ctx.llm.registerAdapter
                  │
                  ▼
      CopilotAcpAdapter (LlmAdapter)
                  │
                  ▼
      CopilotAcpClient (ACP Client)
                  │  (stdio JSON-RPC 2.0)
                  ▼
      GitHub Copilot CLI (copilot --acp)
                  │
                  ▼
         GitHub Copilot Agent
   ```

3. **完整生命周期与特性支持**：
   - **`initialize`**：协议握手，协商 ACP v1 版本与双向 Capabilities。
   - **`session/new`**：启动独立 ACP 会话并动态提取当前账户实际广告的模型列表，支持扁平与 grouped config options。
   - **`session/set_config_option` / `session/set_model`**：模型选择在会话建立后执行；不会把 DSH 请求的模型提前塞进 Copilot CLI 启动参数，也不会在发现为空时伪造模型目录。
   - **`session/prompt`**：发送组装好的提示词与上下文，并将 ACP `stopReason` 映射到 DSH 的 stop / max-tokens / aborted / error。
   - **Streaming 实时响应**：
     - `agent_thought_chunk` ➡️ DSH `reasoning-delta`（思考过程）
     - `agent_message_chunk` ➡️ DSH `text-delta`（回答文本）
     - 文本中的 `<tool_call>` ➡️ DSH 可执行 `tool-call`（供 DSH 工具循环使用）；分片标签会先缓冲，原始标记不会泄漏成 `text-delta`
     - Copilot 自己的 `tool_call` / `tool_call_update` 只表示它内部已经执行的工具，不会再变成 DSH 工具调用
     - 当 DSH 提供工具且用户没有显式覆盖权限策略时，插件默认拒绝 Copilot 的 ACP permission request，降低同一副作用被两套工具系统重复执行的风险
   - **双向 Client 请求处理**：
     - `session/request_permission` 只返回协议允许的 `selected`（带真实 `optionId`）或 `cancelled`。
     - `fs/read_text_file` / `fs/write_text_file` 只允许会话目录内部；除词法路径检查外还校验 realpath，因此会拒绝通过 symlink / Windows junction 逃逸工作区。
     - `fs/read_text_file` 支持 ACP 的 1-based `line` 与 `limit` 参数；关闭文件桥时也不会向 Agent 宣告 FS capability。
   - **健壮的异常与进程管理**：
     - 自动检测并提示旧版已废弃的 `gh copilot` 插件，指引迁移至新版 `@github/copilot`。
     - 请求超时守护（默认 15 分钟）与 `AbortSignal` 取消支持。
     - 进程生命周期闭环：请求结束或异常时自动释放与清理子进程，杜绝进程泄漏。

---

## 📦 目录结构

```text
.
├── src/
│   ├── index.ts           # Cordis 插件入口（导出 name, inject, Config, apply）
│   ├── adapter.ts         # CopilotAcpAdapter（实现 DSH LlmAdapter 接口）
│   ├── client.ts          # CopilotAcpClient（进程管理与 ACP JSON-RPC 通信）
│   ├── prompt-bridge.ts   # DSH 消息格式与工具声明转 ACP Prompt
│   ├── stream-bridge.ts   # ACP 事件流转 DSH StreamChunk 状态机
│   └── types.ts           # 完整类型定义
├── test/
│   ├── prompt-bridge.test.ts  # Prompt 与工具抽取测试
│   ├── stream-bridge.test.ts  # 流事件与分块转换测试
│   ├── mock-copilot-cli.ts    # 模拟 copilot --acp stdio 服务端
│   ├── client.test.ts         # 客户端与 JSON-RPC 协议测试
│   └── adapter.test.ts        # Provider Adapter 与 Cordis 插件测试
├── lib/                   # 编译后标准 ESM JavaScript
├── config.example.yml     # 配置示例
├── package.json
└── tsconfig.json
```

---

## 🚀 安装与前置准备

### 第一步：安装官方 GitHub Copilot CLI

确保安装的是 GitHub 官方的新版 Copilot CLI（**不是** 旧版 `gh copilot` 扩展）：

```bash
npm install -g @github/copilot
```

验证安装及 `--acp` 支持：
```bash
copilot --version
copilot --help
```
若能看到 `--acp` 选项即代表环境准备就绪。

### 第二步：登录 GitHub Copilot

在终端执行登录授权（仅需执行一次）：
```bash
copilot login
```
按照终端提示在浏览器中完成 GitHub 授权。

---

## ⚙️ 在 DeepSeek Harness 中配置使用

把本包链进 Desktop profile 后再写 patch，否则 Cordis 解析不到插件：

```bash
# 在 ~/.dsh/profiles/desktop/package.json 的 dependencies 中加入
# "@deepseek-ai/dsh-llm-copilot-acp": "file:D:/path/to/this/package"
pnpm install
```

### 方式一：通过 Desktop Profile 的 `cordis.patch.yml`

打开你的 DSH 桌面配置文件：
`C:\Users\<你的用户名>\.dsh\profiles\desktop\cordis.patch.yml`

添加以下配置段落：

```yaml
- id: github-copilot-acp
  name: "@deepseek-ai/dsh-llm-copilot-acp"
  config:
    # CLI 路径，默认为 copilot
    command: copilot
    # 安全默认只启动 ACP。需要 Copilot-native 工具免确认时再显式添加 --allow-all-tools。
    args:
      - "--acp"
    # 操作超时时间 (毫秒)，默认 15 分钟
    timeoutMs: 900000
    # 不默认开启 Copilot-native 工具的全自动权限
    allowAllTools: false
    # 允许读写工作区文件；realpath 会阻止 symlink/junction 逃逸
    allowFileRequests: true
```

若希望将 Copilot 设为 DSH 的默认 Agent 模型，可追加：
```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: github-copilot-acp
    model: "<从模型发现结果中选择实际可用的 id>"
```

### 方式二：环境变量覆盖（高级）

支持通过以下环境变量快速覆盖 CLI 路径与参数：
- `COPILOT_ACP_COMMAND` 或 `COPILOT_CLI_PATH`：指定 Copilot 可执行文件绝对路径。
- `COPILOT_ACP_ARGS`：自定义启动参数，如 `"--acp --allow-all-tools"`。

---

## 🧪 运行单元与集成测试

本项目自带完整的 ACP Mock 服务端与端到端测试用例：

```bash
pnpm test
```
或者使用 Node.js 原生测试运行器：
```bash
node --test test/**/*.test.js test/**/*.test.ts
```

测试覆盖了：
1. **PromptBridge**：工具架构渲染、上下文历史映射与 DSH 工具所有权提示。
2. **StreamBridge**：思考/正文增量、跨 chunk 的 `<tool_call>` 状态机、原生工具事件去重、ACP stopReason 映射。
3. **CopilotAcpClient**：协议握手、权限 outcome、grouped model options、空模型目录、超时、缺失 CLI、请求 id 冲突、`line/limit` 与 canonical-path 文件沙箱。
4. **CopilotAcpAdapter**：会话级模型切换、模型发现、流式调用。真实 `LlmRuntime` 注册测试在能读取 Desktop 安装包时运行。
5. **CI**：Linux 与 Windows 都执行 TypeScript build + Node test。

---

## ⚠️ 当前工具桥边界

DSH 工具目前仍通过 prompt 中的 `<tool_call>` 约定桥接，并不是把 DSH 工具直接注册成 ACP/MCP 工具。插件已经通过缓冲解析、默认权限收紧和原生 tool event 去重降低重复执行风险，但这仍属于兼容层。长期方向是把 DSH 工具包装为 MCP server，通过 `session/new.mcpServers` 提供给 Copilot，从而删除文本工具协议。

---

## 📋 故障排查 (Troubleshooting)

1. **错误：`The gh-copilot extension has been deprecated`**
   - **原因**：环境变量中命中了旧版 GitHub CLI 的 `gh copilot` 别名。
   - **解决**：安装新版 CLI `npm install -g @github/copilot`，并在配置中显式指定新版路径。

2. **提示：`Timed out waiting for Copilot ACP response`**
   - **原因**：Copilot CLI 尚未登录，导致进程等待认证。
   - **解决**：在外部终端单独执行一次 `copilot login` 完成授权。

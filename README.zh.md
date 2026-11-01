---
description: "在 DSH profile 中安装 ChatGPT 订阅模型提供商，并授权使用你自己的账号。"
kind: "package-bundle"
---

# dsh-chatgpt-plan

[English](README.md) | 中文

## 概述

通过 OpenAI 官方 Sign in with ChatGPT 流程，使用你的 ChatGPT 订阅运行 DSH 任务。本组合包添加 `codex-plan` 模型提供商，以及「设置 → 模型」中的账号控制。每位用户授权自己的账号，符合条件的请求消耗已有订阅额度。插件调用公开 Responses API，任务循环和工具仍由 DSH 执行。本项目是独立集成，不代表 OpenAI 或 DeepSeek 官方认可。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

### 要求与安装

使用 Node.js ≥24.9 和 DSH **0.2.2-alpha.2**。本版本面向基于 `dsh-base` 的 profile，包括 Web、Desktop 和 headless；兼容声明会拒绝其他 DSH 版本。账号需要符合 OpenAI SIWC 订阅使用条件，且在授权时允许使用订阅额度。已用真实账号验证浏览器登录和模型发现，在线推理尚未验证。

在本项目目录中构建，然后安装进由 CLI 管理的 profile：

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-chatgpt-plan
dsh --profile web --dump-config
dsh web --no-open
```

组合配置中会出现 `dsh-chatgpt-plan` 层和 `codex-plan` 插件行。安装后重启已运行的 DSH。组合包会启用已有的 `credentials` 和 `authorization` 行，包括原先禁用它们的 headless profile；使用同一个凭据存储的 profile 共享这些记录。Desktop 管理自己的 profile，请通过其插件管理器安装 tarball，而不是安装到 CLI 的 Web profile。

不分发源码时，可以构建并交付安装包：

```sh
npm pack
dsh plugin --profile web add /absolute/path/to/dsh-chatgpt-plan-0.1.2.tgz
```

本包尚未发布到 npm。tarball 包含构建后的 Host 和浏览器代码，安装时不需要执行构建。执行 `dsh plugin --profile web remove dsh-chatgpt-plan` 会移除对应组合层；凭据记录继续保留在 DSH 存储中。

### 登录与选择模型

打开「设置 → 模型 → ChatGPT plan」，选择「使用 ChatGPT 继续」。打开授权链接，在 OpenAI 页面登录并允许使用订阅。浏览器无法连接 DSH Host 的回环监听时，把完整回调 URL 粘贴回账号卡片。只有身份验证通过且凭据保存成功，卡片才会显示已连接。随后在 DSH 模型选择器中选择 ChatGPT plan 下的模型。

「取消登录」会撤回正在进行的授权。「退出登录」会停止本实例的账号请求，尝试远端撤销，并清除本地令牌；Host ID 和账号与客户端注册关系会保留供后续登录复用。无法确认远端撤销时，卡片会明确提示，请在 ChatGPT 设置中断开该应用。「管理用量」会打开 ChatGPT 的应用限额和点数设置。

### 配置

在 profile 的 `cordis.patch.yml` 中覆盖 `codex-plan` 行。省略的字段使用插件 schema 默认值。修改后需要重新挂载插件或重启 DSH。

| 字段 | 默认值 | 行为 |
|---|---|---|
| `loginTimeoutMs` | `180000` | 浏览器授权的总时限。 |
| `requestTimeoutMs` | `180000` | 模型目录、推理和撤销操作的时限。 |
| `authRequestTimeoutMs` | `15000` | 令牌和撤销操作的网络时限；最大 20000，为凭据存储的写锁等待留出余量。 |
| `refreshMarginMs` | `180000` | 提前刷新令牌，同时遵守服务端返回的最早刷新时间。 |
| `revocationRetries` | `1` | 网络错误或服务端失败后的额外撤销尝试次数。 |
| `revocationRetryDelayMs` | `250` | 撤销重试的初始指数退避间隔。 |
| `callbackPort` | `1455` | 回环监听端口；`0` 表示选择可用端口。 |
| `modelContextWindows` | `{}` | 显式设置单个模型的上下文限制；未配置时采用目录元数据。 |

端点、OAuth scope 和提供商 ID 由本插件的协议实现固定。不要把令牌写入配置。凭据文档损坏时，插件会拒绝覆盖；修复或移除其 `codex-plan/connection` 记录后再登录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现与开发</summary>

[组合包 patch](cordis.patch.yml) 启用已有的凭据服务，并插入一个插件行。[认证模块](src/auth.ts) 通过 DSH 存储保存一个 Host ID 和账号注册，使用 JWKS 验证 ID token，并在存储的跨进程锁内刷新凭据。刷新响应丢失时，本地令牌会失效，因为远端可能已经轮换 refresh token。

[适配器](src/adapter.ts) 把请求绑定到一次登录，调用 `api.openai.com/v1/models` 和 `/responses`。[消息转换](src/messages.ts) 使用 namespace 工具，并验证账号和模型限定的重放元数据。[流转换](src/stream.ts) 生成 DSH 内容块，只有收到完成响应才报告成功。[账号控制](src/client/index.tsx) 调用不含凭据的 Remote 方法；令牌仅保留在 Host。插件不会导入 Codex 的登录文件，也不会启动 Codex CLI。

针对相邻目录中的 DSH 源码开发时，安装依赖、链接真实宿主包，再检查和构建：

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run link:dsh -- ../dsh
npm run typecheck
npm test
npm run verify:dsh -- ../dsh
```

链接脚本只修改本项目的 `node_modules`。类型检查使用 DSH 的真实声明，不维护本地替身声明。验证脚本通过 `pnpm dsh` 安装进临时 profile，执行包含真实工具往返的离线 headless 任务，重启进程恢复会话，并比较[请求快照](tests/session.expected.json)。它不使用 API Key 或你已有的 Codex 登录。浏览器中的登录与取消操作另在隔离 Web profile 中检查。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- DSH：[第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)、[打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)、[LLM 适配器](https://deepseek-harness.github.io/deepseek-harness/develop/practice/llm-adapter)。
- OpenAI：[SIWC 概览](https://developers.openai.com/siwc/token-sharing-open-source)、[登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。

<a id="model-experience"></a>
## 模型体验

### 请求与工具结果

#### 模型看到什么

模型接收 DSH 保留的文本历史，以及分组在 `dsh` namespace 下的工具，其描述为 `Tools executed by DeepSeek Harness.`。工具结果通过调用 ID 关联。仅在模型、登录和可见内容保持一致时，插件才重放通过验证的原生推理项和响应项。适配器不增加角色设定或任务指令。

#### Token 影响

每次 HTTP 请求携带必要历史，并使用 `store: false` 和 `stream: true`。用量计入已授权账号符合条件的订阅额度。不支持的控制参数会明确失败；SDK 和适配器均不会自动重试推理或切换到 API Key 计费。

#### KV Cache 影响

未变化的历史保留原生项顺序、phase 和加密推理。编辑或裁剪内容、切换模型、重新授权会使相应原生重放失效。提供商是否命中缓存不由本插件控制。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制

- 每个凭据存储只保留一个账号注册，尚未实现多账号选择和工作区切换。
- 支持文本输入和 DSH function 工具。适配器声明仅接受文本，由 DSH 投影附件；不暴露原生图片、文件输入或托管工具。
- 模型来自账号目录。推理选项仅展示安装的 Responses SDK 同样支持的等级；服务端新增等级不会使模型失效。未知或不可用模型会被拒绝。目录元数据可能不完整，上下文覆盖需要显式配置。
- 已在 macOS 验证 Web 安装和无密钥 headless 执行。Desktop 原生行为、Windows ACL 保护和真实账号推理尚未验证。
- 回调监听必须能绑定配置的回环端口。默认端口占用时会明确失败；可改用其他端口或 `0`。

### 开发备注

当前为预览版，尚未发布到 npm。已用符合条件的账号验证浏览器授权和模型发现；真实账号的多步任务、令牌刷新和撤销仍需验证。

0.1.2 将包名和显示名称从 `dsh-codex-plan` / Codex plan 改为 `dsh-chatgpt-plan` / ChatGPT plan。升级时先移除旧包，再安装新包。内部提供商、配置、凭据和回放标识继续使用 `codex-plan`，保留已有会话和登录状态。

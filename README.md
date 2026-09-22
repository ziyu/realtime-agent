# RealtimeAgent

**通用实时 Agent 运行时：**JEV 等 System One 模型选择当前行为，LLM 提供计划与语言提议，环境执行器确认实际结果。独立 [Agent 包](packages/agent/README.md) 已支持带时效的观察、异步设备回执、资源互斥、短任务计划和并行表现通道。Home 与 Computer 真实 Windows 桌面应用复用同一协调器；当前实现和验收边界见 [实施记录](docs/realtime-runtime-implementation.md)。

**通用 Computer Use：**运行 `pnpm dev:computer:live` 后，通过 `pnpm computer run "自然语言目标" --wait` 或 `POST /api/v1/tasks` 调用；无需打开网页或预选窗口。CLI、HTTP 和可选网页控制台共享 Cua Driver、JEV 与 LLM 运行时，支持按任务 ID 查询、停止、继续和获取结果。接口、退出码及接入示例见 [Computer CLI / API](docs/computer-api.md)，底层实现与真实验收状态见 [Cua 接入记录](docs/cua-computer-use.md)。

**Cloudflare 统一凭据入口：**根目录 `.env` 只需填写 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`，运行 `pnpm dev:cloudflare`。Jev、文字模型和 Grok 实时语音统一走 Cloudflare，本地音频房间自动启动，无需申请其他模型密钥。Token 权限、账户余额和验证范围见 [Cloudflare 启动说明](docs/cloudflare.md)。下面的原厂配置仍作为可选路径保留。

项目以 **pnpm monorepo** 管理。Home 保留实时 3D 家园、人格与生活记忆，并加入独立表情和视线。原生说话继续校验整段获准文本及音频转写后播放；表现通道可以在等待规划时继续运行。

默认 Home 中的 Milo 有持续的性格、兴趣、心情和自己的小愿望。实际经历会影响兴趣与愿望进度；Jev 可以在没有用户指令时邀请 LLM 回顾生活，形成带来源的随记。打开“内心”面板可以查看，也可以关闭主动分享，让它安静生活。

原生实时音频已接入 OpenAI Agents SDK 与 LiveKit Agents，提供 GPT-Realtime-2.1、GPT-Live 1、Gemini 3.8 Live 和 Grok Voice 的切换入口。默认使用原生音频方案，支持流式声音和插话；模型密钥、启动及验证边界见 [原生实时音频](docs/native-voice.md)。新语音模型需要各自的密钥，原有 Jev / DeepSeek 配置不会冒充它们的凭据。第一阶段仍需完成真实语音体验验收。

**第一阶段仍在验证 realtime 体验。** Home 支持连续发送、执行中改口、取消旧回复、按轮次查看反应时间，以及浏览器持续语音入口。真实模型已验证走路与交互途中切换动作；语音设备与识别服务的完整体验单独验收，详见 [实时对话与阶段验证](docs/realtime-conversation.md)。

## 快速启动

需要 **Node.js 22.13+、pnpm 11.1.2**。包管理器版本固定在根目录 `package.json` 的 `packageManager` 字段中。

在仓库根目录执行：

```sh
pnpm install
pnpm dev
```

默认启动 **realtime-home**，打开 **http://127.0.0.1:5174**。其世界服务在 `127.0.0.1:3102`。根目录 `.env` 配置了 System One 密钥时自动使用真实模式；没有密钥时使用本地演示。可以用 `AGENT_MODE=demo pnpm dev` 显式选择演示。

## 工作区

```text
realtime-agent/
├── package.json              # 工作区命令与 pnpm 版本
├── pnpm-workspace.yaml       # apps/*、packages/* 与安装配置
├── pnpm-lock.yaml            # 全仓库唯一依赖锁文件
├── apps/
│   ├── realtime-home/        # @realtime-agent/home
│   ├── realtime-demo/        # @realtime-agent/demo，历史实现
│   └── realtime-computer/    # @realtime-agent/computer，真实 Windows 桌面
├── packages/agent/          # 协调、观察、通道、执行回执、任务与输出许可
├── packages/config/         # 服务端环境加载与模型端点配置
└── docs/
```

| 包 | 说明 | 根目录开发命令 | 页面端口 |
| --- | --- | --- | --- |
| `@realtime-agent/home` | React + Three.js，四个房间、八种生活动作 | `pnpm dev` 或 `pnpm dev:home` | 5174，API 3102 |
| `@realtime-agent/demo` | Three.js 原生页面，厨房、卧室、书房、花园与十二个交互对象 | `pnpm dev:demo` | 3007，页面与 API 共用 |
| `@realtime-agent/computer` | Cua Driver + JEV + LLM，全桌面任务、跨窗口与结果核对 | `pnpm dev:computer` | 3110，页面与 API 共用 |

Home 与 Computer 复用 `@realtime-agent/agent`；旧 Demo 仍保留历史运行时。各应用使用 `workspace:*` 接入服务端配置包。Computer 的默认驱动连接当前 Windows 用户桌面，会话和任务记录保存在内存中。

## 根目录命令

```sh
pnpm dev           # 启动 home
pnpm dev:demo      # 启动 demo
pnpm dev:computer # 连接真实 Windows 桌面，有配置时启用 JEV + LLM
pnpm dev:computer:manual # 真实桌面观察和手动输入，不读取模型配置
pnpm dev:computer:live # 要求 JEV + LLM 配置齐全后启动
pnpm check:computer # 检查模型配置缺项和读取位置，不启动桌面或调用模型
pnpm computer --help # 通用 Computer Use CLI（通过 HTTP 调用服务）
pnpm computer run "自然语言目标" --wait # 不依赖网页的任务调用
pnpm dev:all       # 同时启动三个参考应用
pnpm typecheck     # 检查所有工作区包
pnpm build         # 构建工作区包与应用
pnpm test          # 顺序执行离线自动化测试
pnpm test:computer # Cua 协议、模型适配、任务循环与控制台 HTTP 回归（模型/设备为夹具）
pnpm test:computer:live # 可选记事本专项测试，不是通用 CLI/API 的调用前提
pnpm test:computer:browser-fixture # 仅旧浏览器表单回归，不代表默认 Computer 能力
pnpm test:e2e      # 顺序执行应用浏览器回归
pnpm test:live     # 显式使用真实密钥验证 Home，会消耗模型额度
pnpm start         # 从 home 的 3102 端口提供已构建页面与 API
```

demo 的生产启动方式：先执行 `pnpm build`，再执行 `NODE_ENV=production pnpm start:demo`。

只操作指定应用：

```sh
pnpm --filter @realtime-agent/home run build
pnpm --filter @realtime-agent/demo run test
pnpm --filter @realtime-agent/home run test:e2e
```

CI 或复现安装使用 `pnpm install --frozen-lockfile`。依赖声明保留在所属应用的 `package.json`，统一锁定在根目录 `pnpm-lock.yaml`；不再维护应用内的 npm 或 pnpm 锁文件。添加依赖时使用 `pnpm --filter <包名> add <依赖名>`，开发依赖加 `-D`。

## 模型配置与数据

各应用的真实模式支持仓库根目录的 `.env`；Computer 默认检查模型配置但只在提交任务后调用模型，显式 manual 模式不读取模型配置。首次配置时执行以下命令；已有 `.env` 时直接修改现有文件，不要覆盖密钥：

```sh
cp .env.example .env
```

根目录使用 `SYSTEM_ONE_BASE_URL`、`SYSTEM_ONE_MODEL`、`SYSTEM_ONE_API_KEY` 和 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`。配置加载优先级为：**进程环境变量 > 应用目录 `.env` > 根目录 `.env`**。旧变量 `TYPESAFE_API_KEY`、`TYPESAFE_MODEL`、`JEV_MODEL` 仍兼容；应用层显式设置的空密钥会遮蔽根目录密钥。重启服务后生效，密钥只在服务端读取，不写入前端。

已接通 TypeSafe System One 与 DeepSeek Chat Completions。DeepSeek 官方端点使用 `max_tokens` 与 `thinking: { type: "disabled" }` 生成有长度限制的 JSON 回复；这里的“慢系统”指对话和规划职责，不要求模型开启内部长推理。其他兼容服务仍使用 `max_completion_tokens`。成功响应的模型名、请求 ID（提供商返回时）及 token 用量会保留在运行记录中。

home 将性格、愿望、随记和记忆一起保存到 `apps/realtime-home/data/life-live.json` 或 `life-demo.json`。首次启动会从同目录旧 `memories-*.json` 迁入已有记忆，保留旧文件；后续只读取新的生活记录。重启或重置家园不会抹去人格和愿望进度。demo 仍使用自己的原有记忆格式。

普通 `pnpm test`、`pnpm test:e2e` 使用响应夹具或显式演示模式，不调用真实模型。Home E2E 默认使用 5174/3102，可通过 `E2E_PORT` 选择独立的构建后服务端口，每轮使用独立 `.test-data/` 子目录；Demo 测试使用 3008。Computer E2E 自动分配本地端口，用同一个浏览器完成场景并在结束后关闭。测试不复用已有日常服务。

`pnpm test:live` 是单独的真实浏览器联调入口，强制真实模式、独占 5174/3102，不复用用户服务，记忆写入 `.live-test-data/`。其日志、HTTP 成功响应元数据和页面截图保存在 `apps/realtime-home/test-results/live-integration/`。该测试有请求数量和时间上限，不是长时间性能评测。

## 进一步阅读

- [通用运行时：实现、使用与验收记录](docs/realtime-runtime-implementation.md)
- [Cua Computer Use 与当前验收状态](docs/cua-computer-use.md)
- [通用 Computer CLI / HTTP API](docs/computer-api.md)
- [Computer 使用说明](apps/realtime-computer/README.md)
- [通用实时 Agent：架构与实施路线](docs/general-realtime-agent-plan.md)
- [实时 Agent 案例调研与来源](docs/realtime-agent-research.md)
- [Home 功能与配置](apps/realtime-home/README.md)
- [Demo 功能与配置](apps/realtime-demo/README.md)
- [Home 行为运行时设计](apps/realtime-home/docs/architecture.md)
- [pnpm 迁移与验证记录](docs/pnpm-monorepo.md)
- [真实模型接入与验证记录](docs/live-integration.md)
- [Milo 的人格、愿望与生活记忆](docs/inner-life.md)
- [实时对话、打断与第一阶段验收](docs/realtime-conversation.md)

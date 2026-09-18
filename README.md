# RealtimeAgent

实时 3D Agent 家园实验，以 **pnpm monorepo** 管理。Jev 负责即时行为选择并决定是否调用 LLM，语言模型提供对话、计划与记忆建议，服务端世界负责动作执行和结果验证。

默认 Home 中的 Milo 有持续的性格、兴趣、心情和自己的小愿望。实际经历会影响兴趣与愿望进度；Jev 可以在没有用户指令时邀请 LLM 回顾生活，形成带来源的随记。打开“内心”面板可以查看，也可以关闭主动分享，让它安静生活。

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
│   └── realtime-demo/        # @realtime-agent/demo
├── packages/config/         # 服务端环境加载与模型端点配置
└── docs/
```

| 包 | 说明 | 根目录开发命令 | 页面端口 |
| --- | --- | --- | --- |
| `@realtime-agent/home` | React + Three.js，四个房间、八种生活动作 | `pnpm dev` 或 `pnpm dev:home` | 5174，API 3102 |
| `@realtime-agent/demo` | Three.js 原生页面，厨房、卧室、书房、花园与十二个交互对象 | `pnpm dev:demo` | 3007，页面与 API 共用 |

两套应用保留各自的世界协议、运行时和数据目录，通过 `workspace:*` 共同使用 `@realtime-agent/config` 加载服务端配置。

## 根目录命令

```sh
pnpm dev           # 启动 home
pnpm dev:demo      # 启动 demo
pnpm dev:all       # 同时启动两个应用
pnpm typecheck     # 检查两个应用的 TypeScript
pnpm build         # 构建两个应用，包含各自的类型检查
pnpm test          # 顺序执行两个应用的现有自动化测试
pnpm test:e2e      # 顺序执行两个应用的 Chrome 浏览器测试
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

两个应用都支持仓库根目录的 `.env`。首次配置时执行以下命令；已有 `.env` 时直接修改现有文件，不要覆盖密钥：

```sh
cp .env.example .env
```

根目录使用 `SYSTEM_ONE_BASE_URL`、`SYSTEM_ONE_MODEL`、`SYSTEM_ONE_API_KEY` 和 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`。配置加载优先级为：**进程环境变量 > 应用目录 `.env` > 根目录 `.env`**。旧变量 `TYPESAFE_API_KEY`、`TYPESAFE_MODEL`、`JEV_MODEL` 仍兼容；应用层显式设置的空密钥会遮蔽根目录密钥。重启服务后生效，密钥只在服务端读取，不写入前端。

已接通 TypeSafe System One 与 DeepSeek Chat Completions。DeepSeek 官方端点使用 `max_tokens` 与 `thinking: { type: "disabled" }` 生成有长度限制的 JSON 回复；这里的“慢系统”指对话和规划职责，不要求模型开启内部长推理。其他兼容服务仍使用 `max_completion_tokens`。成功响应的模型名、请求 ID（提供商返回时）及 token 用量会保留在运行记录中。

home 将性格、愿望、随记和记忆一起保存到 `apps/realtime-home/data/life-live.json` 或 `life-demo.json`。首次启动会从同目录旧 `memories-*.json` 迁入已有记忆，保留旧文件；后续只读取新的生活记录。重启或重置家园不会抹去人格和愿望进度。demo 仍使用自己的原有记忆格式。

普通 `pnpm test`、`pnpm test:e2e` 使用响应夹具或显式演示模式，不调用真实模型。home E2E 独占 5174/3102，每轮使用独立的 `.test-data/` 子目录；demo 测试独占 3008。测试不复用 Home 的日常服务，运行前需停止同端口服务。

`pnpm test:live` 是单独的真实浏览器联调入口，强制真实模式、独占 5174/3102，不复用用户服务，记忆写入 `.live-test-data/`。其日志、HTTP 成功响应元数据和页面截图保存在 `apps/realtime-home/test-results/live-integration/`。该测试有请求数量和时间上限，不是长时间性能评测。

## 进一步阅读

- [Home 功能与配置](apps/realtime-home/README.md)
- [Demo 功能与配置](apps/realtime-demo/README.md)
- [Home 行为运行时设计](apps/realtime-home/docs/architecture.md)
- [pnpm 迁移与验证记录](docs/pnpm-monorepo.md)
- [真实模型接入与验证记录](docs/live-integration.md)
- [Milo 的人格、愿望与生活记忆](docs/inner-life.md)
- [实时对话、打断与第一阶段验收](docs/realtime-conversation.md)

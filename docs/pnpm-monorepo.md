# pnpm monorepo 迁移记录

迁移与验证日期：2026-09-18。验证环境为 Node.js 26.5.0、pnpm 11.1.2、本机 Chrome。

## 最终结构

根目录是私有工作区入口，`packageManager` 固定为 `pnpm@11.1.2`，Node.js 最低版本为 22.13。工作区包含 `apps/*`，并预留 `packages/*`；当前有两个应用包：

| 目录 | 包名 | 默认开发服务 |
| --- | --- | --- |
| `apps/realtime-home` | `@realtime-agent/home` | 页面 5174，API 3102 |
| `apps/realtime-demo` | `@realtime-agent/demo` | 页面与 API 3007 |

`pnpm dev` 默认进入 home；`pnpm dev:demo` 进入 demo。`pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e` 从根目录分发到两个应用。浏览器测试顺序执行，保留各自的测试端口和本地演示模式限制。

工作区只使用根目录 `pnpm-lock.yaml`。依赖仍在所属应用的 `package.json` 声明；没有将应用依赖提升为根目录依赖，也没有修改两套应用的行为策略或合并其状态协议。

## 文件与依赖处理

通过 `pnpm import` 从原有 npm 锁文件生成工作区锁文件，再以 `pnpm install --frozen-lockfile` 安装。已逐项比较两个应用的 **27 项直接依赖**，声明范围和解析版本均与迁移前一致。home 的 19 项和 demo 的 8 项直接依赖都纳入根锁文件；两个应用的 Three.js 实际解析到同一个 pnpm 安装目录。

根目录、home、demo 三个 `package-lock.json` 已移除。旧 npm 的 `node_modules` 先与运行目录隔离，使验证使用新建的 pnpm 依赖树。

迁移时临时保留的根目录早期源码快照已按用户要求删除。清理前核对了其中的 29 个源码和配置文件：均有对应的现行应用版本，差异属于后续修复、端口调整和 pnpm 迁移，没有需要单独保留的功能；应用、构建和测试均不引用该快照。快照说明文件一并删除，当前开发入口为 `apps/realtime-home` 和 `apps/realtime-demo`。

修改了两个 Playwright 配置中的服务启动命令、README、环境示例中的构建提示，以及 home 设置界面对 `.env` 位置的说明。`.env` 和记忆目录仍位于各自应用内。原有测试断言未修改。

## 实际验证结果

以下命令均从工作区根目录执行：

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，识别根目录与两个应用，共 3 个 workspace project |
| 依赖版本比较 | 27 项直接依赖，0 项变化 |
| `pnpm typecheck` | 两个应用均通过 |
| `pnpm test` | home 29 项、demo 19 项，共 48 项通过 |
| `pnpm build` | 两个应用均构建成功 |
| `pnpm test:e2e` | home 3 项、demo 2 项，共 5 项通过 |
| `AGENT_MODE=demo pnpm dev` | 默认 home 启动成功，页面与 `/api/health` 均返回 200 |

浏览器验证覆盖原有桌面与 390px 布局、3D 场景、指令执行和中断、记忆、快系统触发慢思考以及配置面板。模型验证使用原有 HTTP 响应夹具与演示模式；根目录启动检查的 Jev/LLM 实际请求计数均为 0。

构建仍提示 Three.js 相关分块超过 500 kB（home 约 560 kB，demo 主分块约 601 kB）。Node.js 26 也会对 demo 保留的 tsx 版本提示 `module.register()` 弃用。这些提示不影响本轮检查通过，迁移没有通过升级依赖或修改警告阈值来隐藏提示。

本机迁移前后对照记录保存在被 Git 忽略的 `test-results/pnpm-migration/`；各应用的浏览器截图仍在自己的 `test-results/`。

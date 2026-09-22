# Cua Computer Use

日期：2026-09-21。当前默认 Computer 后端为官方 `@trycua/cua-driver@0.28.2`，不再使用原来的单窗口 PowerShell 驱动。原生旧驱动、浏览器表单和相应测试保留作历史回归，不能充当新默认链路的验收证据。

通用调用入口现已提供：`pnpm computer run "目标" --wait` 与 `POST /api/v1/tasks`，支持按任务 ID 控制和读取结果。网页可选，调用方无需编写应用专用步骤；接口契约见 [Computer CLI / API](computer-api.md)。下方记事本测试保留为历史专项验证，不再作为通用接口的交付门槛。

## 已实现的任务链路

用户给出最终目标，运行时读取应用目录与窗口集合，System Two 根据实际工具定义和现场提出最多六步的短段计划，System One 选择规划、采纳、执行、修订或核对完成。每步调用官方 Cua 工具，动作后重新观察窗口与桌面。新应用、菜单和保存对话框都可以成为后续步骤的目标；任务不绑定一个固定窗口。

```text
网页目标 → Agent → JEV next_step
                    ↓ 请求计划
               LLM + Cua 实际工具 schema + 当前观察
                    ↓ 短段提议
               JEV 审核与逐步选择
                    ↓
               Cua SDK → 原生应用 / 新窗口 / 弹窗
                    ↓
               真实回执、重新观察、目标验证
```

页面的“仅查看”只改变用户预览范围。开始任务不要求先打开应用或选择窗口。停止、继续和手动输入都进入同一运行时；手动接管先停止后续自动决策，等待已发送操作收敛，结果不确定时不会盲目重放。

## 文件与边界

| 文件 | 实际职责 |
| --- | --- |
| `server/cua-transport.ts`、`cua-native-worker.mjs` | 专属子进程加载官方 SDK；同一个 Cua runtime 保存窗口/浏览器/控件快照；单飞调用、取消、超时、有界关闭。 |
| `server/cua-policy.ts` | 从实际 Driver inventory 生成可用工具，按 JSON Schema 校验参数，绑定完成证据和截图。 |
| `server/cua-models.ts` | JEV 单个 `next_step` 选择；LLM 生成结构化短段，不直接调用系统输入。 |
| `server/cua-runtime.ts` | 全桌面任务、窗口与应用观察、执行、改口、停止、继续、结果归属和有界诊断。 |
| `server/cua-app.ts`、`server/index.ts` | 本机 HTTP 接口和新默认启动入口。 |
| `public/computer.*` | 无预选窗口的目标入口、独立状态/截图刷新、阶段反馈与手动接管。 |

本机实际安装包返回 56 个工具定义，运行时只向模型提供其中与电脑操作相关的工具，并额外提供一个只读输出验证器。工具集合包括应用发现/启动、窗口检查、UIA 控件、鼠标键盘、菜单和浏览器语义操作；没有把 shell、任意脚本执行、权限策略修改或会话升级暴露为模型工具。网页不接收任意工具名来直接执行。

本实现的 Node 宿主通过继承管道管理专属 worker；worker 内使用 `CuaDriver.create()`、`listToolsJson()`、`callTool()`。没有再安装一个必须由用户单独维护的后台服务。实际接口以锁定版本的 inventory 为准；官方动态文档可能描述后续版本的新增工具。

JEV 与 LLM 继续通过已有服务端模型配置接入，核心 Agent 包未绑定 Cua 或 Windows 对象。Cua worker 不继承模型密钥，但保留宿主的 Cua 策略限制。操作被 Driver 拒绝时记录拒绝，不修改权限策略。后台快捷键不可用时，同一个目标的前台投递可以成为新的 JEV 候选；不会不经选择自动重试。

## 感知和完成验证

`COMPUTER_VISION=auto` 是新默认值。规划可带实际截图；如果模型端点拒绝图片格式，最多进行一次无图的模型请求，并把“可访问性（模型未接受图像）”显示出来。`1` 要求图像、不降级；`0` 明确只用可访问性信息。配置优先级与密钥一样，为进程 > 应用 `.env` > 根 `.env`。

没有图像时，模型不能猜测像素点击坐标；可以使用实际观察的控件 token、菜单和按键。有图像时还检查截图 ID、对应窗口、像素范围与时效。图像和树使用 Cua 的同一窗口身份，预览请求不擅自改写任务的窗口范围。

完成可通过结构化观察字段或图像判断提出。结构化检查引用当前任务的真实证据 ID 和 JSON pointer，不能用模型自己的文字、反射的参数或输入“已送达”当作目标达成。视觉完成必须引用实际提供给模型的当前截图，并显示 `model-visual`；它是模型判断，不是确定性的文件验证。

保存任务可以通过 UI 重新打开文档核对；用户在目标中明确给出的绝对文件路径，还可交给只读 `verify_file` 校验。它只读取现有文件及内容摘要，绝不创建、修改或保存文件，不用程序写文件替代 GUI 保存动作。文件名仅为已授权长路径的前缀时会拒绝读取。

迟到执行结果保留原 taskId 和 turn，更新真实现场，但不能完成新目标。取消请求不是取消确认；未知结果保留资源占用。底层 SDK 超时或失联时，不退回旧驱动或模拟执行。

## 当前验收事实

已实际加载官方 Windows 原生模块，读取应用、窗口及真实桌面截图。离线回归覆盖真实 SDK schema、原生传输生命周期、模型接线、任务跨窗口、旧结果隔离、只读验证、图像与无图路径、控制台 HTTP 和 390px 布局。注入设备与模型响应的测试验证运行时语义，不代表真实模型完成率。

最终通过根目录 `pnpm test:computer` 执行 39 项回归，包含构建 Agent；Computer 全量 TypeScript 检查与 `git diff --check` 通过。该命令使用 Node 24 + pnpm 11.1.2 执行。39 项中，SDK inventory 真实加载原生模块，控制台通过真实 HTTP/浏览器交互，其余桌面动作和模型回复使用明确夹具。

默认 live 服务已实际启动并核对健康与状态接口：`backend=cua`、`decisionProtocol=cua-computer-v1`、`driverVersion=0.28.2`、`modelReady=true`、`connected=true`，启动后没有自动提交任务。这只证明默认入口与真实 Driver 启动正常，不是下述保存任务通过。

本轮真正的端到端验收由网页提交目标开始，使用配置中的 System One、LLM 和官方 Cua Driver。Agent 自行启动系统记事本，在已有应用内创建新标签页并写入了本次独有内容。随后在“另存为”的后台快捷键/菜单路径反复尝试，最终因无效计划暂停。该轮没有完成保存，不能报告端到端通过。记录保留在 `apps/realtime-computer/test-results/cua-computer/9c2acaa4/failure.json`。

针对这次失败，补上后台投递不可用后的显式前台候选、保留 Driver 失败信息、无效计划的有界校正、默认图像输入及可访问性降级反馈。这些修正的回归测试通过后，多次重新运行真实保存验收命令均被执行工具返回“无法确定请求的安全状态”而拦截，命令没有执行。因此最终真实保存结果仍待验收，不能把修正后的模拟闭环或旧原生小窗口测试当成通过。

## 可复现命令

```powershell
# 仓库根目录
pnpm check:computer
pnpm dev:computer:live
pnpm test:computer
pnpm test:computer:live
```

`test:computer:live` 使用 `scripts/verify-cua-computer.ts`：不预选窗口、不预先打开记事本；Agent 自己打开应用、创建文档、输入多行中英文、处理保存对话框、保存到该次唯一输出路径，并核对结果。测试只预建报告目录并读取最终文件，不直接写入目标文档。模型调用与整体任务都有预算，成功或失败写入独立报告。它会实际操作应用并消耗模型额度，不纳入普通测试。

首次安装若遇到仓库已有 Vitest 对 Node 版本的引擎限制，可用 Node 24 执行安装：

```powershell
npm exec --yes --package=node@24 --package=pnpm@11.1.2 -- pnpm install --frozen-lockfile
```

不要通过禁用 engineStrict 隐藏依赖约束。当前代码保留工作区锁定的 System One SDK，没有混入独立 SDK 包迁移。

## 对照的官方资料

- [Cua Driver TypeScript SDK](https://cua.ai/docs/reference/cua-driver/sdk-reference)：runtime、泛型工具、结果和取消。
- [Windows 工具契约](https://cua.ai/docs/reference/cua-driver/mcp-tools-windows)：应用、窗口、UIA、截图和系统输入。
- [官方 jev-use 示例](https://cua.ai/docs/how-to-guides/driver/jev-use)：JEV 候选选择与 Cua 执行的接法；该示例本身是限定任务，不作为本项目已经完成全桌面任务的证明。

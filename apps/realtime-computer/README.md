# Realtime Computer

Computer 默认通过官方 **Cua Driver 0.28.2** 连接当前 Windows 桌面。JEV 选择当前行为，LLM 理解目标并提出短段计划，Cua 执行应用启动、窗口、菜单、键鼠和浏览器操作，并返回真实观察。当前实现和完整验收状态见 [Cua Computer Use](../../docs/cua-computer-use.md)。

## 通用 CLI 与接口

启动 `pnpm dev:computer:live` 后，在另一个终端调用：

```powershell
pnpm computer run "你的自然语言目标" --wait
# 需要严格 JSON stdout 的程序可直接调用 Node 入口：
node scripts/computer.mjs run "你的自然语言目标" --wait
node scripts/computer.mjs status <task-id>
node scripts/computer.mjs stop <task-id>
node scripts/computer.mjs resume <task-id> --wait
```

命令从仓库根目录执行。`POST /api/v1/tasks` 接收 `{goal}` 并返回任务 ID；状态、结果、轨迹、停止与继续都支持按 ID 访问。CLI、HTTP 和网页共享同一个执行服务，不依赖某个应用或保存步骤。完整协议、幂等、并发规则和 Python 示例见 [Computer CLI / API](../../docs/computer-api.md)。

## 启动与操作

在 Windows 的可交互桌面会话中，从仓库根目录运行：

```powershell
pnpm dev:computer
# pnpm 未加入 PATH 时：
npm exec --yes --package=pnpm@11.1.2 -- pnpm dev:computer
```

网页控制台可选，地址为 `http://127.0.0.1:3110`。也可以直接在页面输入最终目标，不需要先打开应用或选窗口。Agent 从实际应用与窗口观察中决定启动、定位、切换以及后续动作。

“仅查看”选择只影响你看到的预览，自动任务可以继续在其他应用和弹窗中操作。没有模型配置时，自动任务入口说明缺项，保留真实画面和手动输入；不会把规则演示冒充模型任务。

提交后显示接收、决策、规划、审核、执行与核对阶段。状态与截图分别刷新，截图较慢时不会让任务看起来毫无响应。停止取消后续决策，已发出的操作继续对账；受阻时显示具体原因，可核对后继续。手动接管与自动任务共用执行通道。

```powershell
pnpm dev:computer:manual # 只连接真实桌面，不读取模型配置
pnpm dev:computer:live   # 要求 System One 与 LLM 均已配置
```

`COMPUTER_PORT`（其次 `PORT`）可覆盖 3110。应用只监听本机。模型配置沿用根目录的 `SYSTEM_ONE_*` 与 `LLM_*`，也兼容已有 Cloudflare 配置。启动不会自动提交任务。

### 自动任务启动前的配置

`--live` 需要实际模型配置。没有 `.env` 或缺少字段时，启动会列出具体缺项及读取路径并退出，不启动驱动、不切成手动模式。配置优先级为进程环境变量 > 本应用 `.env` > 仓库根目录 `.env`，高优先级空值也会遮蔽已有配置。

没有配置文件时，从仓库根目录执行以下 PowerShell 命令，保留已有文件：

```powershell
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath apps/realtime-computer/.env.example -Destination .env }
notepad .env
```

原厂或兼容 API 接入需填写 `SYSTEM_ONE_API_KEY`、`LLM_API_KEY`、`LLM_MODEL`；`LLM_BASE_URL` 应指向该 LLM 密钥对应的服务地址。使用 Cloudflare 时设置 `AI_PROVIDER=cloudflare`，填写 `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN`，共享配置加载器会为两个模型角色生成配置。密钥只在本地 `.env` 或进程环境中设置。

```powershell
npm exec --yes --package=pnpm@11.1.2 -- pnpm check:computer
npm exec --yes --package=pnpm@11.1.2 -- pnpm dev:computer:live
```

`check:computer` 只检查配置字段和格式，不启动桌面驱动、不截图、不调用模型；退出码 0 代表字段齐全，仍不等于模型账户或网络已经验证。诊断只显示读取位置与字段是否缺失，不输出密钥值。

`COMPUTER_VISION=auto` 为默认值，规划可接收实际截图；模型拒绝图片输入时进行一次无图重试，并在页面明确显示“可访问性（模型未接受图像）”。`COMPUTER_VISION=1` 要求图像，不降级；`0` 只用可访问性数据。该变量也支持进程 > 应用 `.env` > 根 `.env` 的优先级。没有图像时，规划器只能使用实际控件、菜单或键盘，不会猜测像素点击位置。

## 实现

`server/cua-transport.ts` 管理一个专属 Node worker，worker 内加载官方原生 Cua SDK；同一个 runtime 保留控件快照与会话状态。宿主读取实际工具 schema，不假设不同 Cua 版本具有同名参数。退出关闭 worker，不关闭用户应用。

`server/cua-runtime.ts` 复用 `@realtime-agent/agent` 的异步执行通道。System Two 可以提出应用发现、启动、窗口切换和跨对话框的短段；System One 从已校验候选中逐步选择；Cua 返回实际结果后更新现场。后台输入不可用时，可把同目标的前台投递作为新的候选重新选择，权限拒绝不会触发策略升级。

模型提议、操作已送达、目标已满足分别记录。完成需要当前任务的实际观察证据。结构化检查绑定真实字段，视觉判断绑定实际提供的截图并明确标记为模型判断。保存任务必须核对保存结果；用户明确给出的绝对输出路径可由只读 `verify_file` 检查，它不创建或修改文件，不代替 GUI 保存。

窗口操作使用实际 pid/window_id、控件 token 和快照；像素按对应截图坐标系传递。切换预览会丢弃旧图片与点击坐标。任务不通过用户所选预览窗口获得或限制权限，权限仍由 Cua 的宿主策略决定。

截图在内存中传递，导出的运行轨迹不含图像 base64；任务文字、工具参数和观察可能含用户内容。模型密钥不传给原生 worker。当前应用验证平台为 Windows；锁屏、安全桌面、跨重启恢复和其他平台需要分别处理，不通过变更 Cua 权限策略掩盖失败。

## 验证

```powershell
pnpm --filter @realtime-agent/computer typecheck
pnpm test:computer      # Cua 新默认链路的协议/模型/任务/控制台回归
pnpm test:computer:live # 可选的系统记事本专项场景，会操作真实桌面并调用模型
```

普通测试使用注入的设备与模型响应，验证真实应用代码的协调、API、跨窗口、模型请求、停止与证据归属；其中 SDK 元数据测试真实加载官方模块。新增通用 API / CLI 验证使用真实 HTTP 和 Node 子进程，覆盖任意文本目标、幂等、状态、结果、定向停止/继续和超时。`test:computer:live` 保留为可选的应用专项场景，不是通用接口的完成标准；其历史结果单独记录。

当前真实端到端保存验收尚未通过：第一轮完成自主打开记事本、新建标签页和输入，在另存为阶段失败；修正后的重跑被执行工具拦截、没有执行。详细事实与报告路径见 [Cua 接入记录](../../docs/cua-computer-use.md)。不要将模拟跨窗口测试、旧浏览器表单或旧原生小窗口测试计作本次真实保存通过。

历史浏览器表单只通过 `dev:browser-demo` 启动，旧 PowerShell 原生测试只通过 `test:native` 运行。它们不再是默认驱动。修改服务端代码后需重启 Computer；已运行的普通 `tsx` 进程不会自动加载新实现。旧实现记录保留在 [Windows 桌面接入](../../docs/windows-desktop.md) 和 [桌面任务闭环修正](../../docs/jev-desktop-loop-fix.md)。

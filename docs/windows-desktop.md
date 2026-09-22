# Windows 桌面接入

> 这是先前 PowerShell/单窗口实现的历史记录。2026-09-21 起，默认入口改为 [Cua Computer Use](cua-computer-use.md)；下面的旧验收结果不代表 Cua 全桌面任务已通过。

日期：2026-09-20。

当前任务启动逻辑已修正为桌面专用的单一 `next_step` Choice，并增加真实模型到原生窗口的网页任务验收。最新行为与测试入口见 [桌面任务闭环修正](jev-desktop-loop-fix.md)；下面较早的验收记录保留其当时范围。

启动配置检查：`pnpm check:computer`。`dev:computer:live` 缺项时现在显示准确字段和实际 `.env` 读取位置，不再只抛出笼统异常。初次配置方法见 [Computer 配置说明](../apps/realtime-computer/README.md#自动任务启动前的配置)。检查字段齐全不代表已经验证模型调用。

启动修复验收：新增启动/CLI 测试 6/6、共享配置回归 12/12、Computer 与配置包类型检查通过。实际重跑 live 入口时，空配置明确列出 `SYSTEM_ONE_API_KEY`、`LLM_API_KEY`、`LLM_MODEL` 并以退出码 1 结束，未启动原生驱动。此结果不计为真实模型连接成功。

此前 Computer 的默认驱动只启动无头浏览器并操作本地表单，未实现用户要求的真实电脑操控。本次将默认入口替换为 Windows 桌面驱动，原表单保留为显式浏览器夹具。

## 当前链路

`server/index.ts` → `WindowsDriver` → `DesktopRuntime`（复用 Agent）→ `desktop-app.ts` → `public/desktop.html`。

桌面截图由 Windows 屏幕 API 采集；目标窗口与控件由 Win32/UI Automation 观察；输入通过系统键鼠接口发送。控制台可以选择真实窗口，提交自然语言任务，或直接发送手动输入。默认启动不创建无头 Chrome。

无模型配置时，真实截图与手动输入可工作，自动任务明确不可用。有配置时，JEV/其他 System One 接口审核和选择当前候选，LLM 返回与任务及观察 ID 绑定的短计划。视觉输入通过显式 `COMPUTER_VISION=1` 接入支持图片的 LLM。

## 结果与失效处理

窗口选择是操作范围，模型不能通过提议切换到另一个未选窗口。执行前检查身份、矩形、时效和焦点；坐标使用物理像素。截图响应含帧 ID 与窗口 ID，控制台切窗时丢弃旧帧，服务拒绝来自已移动窗口的帧操作。

原生输入送达只生成操作回执，不自动完成业务任务。目标完成需要当前窗口的可观察文字验证；无法证明时保留待复核状态。停止阻止后续输入，已经发送的操作继续对账，不伪造回滚。辅助进程失去响应时返回明确错误，不回退到浏览器或规则动画。

## 验收记录

普通运行时与 HTTP 测试覆盖手动输入、旧帧拒绝、快慢系统计划协作、停止后迟到结果、默认页面与原生 API。模型请求使用响应夹具，此处不声称已测真实模型的桌面任务成功率。

原生驱动验收已通过 3 项测试：协议过期/超时、真实 WinForms 窗口操作，以及超时命令不会延迟执行。覆盖真实窗口截图、中文与 emoji 输入、快捷键、按钮点击、窗口移动后拒绝旧观察、最小化恢复、取消与有界关闭。测试窗口独立创建，未操作用户已有工作窗口，截图只来自测试窗口。

Ctrl+A 验收曾检出测试窗口没有实现全选行为：实际按键与 Ctrl 修饰键均已到达，但选区仍为空。测试窗口随后增加自身的快捷键处理，收到真实按键后执行 SelectAll；再通过真实系统输入验证内容替换。驱动未直接修改控件文本或伪造选区。这个验收证明输入送达与应用响应，不承诺每个应用支持同一种快捷键。

类型检查和普通检查共 18 项通过：桌面运行时/HTTP 6 项、桌面模型接线 4 项、控制台静态契约 3 项、原浏览器 provider 回归 5 项。真实 JEV/LLM 账户尚未在本轮调用；模型请求测试使用响应夹具，不将其当作真实模型成功率。

网页到原生窗口的完整验收 1/1 通过：浏览器只用于打开控制台，被控对象是独立 WinForms 窗口。实际通过网页完成聚焦、根据真实截图点击编辑框、中文输入、快捷键全选与内容替换、原生按钮点击，并从 UI Automation 读回准确结果。页面同时断言执行回执更新、停止状态和 390px 布局；没有 mock 网络、直接改写窗口结果或注入目标控件值。

新增回执到达后的界面更新，确认已结束操作不会一直显示“等待执行回执”。修改后上述网页原生验收再次通过。代表性截图和报告位于 `apps/realtime-computer/test-results/desktop-native/`：`control-desktop.png`、`control-mobile.png`、`after-input.png`、`ui-verification.json`。原生驱动自身的截图位于根目录 `test-results/desktop-native/window.png`。

这些结果验证本机 Windows 的真实采集与输入链路，不等于跨应用自主任务、所有控件类型、任意游戏或真实模型成功率已经验收。当前自动任务与手动输入绑定用户选定窗口，遇到无法从观察证明的任务结果保留待复核状态。

参考接口：[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)、[CopyFromScreen](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.graphics.copyfromscreen)、[UI Automation 权限](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)。

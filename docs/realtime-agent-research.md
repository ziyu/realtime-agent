# 实时 Agent 案例调研

调研日期：2026-09-20。配套方案：[通用实时 Agent 架构与实施路线](general-realtime-agent-plan.md)。

本次从 X 案例检索出发，回溯产品官方说明、研究发布和开源仓库。下文的“公开能力”是来源中的陈述，不代表本项目复现或独立性能测量。部分 X 原帖返回 403 或 DisabledError，只能读取搜索索引；未将这些视频当成已经逐帧审阅的证据。动态文档以调研日快照为准，历史发布不等于当前产品可用性。

## 对项目最有用的案例

| 案例与时间 | 可核对的公开内容 | 对本项目的启发 | 不能据此推断 |
| --- | --- | --- | --- |
| TypeSafe Jev / Doom，2026-09-15 | 官方演示使用文本形式的结构化游戏状态，不是截图视觉输入。[R1] | 先用可观察状态和有限行为候选验证快速决策闭环。 | 接上 Jev 就能理解任意游戏画面；演示性能等于本项目端到端性能。 |
| General Agents Ace，官网调研日快照 | 根据屏幕和指令预测鼠标、键盘操作，定位为电脑 autopilot。[R5] | 电脑场景需要单独设计感知、操作和结果验证。 | 宣传中的速度就是完整任务耗时；未披露的内部结构一定没有快慢分层。 |
| Google Project Mariner，2025-05-20 | 官方介绍浏览器任务、多任务和 teach-and-repeat。[R6] | 技能复用与任务恢复值得进入长期路线。 | 浏览器多任务已解决游戏逐帧控制；该历史发布说明当前开放范围。 |
| Google DeepMind SIMA 2，2025-11-13 | Gemini 驱动的虚拟世界 Agent，结合目标推理、对话与动作，发布中展示跨游戏任务。[R7] | 把语言目标、技能执行、反馈和重新规划接起来。 | 本项目使用普通 LLM 就拥有相同的训练数据、视觉和操作能力。 |
| Project AIRI，仓库调研日快照 | 实时语音、VRM/Live2D 和游戏集成；Factorio 明确标为 WIP、已有 PoC。[R8] | 学习表现层与游戏接入的组织方式，作为适配器参考。 | 仓库路线图中的每项均已完成，或它已经实现本文的 JEV 协调协议。 |
| Tavus，文档调研日快照 | Raven 感知、Sparrow 对话节奏、Phoenix 表情表现与 LLM 协作；支持说话和倾听时的表情。[R9][R10] | 表情、感知和会话节奏必须独立于文字生成组织。 | 生成视频头像与本地 VRM 骨骼控制具有同样的接口、延迟或可控性。 |
| Figure Helix，2025-02-20 的架构发布 | 明确采用异步 System 2 / System 1，原文分别给出 7–9 Hz 与 200 Hz。[R11] | 多速率、异步协作已有强先例；慢思考期间控制仍继续。 | Helix 的专用视觉运动策略等同于 Jev，或它的机载性能能迁移到云端模型调用。 |

X 中可回查的入口包括 [SIMA 2 官方发布串][X1]、[AIRI 作者关于 ADB + MCP 操作 Android 的开发日志帖][X2]。前者与 DeepMind 正式发布相互印证；后者在本次可读的索引中明确提到移动设备接入。X 用于发现场景，架构判断优先依据对应一手资料。

## JEV 对设计的实际约束

官方把 Jev 定位为给程序状态作结构化判断的模型。文档说明同批问题并行、相互隔离；因此“选择动作”“是否打断”“选择表情”分别有效，并不自动证明组合后无冲突。关联动作必须在运行时校验，强耦合选择应使用一个完整候选。[R2]

Choice / Score 的 confidence 来自概率分布，Noul 不带同样的 confidence 字段。业务阈值需要按任务评测，不能把一种问题的阈值直接套给另一种问题。[R3]

本轮核对的 `jev-1.13` 局限说明更新于 2026-09-17，明确提示数值运算、时间比较、间接推理、无关长上下文及对抗输入的问题。[R4] 本项目据此建议：代码计算坐标、距离、期限和数量；模型判断情境、适合的技能和是否需要规划。对未知信息保留未知；网页文字不能改变宿主提供的能力与授权范围。

官方发布中的 70–500 ms 是厂商给定条件下的端到端 API 延迟口径。[R1] 本项目还要加入采集、状态整理、排队、校验、执行、验证及播放时间。不能把 API 延迟直接写成“Agent 反应时间”，也不能承诺所有领域都获得相同比例的成本或速度提升。

## 从这些案例得出的设计判断

这些是本项目的设计推论：

1. 通用性应体现在相同的观察、任务、决策、执行和证据契约上；各领域仍需要自己的传感器与技能实现。
2. 快慢双系统本身已有先例。值得验证的差异化是：以 JEV 等 System One 模型为语义决策层，通过统一运行时驱动多种环境，并可量化响应时间、完成率和成本。
3. 实时表现和实时决策应分别测量。表情流畅、鼠标移动快、语音首音短、任务最终成功是四种不同指标。
4. 开源项目和产品演示可帮助定义体验；是否优于 LLM-only，需要在相同感知、执行器和任务分布下比较。

本次未找到足以证实“全球没有人实现 JEV + LLM 通用实时运行时”的证据，也不把未公开内部结构的产品统称为单系统。方案中的新意应由实现和对照实验说明。

## 来源

| 编号 | 一手来源 | 日期与使用范围 |
| --- | --- | --- |
| R1 | [Introducing System One Models & Jev][R1] | 2026-09-15；Jev 定位、API 延迟口径、Doom 输入方式。 |
| R2 | [TypeSafe Introduction][R2] | 动态文档；问题并行隔离与类型化输出。 |
| R3 | [TypeSafe Confidence][R3] | 动态文档；概率与 confidence 的区别。 |
| R4 | [Jev 1.13 jaggedness][R4] | 页面标注 2026-09-17；指定模型版本的局限。 |
| R5 | [General Agents: Introducing Ace][R5] | 官网快照；屏幕到键鼠操作。未从图表猜测未提取到的延迟数字。 |
| R6 | [Google I/O 2025 keynote][R6] | 2025-05-20；仅使用 Project Mariner 段落的历史功能说明。 |
| R7 | [SIMA 2 official announcement][R7] | 2025-11-13；游戏目标、推理与行动。 |
| R8 | [moeru-ai/airi][R8] | 开源仓库 README 快照；能力与 WIP 状态。未进行安装验收。 |
| R9 | [Tavus Perception][R9] | 动态文档；感知层与持续上下文。 |
| R10 | [Tavus Emotion Control][R10] | 动态文档；Phoenix-4/4.5 情绪表现、Raven/Sparrow 配合。 |
| R11 | [Figure Helix architecture][R11] | 2025-02-20；原始快慢系统架构先例，不称为最新 Helix 版本。 |
| X1 | [Google DeepMind SIMA 2 发布串][X1] | 索引可读，原页面未成功抓取；技术正文以 R7 为准。 |
| X2 | [AIRI 作者的 ADB + MCP 开发日志帖][X2] | 索引可读，原页面 403；不据此声称复现了手机操作。 |

[R1]: https://typesafe.ai/blog/introducing-system-one-models-and-jev
[R2]: https://docs.typesafe.ai/introduction
[R3]: https://docs.typesafe.ai/confidence
[R4]: https://docs.typesafe.ai/model-jaggedness/jev-1.13
[R5]: https://generalagents.com/ace/
[R6]: https://blog.google/innovation-and-ai/technology/ai/io-2025-keynote/
[R7]: https://deepmind.google/blog/sima-2-an-agent-that-plays-reasons-and-learns-with-you-in-virtual-3d-worlds/
[R8]: https://github.com/moeru-ai/airi
[R9]: https://docs.tavus.io/sections/conversational-video-interface/pal/perception
[R10]: https://docs.tavus.io/sections/conversational-video-interface/quickstart/emotional-expression
[R11]: https://www.figure.ai/news/helix
[X1]: https://x.com/GoogleDeepMind/status/1988986218722291877
[X2]: https://x.com/ayakaneko/status/1914956029856776252

# 原生实时音频接入

后续更新：已增加 [Cloudflare 统一凭据方案](cloudflare.md)，作为当前推荐入口。它使用 Cloudflare 目录中的 `typesafe/jev`、文字模型与 `xai/grok-voice`；下文记录的原厂模型选项仍可使用，但不是 Cloudflare Token 通用替换后的模型列表。

2026-09-18 M2 更新：Home 已由独立 Agent 统一协调输入、决策和慢思考；行动/外观语音增加输出许可和播放前转写校验。Cloudflare Jev + Grok 的有限真实音频样本已通过，详情见 [Agent 架构与 M2 验证](agent-architecture.md#14-m2-实现与验证)。下文历史验证记录按阶段保留，不能把较早的“尚未配置凭据”当成当前 Cloudflare 状态。

实现日期：2026-09-18。范围为 `apps/realtime-home`。第一阶段仍处于实时体验验收中：代码、协议和本地媒体传输的验证，与真实模型的识别质量、首音延迟和现场插话效果分开记录。

## 模型与框架

| 页面选项 | 模型默认值 | 实际框架 | 额外配置 |
| --- | --- | --- | --- |
| GPT-Realtime · 直连 | `gpt-realtime-2.1` | OpenAI Agents SDK，浏览器 WebRTC | `OPENAI_API_KEY` |
| GPT-Realtime · LiveKit | `gpt-realtime-2.1` | LiveKit Agents，Node 插件 | OpenAI 密钥与 LiveKit 连接 |
| GPT-Live · 双向同时说听 | `gpt-live-1` | LiveKit Agents，GPTLiveModel | 有 alpha 权限的 OpenAI 账号与 LiveKit 连接 |
| Gemini Live | `gemini-3.8-live` | LiveKit Agents，Google 插件 | `GEMINI_API_KEY` 与 LiveKit 连接 |
| Grok Voice | `grok-voice-think-fast-2.0` | LiveKit Agents，xAI 插件 | `XAI_API_KEY` 与 LiveKit 连接 |

默认选择已配置的原生音频方案；都未配置时展示 OpenAI 直连及其缺少的配置。旧版浏览器语音识别保留为单独选项，需要用户明确选择，不再自动回退到它。

版本采用查询当天的实际 npm 发布包：OpenAI Agents Realtime 0.18.0、LiveKit Agents 及三个模型插件 1.9.0、LiveKit Client 2.22.3。它们通过真实 SDK 构造器和传输层接入，不只在下拉框登记模型名字。

官方资料：

- [OpenAI GPT-Realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) 与 [Agents SDK 语音入门](https://openai.github.io/openai-agents-js/guides/voice-agents/quickstart/)。
- [LiveKit GPT-Live 插件](https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/)。GPT-Live 自主决定发言与停止，能够同时听和说；手动打断可以清理框架的播放队列，但不能强制取消模型的内部生成。默认 Responses 后端为 `gpt-5.6-luna`，会产生单独用量，只有世界查询工具提供给它。
- [Google Gemini 3.8 Live](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live)，2026-09-15 更新。使用原生音频、输入与输出转写、异步工具；移除不支持的 thinking 配置和 affective dialogue，也不设置 `proactive_audio:false`。
- [Grok Speech to Speech](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech)。
- [LiveKit 本地服务](https://docs.livekit.io/transport/self-hosting/local/) 与 [1.13.7 发布](https://github.com/livekit/livekit/releases/tag/v1.13.7)。
- [Pipecat](https://github.com/pipecat-ai/pipecat) 也在本轮调研中。它主要采用 Python pipeline，本项目本轮采用两套已提供 TypeScript/Node 接口的框架，未另建 Pipecat 服务。

“默认值”是可配置的接入选择，不代表这几个模型已经在同一数据集上测出质量排名。账号是否具有模型权限以实际连接结果为准。

## 启动

保留根目录现有 `.env`，增加至少一家原生音频提供商的密钥。最快的本地配置为保留现有 `SYSTEM_ONE_*`，再填入 `OPENAI_API_KEY`。执行 `pnpm dev`，页面打开 `http://127.0.0.1:5174`，选择“GPT-Realtime · 直连”。先继续世界，再点击“开始实时对话”并允许麦克风。

使用 LiveKit 路径时，可以接自己的 LiveKit Cloud，也可以启动本地服务：

```sh
pnpm voice:infra:up
```

本地开发环境的根目录 `.env` 添加：

```dotenv
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

然后填入所选模型的 `OPENAI_API_KEY`、`GEMINI_API_KEY` 或 `XAI_API_KEY`，重启 `pnpm dev`。本地 LiveKit 容器只将端口映射到 loopback，使用官方开发密钥。停止本项目的容器使用 `pnpm voice:infra:down`。命令同时兼容 `docker compose` 和独立 `docker-compose`。

Google 也接受 `GOOGLE_API_KEY`，OpenAI 接受 `VOICE_OPENAI_API_KEY` 优先覆盖通用密钥。模型名称可通过根目录 `.env.example` 中的 `VOICE_*_MODEL` 覆盖。密钥及模型配置的优先级仍为：进程环境 > 应用 `.env` > 根目录 `.env`。更高优先级的空值会遮蔽底层密钥。

页面提供静音、打断回复、结束通话和浏览器音频解锁按钮。结束或取消连接会释放麦克风、远端音频和框架会话。暂停或重置世界也会结束通话；不把上一轮会话接到新世界。单次会话最长 15 分钟，失去页面心跳 45 秒后回收。当前仍是一人共享世界，一次只允许一个语音会话。

## 对话如何改变行为

```text
麦克风 / 本通话文字输入 → 最终文本 → 独立 Agent → Jev
                                             ├─ 身体：继续 / 移动 / 交互 / 停止
                                             └─ 说话：状态 / 外观 / 普通聊天 / 静默
真实执行回执 / 近距离感知 → 本轮 OutputPermit → 原生语音生成
                                             ├─ 状态/外观：缓冲 → 转写精确匹配 → 播放
                                             └─ 普通聊天：获批后流式播放
新一轮说话 / 手动打断 / 事实失效 → 取消旧许可、生成和待播放音频
```

Jev 独立选择身体与 `speak` 动作。慢模型为文字和原生语音提出自然措辞，Jev 审核并选择后才交付；观察回执、提议返回或提议采纳都不会直接说话。`output-plan` 只返回正在执行的 speak，绑定执行 ID 与原文。音频模型只渲染这些原文；同一用户轮次可以有多次明确选择的发言。

LiveKit 包装公开 `RealtimeModel`/`RealtimeSession`，不把未经许可的自动 generation 交给播放层。确定文本模式先缓冲实际音频与转写，逐字检查后再提交 PCM/字幕；浏览器直连 OpenAI 关闭自动 response，保持接收轨道静音，用 MediaRecorder 缓冲行动语音，经服务端验证后才播放 Blob。取消许可会同时停止旧播放。错误句子被拦截时给出提示，但通话仍允许下一轮正常响应。

确定文本生成期间临时使用专门的朗读角色，通过 SDK 更新会话指令；完成后串行恢复原角色，避免人格/工具指令导致同一句被改写。普通聊天保留角色表达与流式体验，行动播报则增加完整生成和校验的等待，身体不因此停住。校验依赖提供商转写，不等于另一个 ASR 已核验音频波形；普通聊天自由文本的语义也没有确定性保证。

原生音频期间允许从输入框打字，文字会发给同一个实时音频会话并送入同一个 Jev 入口。麦克风中间转写用于显示，只有最终转写能改变动作。每段语音开始即分配轮次；旧转写、旧回复、旧世界或已经结束的会话不能覆盖最新输入。无法判断所属轮次的重叠转写会中止处理并明确报错，不猜测其属于最新指令。

自主行为保留 1 秒决策 tick，输入触发同一调度器，仍遵守 1 秒最短 Jev 请求间隔、单并发和错误退避。音频流和播放不受这个 tick 限制。动作停止或换目标的最终语义选择仍受 Jev 请求耗时影响，因此不能从 WebRTC 建连成功推断整条行为链路的延迟。

音频会话携带现有人格、心情、愿望和已存偏好。当前通话中的用户最终原话会记录为真实对话经历；语音回复带 `nativeAudio` 标记，避免浏览器再次朗读。原生语音复用同一慢思考提议和偏好采纳流程，不另设绕过 Jev 的语言模型对话后台。

## 凭据与验证边界

OpenAI 直连的永久密钥只用于服务端创建短时临时凭据，浏览器获得临时凭据后使用官方 WebRTC 客户端。LiveKit 模型密钥始终留在 Node 服务，浏览器只获得单房间、单身份的临时加入令牌。语音会话的控制凭据不进入 SSE、世界快照和生活文件。新的接口保留本地来源限制，并校验会话身份、世界版本和输入结构。

初次接入检查时只有 Jev 与文字模型配置。之后已用现有 Cloudflare 凭据完成真实 Jev + Grok 的行动与外观音频测试；原厂 OpenAI、Google 和 GPT-Live 的真实账号能力没有在这次 M2 中验证。真实识别质量、首音延迟分布、复杂声学插话和长期费用还需专门验收，协议测试不替代这些结果。

验证入口：

```sh
pnpm test           # 普通自动化，无付费请求
pnpm test:e2e       # 原有页面交互与旧版浏览器语音事件回归
pnpm test:native    # OpenAI 官方 SDK + 真实本地 WebRTC 媒体，远端为协议夹具
pnpm voice:infra:up
pnpm test:livekit   # LiveKit 官方框架 + 本地真实房间 + PCM 模型协议夹具
pnpm test:cloudflare # Cloudflare 路由协议 + 真实本地房间，不调用外部模型
# 已配置 Cloudflare 并启动本地 LiveKit 后：真实模型与真实音频，会消耗额度。
pnpm test:controlled-live
```

两个原生音频测试使用独立的 3104 端口，不读取 `.env`，不联系外部模型，不在用户的生活文件中保存测试对话。Chrome 使用合成采集设备；模型端音频为已知 PCM 波形。测试覆盖实际双向媒体、最终转写改变行为、连续改口、旧转写隔离、麦克风和模型连接释放。它们能验证代码与传输路径，不能验证人声识别或模型对话质量。

配置真实模型密钥后，另有 `pnpm test:voice-api` 验收入口。设置 `VOICE_TEST_PROFILE` 为一个页面方案 ID，`VOICE_TEST_AUDIO` 为包含“去睡觉”、短暂停顿后“改去喝水”的 PCM WAV 绝对路径；语音要间隔足够让第一轮选择开始，又要在动作完成前改口。该测试真实调用所选语音模型及 Jev，会消耗额度；45 秒上限，无重试，日志不记录会话令牌。它检查音频识别后的实际行为切换与原生声音输出，报告保存到隔离的 `test-results/native-api/`。缺少密钥或 WAV 会在启动模型前明确失败。本轮没有运行该付费音频验收。

## 初次接入的历史验证

2026-09-18 的最终检查：

| 项目 | 结果 |
| --- | --- |
| 冻结锁文件安装、工作区生产构建及 TypeScript | 通过 |
| 普通自动化 | Home 87、共享配置 8、早期 Demo 19，共 114 项通过 |
| 普通页面测试 | Home 8、Demo 2，共 10 项通过；390px 输入框与发送按钮完整可见 |
| OpenAI SDK 原生媒体协议测试 | 通过；两个真实 WebRTC peer 之间双向 RTP、连续改口、旧转写隔离及麦克风释放 |
| LiveKit Agents 原生媒体协议测试 | 通过；真实本地房间，麦克风音频进入插件，返回 PCM 在浏览器测得非静音声音，结束后模型 WebSocket 关闭 |
| 新语音桥接层 + 真实 Jev | 通过；3 次真实请求，睡觉→喝水→停止，2 次中断、0 次未完成动作效果、0 次旧文字 LLM 调用 |
| 新语音模型 API + 录音 / 实体麦克风 | 尚未验证，缺少提供商凭据；不能据此完成第一阶段验收 |

真实 Jev 样本的三次反应分别为 1,024、390、941 ms，从最终转写到达起计算，不包含声学识别或首音播放时间。该样本入口为 `pnpm --filter @realtime-agent/home test:live native-body.spec.ts`，报告在 `apps/realtime-home/test-results/native-body/`。输入转写在测试中确定性生成，只有 Jev 为真实请求。

测试发现并修复了 LiveKit OpenAI 1.9.0 的关闭时队列等待问题：关闭后通过公共 `clearAudio()` 唤醒队列，让读循环观察到关闭状态并结束 WebSocket。这个兼容处理位于 `server/voice/model-lifecycle.ts`，有真实媒体测试核对连接回收；升级插件时应重新运行该测试。还修复了迟到转写按到达顺序误判为最新输入的问题。

前端 SDK 按所选方案动态加载，首页不会同时下载两套语音框架。构建仍提示部分分块超过 500 kB，包括 Three.js 和语音 SDK；没有提高警告阈值隐藏它。没有进行长时间稳定性、真实声学回声或多人并发评测。

## M2 受控输出验证

OpenAI 直连两项媒体测试通过：真实双向 WebRTC、旧输入隔离和麦克风释放；另用实际 MediaRecorder 验证错误转写得到服务端拒绝、播放器未启动且波形静音，随后正确文本在同一连接中获批并播放。Cloudflare/LiveKit 两项媒体测试通过：实际房间双向 PCM、连接回收；未经许可的自动回复与错误行动句保持静音，下一轮正确句子正常发声。

真实模型测试 `test:controlled-live` 使用独立端口 3105、现有 Cloudflare 凭据、真实 Jev 和 Grok，以及真实本地音频房间。用户输入经通话文字入口发送，测试采集设备保持静音，因此本次不检验物理麦克风或真实人声识别。获批音频在浏览器测得非静音 PCM，并在播放完成后记录原生回复。最终通过的样本为“去床边看看”及到达后的“床是什么颜色”，6 次 Jev 调用，报告位于 `test-results/controlled-live/verification-1789738173743.json`。

第一次尝试中，颜色回复被输出校验拦截；该失败报告独立保留。修正确定文本生成的角色冲突后，保持原校验和断言复跑通过。自由聊天可能产生的无依据表达、播报通道分类错误、较长句子的首音等待与更多提供商的真实行为仍不能由这一个成功样本排除。

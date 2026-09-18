# 原生实时音频接入

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
麦克风 → 原生音频模型 → 流式音频 → 扬声器
               │
               ├─ 语音开始：当前动作让出执行，保留进度
               ├─ 最终转写：携带原始语音轮次，送入 Jev
               │                   ↓
               │           继续 / 改目标 / 停止
               │                   ↓
               │            原有寻路与执行器
               └─ observe_world：读取实际执行结果
```

Jev 继续决定所有身体动作。语音模型专门负责听与说，`observe_world` 是只读工具：它最多等待约 2.8 秒取得该轮次的执行选择，不等待生活动作完整结束，更不能把口头承诺写成已完成效果。用户最终转写直接进入原有行为入口，模型不需要通过工具拼装另一个行动指令。原生通话期间，旧的 DeepSeek 文字回复与浏览器朗读不会同时启动；结束后仍可使用原来的文字与慢思考功能。

原生音频期间允许从输入框打字，文字会发给同一个实时音频会话并送入同一个 Jev 入口。麦克风中间转写用于显示，只有最终转写能改变动作。每段语音开始即分配轮次；旧转写、旧回复、旧世界或已经结束的会话不能覆盖最新输入。无法判断所属轮次的重叠转写会中止处理并明确报错，不猜测其属于最新指令。

自主行为保留 1 秒决策 tick，输入触发同一调度器，仍遵守 1 秒最短 Jev 请求间隔、单并发和错误退避。音频流和播放不受这个 tick 限制。动作停止或换目标的最终语义选择仍受 Jev 请求耗时影响，因此不能从 WebRTC 建连成功推断整条行为链路的延迟。

音频会话携带现有人格、心情、愿望和已存偏好。当前通话中的用户最终原话会记录为真实对话经历；语音回复带 `nativeAudio` 标记，避免浏览器再次朗读。原生音频还没有额外实现独立的偏好归纳后台，因此不宣称原生语音已经复用了全部 DeepSeek 记忆总结流程。

## 凭据与验证边界

OpenAI 直连的永久密钥只用于服务端创建短时临时凭据，浏览器获得临时凭据后使用官方 WebRTC 客户端。LiveKit 模型密钥始终留在 Node 服务，浏览器只获得单房间、单身份的临时加入令牌。语音会话的控制凭据不进入 SSE、世界快照和生活文件。新的接口保留本地来源限制，并校验会话身份、世界版本和输入结构。

本轮检查时，环境中已存在 Jev 与 DeepSeek 配置；OpenAI、Google、xAI 和 LiveKit 的生产凭据尚未配置。新原生音频 API 的真实识别质量、真实首音延迟、复杂插话效果和费用仍待使用有权限的密钥验收。不能将下列协议测试称为真实模型联调通过。

验证入口：

```sh
pnpm test           # 普通自动化，无付费请求
pnpm test:e2e       # 原有页面交互与旧版浏览器语音事件回归
pnpm test:native    # OpenAI 官方 SDK + 真实本地 WebRTC 媒体，远端为协议夹具
pnpm voice:infra:up
pnpm test:livekit   # LiveKit 官方框架 + 本地真实房间 + PCM 模型协议夹具
```

两个原生音频测试使用独立的 3104 端口，不读取 `.env`，不联系外部模型，不在用户的生活文件中保存测试对话。Chrome 使用合成采集设备；模型端音频为已知 PCM 波形。测试覆盖实际双向媒体、最终转写改变行为、连续改口、旧转写隔离、麦克风和模型连接释放。它们能验证代码与传输路径，不能验证人声识别或模型对话质量。

配置真实模型密钥后，另有 `pnpm test:voice-api` 验收入口。设置 `VOICE_TEST_PROFILE` 为一个页面方案 ID，`VOICE_TEST_AUDIO` 为包含“去睡觉”、短暂停顿后“改去喝水”的 PCM WAV 绝对路径；语音要间隔足够让第一轮选择开始，又要在动作完成前改口。该测试真实调用所选语音模型及 Jev，会消耗额度；45 秒上限，无重试，日志不记录会话令牌。它检查音频识别后的实际行为切换与原生声音输出，报告保存到隔离的 `test-results/native-api/`。缺少密钥或 WAV 会在启动模型前明确失败。本轮没有运行该付费音频验收。

## 本轮实际验证

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

# 只用 Cloudflare 凭据启动

实现日期：2026-09-18。Home 的行为决策、文字对话和实时语音可以共用 Cloudflare Account ID 与一个 API Token。原生音频使用 Cloudflare 模型目录中的 `xai/grok-voice`，不需要自行申请 xAI、OpenAI、Google 或 LiveKit Cloud 密钥。

## 启动

保留根目录现有 `.env`，添加两项：

```dotenv
CLOUDFLARE_ACCOUNT_ID=你的32位账户ID
CLOUDFLARE_API_TOKEN=你的Cloudflare_API_Token
```

Token 的权限为 **Account → Workers AI → Read**，资源选择对应账户。只具有 AI Gateway 权限的 Token 无法调用 `/accounts/{id}/ai/*`。这里使用 API Token，不使用需要账户邮箱配合的 Global API Key。旧变量名 `CLOUDFLARE_API_KEY` 也接受，但其值仍必须是 API Token。

在 Cloudflare 控制台 **AI → AI Gateway → Credits Available → Manage** 充值预付余额，用于第三方模型统一计费。无需向应用填写 Gateway ID，也无需为每家模型保存 BYOK 密钥。

本机 Docker 可用时，在项目根目录运行：

```sh
pnpm dev:cloudflare
```

命令先检查配置，再启动本项目的本地 LiveKit 音频房间和 Home 服务。打开 `http://127.0.0.1:5174`，选择“Cloudflare · Grok 实时语音”，点击“开始实时对话”并允许麦克风。

本地房间默认采用 `ws://127.0.0.1:7880` 与官方开发配置，端口只绑定 loopback。它是浏览器与 Node 音频框架之间的媒体传输服务，不是另一个需要申请的模型 API。停止本项目的房间使用 `pnpm voice:infra:down`。已有远程 LiveKit 时可显式设置三项 `LIVEKIT_*`；设置任一项后应用不再补入开发密钥。

## 实际使用的模型与路由

| 能力 | Cloudflare 模型 | 路由 |
| --- | --- | --- |
| Jev 行为选择 | `typesafe/jev` | `POST /accounts/{id}/ai/run`，`model + input` 格式 |
| 文字对话、计划、反思 | `openai/gpt-4.1-mini` | `POST /accounts/{id}/ai/v1/chat/completions` |
| 连续实时听说 | `xai/grok-voice` | `WSS /accounts/{id}/ai/run?model=xai/grok-voice` |

三条路由均在服务端使用同一个 `Authorization: Bearer` Token。`CLOUDFLARE_LLM_MODEL` 可以覆盖文字模型，填写 Cloudflare 目录中的第三方 `author/model` 名称。默认文字模型是有官方调用示例的起步选择，不宣称它是最新或最强模型。Workers AI 的 `@cf/...` 模型需要额外的 Gateway 路由配置，不作为此两项配置方案的覆盖项。

`xai/grok-voice` 是 Cloudflare 的目录别名，上游具体版本由平台提供。之前接入的 GPT-Live、GPT-Realtime 和 Gemini Live 仍保留为原厂方案；没有把 Cloudflare Token 填进它们的原厂鉴权字段，也不宣称这些特定实时模型都能通过 Cloudflare 免原厂密钥访问。

只要填入 Cloudflare Token 或账户 ID，配置加载器就自动选择 Cloudflare；`pnpm dev:cloudflare` 显式强制 Cloudflare 与真实模式。此模式忽略旧 `SYSTEM_ONE_*`、`LLM_*` 及原厂语音密钥，缺少 Cloudflare 配置时明确停止，不回退使用旧密钥。原厂配置保存在原 `.env` 中，可通过 `AI_PROVIDER=direct` 明确恢复。进程、应用 `.env`、根 `.env` 的优先级不变，空值仍遮蔽下层值。

## 音频与行为

浏览器通过 LiveKit 的真实 WebRTC 音频进入 Node 的 xAI 插件。一个仅监听随机本机端口的适配器，将插件的 `/realtime` 握手转换为 Cloudflare 文档规定的 `/ai/run` WebSocket 路由。适配器使用每次通话的随机本地凭据；Cloudflare Token 不进入浏览器、SSE 或 SDK 的本地连接配置。它拒绝浏览器 Origin 和无效本地凭据，限制帧大小与传输积压，关闭或失败时回收两端连接。

最终语音转写依旧交给 Jev 决定身体行为，语音模型只查询世界结果。只有合法、未过期的 Jev 决策能继续、切换或停止动作；被打断的动作不结算完成效果。xAI 最终转写一到达即交给行为桥接，不额外等待其首个回复音频帧。音频流式输出与 1 秒行为调度分别运行。

## 验证入口和范围

```sh
pnpm test
pnpm build
pnpm voice:infra:up
pnpm test:cloudflare
```

普通测试检查三条路由的凭据、Jev 请求体、Cloudflare 响应解包、错误净化、原厂配置隔离、空值覆盖和会话控制。`test:cloudflare` 经过真实浏览器、真实本地 LiveKit 房间、实际 xAI 插件与实际 WebSocket 适配器；仅将 Cloudflare 网络目的地替换成本地协议测试服务。该服务核验固定账户路径和 Token，并传输确定性的 PCM 波形和转写，测试睡觉途中改去喝水以及结束后的媒体连接释放。

这些测试不能证明真实 Cloudflare 账户的权限、余额、人声识别质量或模型延迟。当前工作区尚未配置 Cloudflare Token 和 Account ID，因此不把协议与媒体测试宣称为真实 Cloudflare 模型联调。

本次最终验证：工作区普通测试 **128 项通过**（Home 97、Demo 19、配置包 12），Home 页面回归 **8 项通过**，Cloudflare 适配链路与原有 LiveKit 链路的媒体测试各 **1 项通过**，工作区构建与类型检查通过。Cloudflare 媒体用例还验证了 `status=in_progress` 的转写不产生用户轮次或身体动作，最终转写才交给 Jev；用户和角色字幕按麦克风轨道区分。

媒体测试曾发现 xAI 1.9.0 插件的取消时序问题：取消请求在等待后清理“当前生成”，可能误清理刚到达的新回复，表现为收到音频帧却没有播放。现在取消与清理绑定到调用开始时的生成，在让出事件循环前完成，保留正常插话取消。修复由上述真实音频传输测试覆盖，没有降低波形断言阈值。帧来自协议测试服务，不将它计入真实模型首音延迟。

真实账户配置后，可以沿用 `pnpm test:voice-api`；设置 `VOICE_TEST_PROFILE=cloudflare-grok` 和 `VOICE_TEST_AUDIO` 为测试 WAV 的绝对路径，先启动本地音频房间。该入口真实调用 Jev 和语音模型，会消耗账户额度。真实结果与媒体协议测试分别保存。

## 官方契约

- [Cloudflare REST API：统一路由、鉴权权限](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Unified Billing：账户预付额度与第三方凭据](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [typesafe/jev：请求与响应](https://developers.cloudflare.com/ai/models/typesafe/jev/)
- [xai/grok-voice：Cloudflare WebSocket 接口](https://developers.cloudflare.com/ai/models/xai/grok-voice/)

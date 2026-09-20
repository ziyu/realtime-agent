# Cloudflare 凭据与验收边界

本项目的 Cloudflare 模式只使用同一账户的 API Token。无需准备 TypeSafe、OpenAI、xAI 或 LiveKit 云端密钥。

在根目录现有 `.env` 中追加或修改以下三个变量，保留原有其他内容：

```dotenv
AI_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=你的32位账户ID
CLOUDFLARE_API_TOKEN=你的API_Token
```

Account ID 是账户标识，不是另一把密钥。它位于 Cloudflare 账户首页。这里需要 API Token，不是 Global API Key。

按 Cloudflare 2026-09-17 更新的 [统一 REST API 文档](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)，`/accounts/{account_id}/ai/*` 路径要求 **Account → Workers AI → Read**。只有 AI Gateway 管理权限或 Realtime/SFU 权限的 Token 不足以调用这些模型。Token 的账户资源范围应包含上述 Account ID。

第三方模型通过 [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) 使用 Cloudflare 管理的模型凭据并消耗预充值余额。账户需要有足够 AI Gateway credits；订阅 Workers 或持有 Token 本身不等于有第三方模型额度。

当前统一路径：

| 职责 | 模型 | 接口 |
| --- | --- | --- |
| 实时听说 | `xai/grok-voice` | `wss://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run?model=xai/grok-voice` |
| 行为决策 | `typesafe/jev` | `POST /accounts/{account_id}/ai/run`，传入 `{model,input:{state,questions}}` |
| 文字对话与反思 | `openai/gpt-4.1-mini`（可用 `CLOUDFLARE_LLM_MODEL` 调整） | `POST /accounts/{account_id}/ai/v1/chat/completions` |

模型协议来源：[Grok Voice](https://developers.cloudflare.com/ai/models/xai/grok-voice/index.md)、[Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/index.md)、[GPT-4.1 mini](https://developers.cloudflare.com/ai/models/openai/gpt-4.1-mini/index.md)。这里使用 Cloudflare 的统一模型接口，未将 CF Token 直接发往原厂接口。声音仍来自 Grok 模型，不能描述成 Cloudflare 自己训练的语音模型。

`pnpm dev:cloudflare` 负责启动本地媒体房间及应用。媒体房间使用已有 LiveKit 开源运行时和本机开发配置，无需 LiveKit 云账户。它只是浏览器与本地 Node 会话之间的音频传输，付费模型请求统一发往 Cloudflare。

## 独立转发边界验证

`apps/realtime-home/tests/cloudflare-relay-review.test.ts` 在本机真实 HTTP/WebSocket 上验证：

- 音频二进制和 JSON 能双向传送；Cloudflare Token 仅用于上游请求，SDK 使用独立的每次通话凭据。
- 错误会话凭据和外部浏览器 Origin 在发起上游连接前即被拒绝。
- 上游 HTTP 403 被转为状态诊断，不回传可能含有密钥的错误正文。
- 在上游握手未完成时取消通话，能够释放待升级连接及两端 socket。

运行：`pnpm --filter @realtime-agent/home exec vitest run tests/cloudflare-relay-review.test.ts`。

2026-09-18 本轮四项均通过；随后执行工作区 `pnpm test`，合计 128 项通过（Home 97、Demo 19、配置包 12）。`pnpm typecheck` 和 `pnpm build` 通过。构建保留现有大分块提示。这些测试的上游是本地协议服务器，不证明 Cloudflare 账户权限、额度或真实语音质量。当前尚未提供 Cloudflare Token，因此真实人声识别、模型首音时间、口头改令及取消后的行为效果仍需使用真实账户验收，不能以本地转发成功宣布第一阶段完成。

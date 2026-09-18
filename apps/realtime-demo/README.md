# RealtimeAgent · v0.1

一个可以生活、可以被实时对话打断的 3D Agent 家园。**Jev 选择行为，也决定何时调用 LLM；LLM 只提供对话、建议和记忆，不能直接执行动作。**

本应用是 pnpm workspace 中的 `@realtime-agent/demo`，位于 `apps/realtime-demo`。依赖统一使用仓库根目录的 `pnpm-lock.yaml`，世界协议和数据仍由本应用独立管理。下文的工作区命令在仓库根目录执行。

## 启动

需要 Node.js 22.13+ 和 pnpm 11.1.2。项目已在 Node.js 26.5.0、本机 Chrome 上验证。

```sh
pnpm install
pnpm dev:demo
```

打开 **http://localhost:3007**。前端和 API 共用一个本机端口。也可以进入本应用目录执行 `pnpm dev`。

不配置密钥即可体验 **OFFLINE DEMO**：快系统是有限的本地规则，慢系统是模板模拟。模拟延迟、分布和调用次数均有标识，不能用于判断真实模型的能力或成本。真实模式失败时不会自动切回模拟。

## 连接真实 Jev / LLM

在右上角「模型连接」中选择「连接真实模型」，填写 TypeSafe API Key。Jev 模型默认 `jev-latest`。LLM 可填写支持 `/chat/completions` 的 API Base URL、模型 ID 和 API Key；不预设你的账号可用模型。Base URL 通常以 `/v1` 结尾，不包含 `/chat/completions`。

密钥只保留在本机服务进程；保存配置不会将密钥写入浏览器存储或磁盘。也可使用仓库根目录 `.env`，两个应用通过共享服务端配置加载器读取 `SYSTEM_ONE_BASE_URL`、`SYSTEM_ONE_MODEL`、`SYSTEM_ONE_API_KEY` 和 `LLM_*`；进程环境 > 应用 `.env` > 根目录 `.env`。旧 `TYPESAFE_API_KEY` 与 `JEV_MODEL` 仍兼容。需要应用独立配置时可创建本目录 `.env`：

```sh
cp apps/realtime-demo/.env.example apps/realtime-demo/.env
```

```dotenv
PORT=3007
AGENT_MODE=live
TYPESAFE_API_KEY=your-typesafe-key
JEV_MODEL=jev-latest
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-llm-key
LLM_MODEL=your-available-model-id
```

只配置 Jev 也能选择生活动作；未配置 LLM 时，运行时不会把慢思考加入可选能力。完整验证双系统需要同时配置两者。设置界面保存成功不等于提供商认证成功，真实调用结果在运行时面板中显示。

Jev 使用官方 `POST https://api.typesafe.ai/v1/systemone`，传入 `state`、`model` 和一个 `choice` 问题，`criteria` 是当前合法行为的 ID—描述映射。适配器校验返回的选项与概率分布。文档：<https://docs.typesafe.ai/api>。

## 体验路径

输入「先喝水，再读书」，观察 Milo 寻路、到达物体、交互以及需求变化。途中输入「不要读书了，去睡觉」，观察新决策打断旧动作。输入「停止」后，Milo 会等待新指令。

输入「帮我规划一下今天」观察快系统邀请慢系统；LLM 返回建议后，必须由快系统重新选择动作。输入「记住：我喜欢安静，工作后先休息」观察记忆沉淀。模拟模式仅支持有限关键词和模板，开放式理解需要真实模型。

点击场景中的家具，或打开「12 个交互对象」，也只是发送一条生活指令，不会绕过 Jev 直接驱动角色。

厨房、卧室、书房和花园共有 12 个对象：冰箱、料理台、水槽、餐桌、床、淋浴间、床头灯、工作桌、书架、沙发、花圃、长椅。可执行吃零食、做饭、吃饭、喝水、睡觉、洗澡、工作、阅读、休息、浇花、花园小坐、切换灯光。

支持旋转/缩放视角、暂停、1×/3× 时间速度、补充食材、重置、记忆浏览、决策分布与调用记录、JSON 导出。浏览器支持时可用语音识别和回复朗读；语音识别完成后会发送文本。识别可能使用浏览器提供商的在线服务，实际麦克风和语音效果未纳入自动化验证。这不是全双工实时音频模型。

## 运行时边界

聊天只更新观察状态。快系统在合法候选中选择行为或慢思考请求；服务端负责寻路、动作计时和资源结算。LLM 结果仅写入建议/对话/带用户消息来源的记忆。新指令、暂停或模式切换会使旧模型请求失效，过期结果不得覆盖新指令。

记忆保存到 `data/memories-demo.json` 或 `data/memories-live.json`，两种模式隔离。重启恢复记忆，其他世界状态重新开始。记忆是外部偏好记录，不是模型权重学习、自动技能训练或自主创建新动作。

本项目是单进程、单 Agent、本机共享世界；多个标签页控制同一个 Milo。服务仅绑定 `127.0.0.1`，校验本机 Host、Origin 和写入令牌，密钥不进入 SSE/世界状态。不要直接暴露到公网。真实模式会向模型提供商发送世界状态、近期对话和相关记忆。导出的记录包含对话和记忆，分享前请检查隐私。

## 验证

```sh
pnpm --filter @realtime-agent/demo run test      # 运行时、寻路、模型契约和本机 API 测试
pnpm --filter @realtime-agent/demo run build     # 严格 TypeScript 检查 + Vite 生产构建
pnpm --filter @realtime-agent/demo run test:e2e  # 本机 Chrome：桌面与 390px 布局/真实页面交互
```

本次上述命令全部通过，E2E 共 2 项。测试独占 3008 端口，强制模拟模式，不复用用户服务；测试记忆保存在 `.test-data/`。截图输出到 `test-results/desktop.png`、`test-results/mobile.png`。

**未进行带真实密钥的 Jev / LLM 请求。** 模型 HTTP 测试使用响应夹具；浏览器验证使用模拟器。真实自然语言理解质量、延迟、限流与费用需要接入你的账号后测试。生产构建存在 Three.js 主包大于 500 KB 的体积提示，不影响构建成功。

生产方式：先构建，再在仓库根目录执行 `NODE_ENV=production pnpm start:demo`，仍在本机 3007 端口提供页面与 API。

## 代码入口

- `shared/world.ts`：对象、动作、世界类型、碰撞与 A* 寻路。
- `server/runtime.ts`：权威世界、动作执行、双系统调度、打断与失效处理。
- `server/providers.ts`：官方 Jev / LLM 适配、响应校验、显式模拟器。
- `server/http.ts`、`server/index.ts`：本机 API、SSE、配置与记忆持久化。
- `src/scene.ts`：程序化 Three.js 家园、机器人与交互。
- `src/main.ts`、`src/style.css`：实时聊天、运行时观察与响应式界面。
- `tests/`：不消耗真实模型额度的自动化验证。

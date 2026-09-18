# RealtimeAgent Home 入口

Home 位于 **`apps/realtime-home/`**，工作区包名为 **`@realtime-agent/home`**。仓库已迁移为 pnpm monorepo，根目录默认命令启动此应用。

在本项目根目录执行：

```sh
pnpm install
pnpm dev
```

浏览器打开 **http://127.0.0.1:5174**。权威世界服务使用 `127.0.0.1:3102`；自动读取仓库根目录 `.env`，配置 System One 密钥后默认真实运行，无密钥时使用本地演示。

真实模式的配置见 [启动与模型连接说明](apps/realtime-home/README.md)，运行时设计见 [架构说明](apps/realtime-home/docs/architecture.md)，本轮实际验证见 [验证记录](apps/realtime-home/docs/verification.md)。

依赖使用根目录唯一的 `pnpm-lock.yaml`。应用仍有自己的类型配置、构建、测试、`.env`、记忆目录和端口。只检查 home 时可以运行 `pnpm --filter @realtime-agent/home run test`。

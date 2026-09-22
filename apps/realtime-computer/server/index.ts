import { fileURLToPath } from 'node:url';
import { ComputerConfigurationError, formatComputerConfiguration, requireComputerModels, resolveComputerStartup } from './startup.js';

async function main(): Promise<void> {
  const startup = resolveComputerStartup({ appDirectory: fileURLToPath(new URL('../', import.meta.url)), args: process.argv.slice(2) });
  if (startup.checkOnly) {
    console.log(formatComputerConfiguration(startup));
    process.exitCode = startup.ready ? 0 : 1;
    return;
  }
  if (startup.mode === 'live') requireComputerModels(startup);
  const { port, config, ready } = startup;
  let session: { origin: string; close(): Promise<void> };
  if (startup.mode === 'browser-demo') {
    const { startComputerServer } = await import('./app.js');
    session = await startComputerServer({ port, mode: 'demo' });
    console.log(`Browser fixture (not the Windows desktop): ${session.origin}`);
  } else {
    const { createComputerProviders } = await import('./cua-models.js');
    const { startCuaServer } = await import('./cua-app.js');
    const { CuaTransport } = await import('./cua-transport.js');
    if (!ready && startup.mode !== 'manual') console.warn(formatComputerConfiguration(startup));
    const driver = await CuaTransport.open();
    try {
      session = await startCuaServer({ driver,
        providers: ready && config ? runtime => createComputerProviders(config, { tools: runtime.tools.modelCatalog(),
          ...(startup.vision ? { image: () => runtime.modelImage(), allowImageFallback: startup.visionMode === 'auto' } : {}) }) : null,
        port, modelError: ready ? null : startup.mode === 'manual'
        ? '已选择手动模式；自动任务请使用配置齐全的 live 入口。'
        : `缺少 ${startup.missing.join('、')}。填写项目 .env 后运行 pnpm check:computer。` });
    } catch (error) { await driver.close(); throw error; }
    console.log(`Cua computer connected: ${session.origin} (${ready ? 'System One + LLM' : 'manual input'}; Driver ${driver.metadata.driverVersion})`);
  }
  const close = () => { void session.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}

try { await main(); }
catch (error) {
  if (!(error instanceof ComputerConfigurationError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}

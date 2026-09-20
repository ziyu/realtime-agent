import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig, loadVoiceConfig, LOCAL_VOICE_ROOM } from '@realtime-agent/config';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(appDirectory, '../..');
const environment = { ...process.env, AI_PROVIDER: 'cloudflare', AGENT_MODE: 'live' };

async function run(command: string, args: string[], cwd: string): Promise<number> {
  const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const handlers = signals.map(signal => () => { child.kill(signal); });
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  return new Promise(resolve => {
    const remove = () => { signals.forEach((signal, index) => process.off(signal, handlers[index])); };
    child.once('error', () => { remove(); console.error('启动命令失败，请检查 pnpm 与 Docker 是否可用。'); resolve(1); });
    child.once('exit', code => { remove(); resolve(code ?? 1); });
  });
}

try {
  // Validate before starting a container or contacting a model, with no credential logging.
  loadRuntimeConfig({ appDirectory, defaultPort: 3102, environment });
  const config = loadVoiceConfig({ appDirectory, environment });
  let exitCode = 0;
  if (config.livekit.url === LOCAL_VOICE_ROOM.url) exitCode = await run(process.execPath, ['scripts/livekit-infra.mjs', 'up'], workspace);
  if (exitCode === 0) {
    console.log('Cloudflare 模式：Jev、文字与实时语音共用账户 API Token。');
    exitCode = await run('pnpm', ['run', 'dev'], appDirectory);
  }
  process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : '无法启动 Cloudflare 模式。');
  process.exitCode = 1;
}

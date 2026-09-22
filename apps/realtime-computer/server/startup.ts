import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { loadRuntimeConfig, runtimeConfigFiles } from '@realtime-agent/config';
import type { RuntimeConfig } from '@realtime-agent/config';

export type ComputerStartupMode = 'auto' | 'live' | 'manual' | 'browser-demo';
export interface ComputerStartup {
  mode: ComputerStartupMode;
  checkOnly: boolean;
  port: number;
  vision: boolean;
  visionMode: 'auto' | 'required' | 'off';
  config: RuntimeConfig | null;
  ready: boolean;
  missing: string[];
  files: { path: string; exists: boolean }[];
}

export class ComputerConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'ComputerConfigurationError'; }
}

/** Resolve configuration before importing or starting the native driver. This makes checks side-effect-free. */
export function resolveComputerStartup(options: {
  appDirectory: string;
  args: readonly string[];
  environment?: Record<string, string | undefined>;
}): ComputerStartup {
  const args = new Set(options.args);
  if ([...args].some(arg => !['--live', '--manual', '--browser-demo', '--check-config'].includes(arg))) {
    throw new ComputerConfigurationError('支持的启动参数：--live、--manual、--browser-demo、--check-config。');
  }
  const modes = ['--live', '--manual', '--browser-demo'].filter(arg => args.has(arg));
  if (modes.length > 1 || args.has('--check-config') && (args.has('--manual') || args.has('--browser-demo'))) {
    throw new ComputerConfigurationError('请选择一种运行模式；--check-config 用于检查自动任务所需的模型配置。');
  }
  const mode: ComputerStartupMode = args.has('--live') ? 'live' : args.has('--manual') ? 'manual' : args.has('--browser-demo') ? 'browser-demo' : 'auto';
  const environment = options.environment ?? process.env;
  const port = Number(environment.COMPUTER_PORT || environment.PORT || 3110);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ComputerConfigurationError('COMPUTER_PORT / PORT 必须是 1–65535 的整数。');
  const base = { mode, checkOnly: args.has('--check-config'), port, vision: false, visionMode: 'off' as ComputerStartup['visionMode'] };
  if (mode === 'manual' || mode === 'browser-demo') return { ...base, config: null, ready: false, missing: [], files: [] };

  const files = runtimeConfigFiles(options.appDirectory).map(path => ({ path, exists: existsSync(path) }));
  let config: RuntimeConfig;
  try {
    // Probe both model roles before enforcing live readiness; the shared loader's
    // demo mode permits absent credentials but still validates URLs and providers.
    config = loadRuntimeConfig({ appDirectory: options.appDirectory, defaultPort: port,
      environment: { ...environment, AGENT_MODE: 'demo', ...(environment.COMPUTER_PORT ? { PORT: environment.COMPUTER_PORT } : {}) } });
    const vision = [environment, ...files.map(file => file.exists ? parseEnv(readFileSync(file.path, 'utf8')) : {})]
      .find(layer => layer.COMPUTER_VISION !== undefined)?.COMPUTER_VISION?.trim() || 'auto';
    if (!['auto', '0', '1'].includes(vision)) throw new ComputerConfigurationError('COMPUTER_VISION 必须是 auto、0 或 1。');
    base.visionMode = vision === '1' ? 'required' : vision === '0' ? 'off' : 'auto';
    base.vision = base.visionMode !== 'off';
  } catch (error) {
    // Config loader errors deliberately contain field names, never supplied values.
    const reason = error instanceof Error ? error.message : '配置格式无效。';
    throw new ComputerConfigurationError(`${reason}\n${formatFiles(files)}`);
  }
  const missing: string[] = [];
  if (config.provider === 'cloudflare') {
    if (!config.systemOne.baseUrl || !config.llm.baseUrl) missing.push('CLOUDFLARE_ACCOUNT_ID');
    if (!config.systemOne.apiKey || !config.llm.apiKey) missing.push('CLOUDFLARE_API_TOKEN');
  } else {
    if (!config.systemOne.apiKey) missing.push('SYSTEM_ONE_API_KEY');
    if (!config.llm.apiKey) missing.push('LLM_API_KEY');
    if (!config.llm.model) missing.push('LLM_MODEL');
  }
  const ready = missing.length === 0;
  config.mode = ready ? 'live' : 'demo';
  return { ...base, port: config.port, config, ready, missing, files };
}

function formatFiles(files: ComputerStartup['files']): string {
  return ['配置优先级：进程环境变量 > 应用 .env > 根目录 .env（空值也会覆盖低优先级配置）。',
    ...files.map(file => `  ${file.path}（${file.exists ? '已存在' : '不存在'}）`)].join('\n');
}

/** Only allowlisted status and paths are formatted, never model names, URLs or credential values. */
export function formatComputerConfiguration(startup: ComputerStartup): string {
  const provider = startup.config?.provider === 'cloudflare' ? 'cloudflare' : 'direct';
  const lines = [startup.ready ? '[Computer] 模型配置已齐全；尚未验证网络、账户权限或模型调用。' : '[Computer] 自动任务配置未就绪。',
    `接入方式：${provider}`, ...(startup.missing.length ? [`缺少：${startup.missing.join('、')}`] : []), formatFiles(startup.files)];
  if (!startup.ready) {
    lines.push('请在上述 .env 文件中填写有效配置。模板：apps/realtime-computer/.env.example。');
    if (provider === 'direct') lines.push('LLM_BASE_URL 应与 LLM_API_KEY、LLM_MODEL 属于同一个服务；不设置时使用当前默认的 OpenAI 兼容端点。',
      '已有 Cloudflare 配置时，可改设 AI_PROVIDER=cloudflare，并填写 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN。');
    lines.push('填好后运行 pnpm check:computer 检查，再运行 pnpm dev:computer:live。');
  }
  return lines.join('\n');
}

export function requireComputerModels(startup: ComputerStartup): void {
  if (!startup.ready) throw new ComputerConfigurationError(formatComputerConfiguration(startup));
}

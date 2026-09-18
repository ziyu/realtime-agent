import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const action = process.argv[2];
if (!['up', 'down'].includes(action)) throw new Error('Use up or down.');
const candidates = [['docker', 'compose'], ['docker-compose']];
const command = candidates.find(([executable, ...prefix]) => spawnSync(executable, [...prefix, 'version'], { stdio: 'ignore' }).status === 0);
if (!command) throw new Error('Docker Compose was not found. Install Docker Compose, or use LiveKit Cloud with LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.');
const [executable, ...prefix] = command;
const result = spawnSync(executable, [...prefix, '-f', 'infra/livekit/compose.yaml', action, ...(action === 'up' ? ['-d'] : [])], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
});
process.exitCode = result.status ?? 1;

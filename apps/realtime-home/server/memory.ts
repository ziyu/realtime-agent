import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Memory } from '../shared/types';

export const memorySchema = z.object({ id: z.string(), text: z.string().max(1000), source: z.enum(['experience', 'reflection']), at: z.number(), evidenceIds: z.array(z.string().max(100)).max(8).optional(), evidenceText: z.string().max(1600).optional() });
const schema = z.array(memorySchema).max(60);
export class MemoryStore {
  private loadFailed = false;
  constructor(private path: string) {}
  load(): Memory[] {
    if (!existsSync(this.path)) return [];
    try { return schema.parse(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch {
      this.loadFailed = true;
      console.warn('Memory file could not be loaded. The existing file is preserved and persistence is disabled until it is repaired.');
      return [];
    }
  }
  save(memories: Memory[]) {
    if (this.loadFailed) throw new Error('Refusing to overwrite a memory file that failed to load.');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(schema.parse(memories), null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}

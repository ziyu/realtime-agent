import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Memory } from '../shared/types';
import type { MindState } from '../shared/mind';
import { createMind, mindSchema } from './mind';
import { memorySchema } from './memory';

export interface LifeSnapshot { mind: MindState; memories: Memory[] }
const schema = z.object({ version: z.literal(1), mind: mindSchema, memories: z.array(memorySchema).max(60) });

/** One atomic commit keeps personal wishes, evidence and learned memories consistent. */
export class LifeStore {
  private failed = false;
  constructor(private path: string, private legacyPath?: string) {}
  load(now = Date.now()): LifeSnapshot {
    try {
      if (existsSync(this.path)) {
        if (statSync(this.path).size > 1024 * 1024) throw new Error('oversized');
        const { mind, memories } = schema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
        return { mind, memories };
      }
      let memories: Memory[] = [];
      if (this.legacyPath && existsSync(this.legacyPath)) {
        if (statSync(this.legacyPath).size > 1024 * 1024) throw new Error('oversized legacy');
        memories = z.array(memorySchema).max(60).parse(JSON.parse(readFileSync(this.legacyPath, 'utf8')));
      }
      // No invented episodes or retrospective diary: legacy records keep their original source.
      const initial = { mind: createMind(now), memories };
      this.save(initial);
      return initial;
    } catch {
      this.failed = true;
      throw new Error('Life memory could not be loaded or saved. Existing files were preserved; repair their permissions or JSON before restarting.');
    }
  }
  save(snapshot: LifeSnapshot) {
    if (this.failed) throw new Error('Refusing to overwrite a life file that failed to load.');
    const data = schema.parse({ version: 1, ...snapshot });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../server/memory';

const paths: string[] = [];
function temporaryPath() {
  const directory = join('data', `test-memory-${randomUUID()}`);
  mkdirSync(directory, { recursive: true }); paths.push(directory);
  return join(directory, 'memories.json');
}
afterEach(() => { paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); vi.restoreAllMocks(); });

describe('persistent experience', () => {
  it('round-trips validated memories across independent store instances', () => {
    const path = temporaryPath();
    const memories = [{ id: 'test', text: '完成过喝水。', source: 'experience' as const, at: Date.now() }];
    new MemoryStore(path).save(memories);
    expect(new MemoryStore(path).load()).toEqual(memories);
  });
  it('preserves an unreadable memory file instead of replacing it with an empty history', () => {
    const path = temporaryPath(); writeFileSync(path, '{broken');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new MemoryStore(path);
    expect(store.load()).toEqual([]);
    expect(() => store.save([])).toThrow('Refusing to overwrite');
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
});

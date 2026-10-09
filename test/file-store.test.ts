import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { FileStore } from '../src/file-store.js';
import { Repository } from '../src/repository.js';
import { emptyDocument } from '../src/model.js';
describe('filesystem durability', () => {
  it('writes atomically with private permissions, restores after reopening, and excludes a second writer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ha-events-test-'));
    const first = await FileStore.open(directory, 0);
    try {
      const repository = new Repository(first);
      await repository.transact(document => { document.seen.push('event-1'); });
      await expect(FileStore.open(directory, 0)).rejects.toThrow();
      const path = join(directory, 'plugins/openclaw-home-assistant-events/state.json');
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
      await first.close();
      const second = await FileStore.open(directory, 0);
      try { expect((await new Repository(second).read()).seen).toEqual(['event-1']); } finally { await second.close(); }
    } finally { await first.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('refuses corrupted state instead of silently resetting subscriptions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ha-events-test-')); const store = await FileStore.open(directory, 0);
    try {
      await store.register('document', emptyDocument());
      await writeFile(join(directory, 'plugins/openclaw-home-assistant-events/state.json'), '{broken');
      await expect(new Repository(store).read()).rejects.toThrow();
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

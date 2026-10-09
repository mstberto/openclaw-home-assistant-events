import { mkdir, open, readFile, rename, rm, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import type { StateDocument } from './model.js';
import type { DocumentStore } from './repository.js';

const MAX_BYTES = 16 * 1024 * 1024;
/** Public filesystem APIs: no private OpenClaw database access or trust bypass. */
export class FileStore implements DocumentStore {
  private compromised = false;
  private closed = false;
  private constructor(private readonly path: string, private readonly directory: string,
    private readonly release: () => Promise<void>) {}
  static async open(stateDirectory: string, retryCount = 12): Promise<FileStore> {
    const directory = join(stateDirectory, 'plugins', 'openclaw-home-assistant-events');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Plugin state directory must not be a symlink');
    await chmod(directory, 0o700);
    let store: FileStore | undefined;
    const release = await lockfile.lock(directory, {
      realpath: false, stale: 10000, update: 2000,
      retries: { retries: retryCount, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
      onCompromised: () => { if (store) store.compromised = true; },
    });
    store = new FileStore(join(directory, 'state.json'), directory, release);
    return store;
  }
  private assertOpen(): void {
    if (this.closed || this.compromised) throw new Error('Plugin state writer ownership unavailable');
  }
  async lookup(_key: string): Promise<unknown> {
    this.assertOpen();
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('Invalid plugin state file');
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      this.assertOpen();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async register(_key: string, document: StateDocument): Promise<void> {
    this.assertOpen();
    const value = JSON.stringify(document);
    if (Buffer.byteLength(value) > MAX_BYTES) throw new Error('Plugin state byte limit reached');
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(value, 'utf8'); await handle.sync(); await handle.close();
      this.assertOpen();
      await rename(temporary, this.path);
      // Durable directory entry on supported filesystems; an uncertain sync failure propagates.
      const directoryHandle = await open(this.directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.release();
  }
}

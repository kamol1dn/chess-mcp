import { Worker } from 'node:worker_threads';
import type { SearchLimits } from '../engine/search.js';
import { type EngineJob, runJob } from '../engine/worker.js';

export type EngineResult = ReturnType<typeof runJob>;

interface Pending {
  job: EngineJob;
  resolve: (r: EngineResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: Pending | null;
}

/**
 * Runs engine searches on worker threads so long searches never block the
 * HTTP server. With `size = 0` searches run inline (used by tests).
 */
export class EnginePool {
  private slots: Slot[] = [];
  private queue: Pending[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly size: number,
    private readonly onError: (err: Error) => void = () => {},
  ) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const isTs = import.meta.url.endsWith('.ts');
    const url = new URL(isTs ? '../engine/worker.ts' : '../engine/worker.js', import.meta.url);
    const worker = new Worker(url, isTs ? { execArgv: ['--import', 'tsx'] } : {});
    const slot: Slot = { worker, busy: null };
    worker.on('message', (msg: { id: number; ok: boolean; result?: EngineResult; error?: string }) => {
      const p = slot.busy;
      slot.busy = null;
      if (p && p.job.id === msg.id) {
        if (msg.ok) p.resolve(msg.result!);
        else p.reject(new Error(msg.error));
      }
      this.pump();
    });
    worker.on('error', (err) => this.onError(err as Error));
    worker.on('exit', () => {
      const p = slot.busy;
      slot.busy = null;
      if (p) p.reject(new Error('Engine worker exited unexpectedly'));
      if (!this.closed) {
        const i = this.slots.indexOf(slot);
        if (i >= 0) this.slots[i] = this.spawn();
        this.pump();
      }
    });
    worker.unref();
    return slot;
  }

  search(startFen: string, moves: string[], limits: SearchLimits): Promise<EngineResult> {
    if (this.closed) return Promise.reject(new Error('Engine pool is closed'));
    if (this.size === 0) {
      return new Promise((resolve, reject) =>
        setImmediate(() => {
          try {
            resolve(runJob({ startFen, moves, limits }));
          } catch (e) {
            reject(e as Error);
          }
        }),
      );
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ job: { id: this.nextId++, startFen, moves, limits }, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (!this.queue.length) return;
      if (slot.busy) continue;
      const p = this.queue.shift()!;
      slot.busy = p;
      slot.worker.postMessage(p.job);
    }
  }

  get pending(): number {
    return this.queue.length + this.slots.filter((s) => s.busy).length;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue) p.reject(new Error('Engine pool closed'));
    this.queue = [];
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}

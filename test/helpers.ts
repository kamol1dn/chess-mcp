import { EnginePool } from '../src/server/engine-pool.js';
import { GameManager, type MovePlayer } from '../src/server/game-manager.js';
import { GameStore } from '../src/server/store.js';

export const silentLog = { info() {}, warn() {}, error() {} };

export function makeManager(opts: { claude?: MovePlayer | null; store?: GameStore; moveDelayMs?: number; analysisMs?: number } = {}) {
  const store = opts.store ?? new GameStore(':memory:');
  const engine = new EnginePool(0);
  const games = new GameManager({
    store,
    engine,
    claude: opts.claude ?? null,
    moveDelayMs: opts.moveDelayMs ?? 0,
    maxActiveGames: 50,
    idleGameTimeoutMs: 0,
    llmMaxAttempts: 3,
    log: silentLog,
    analysisMs: opts.analysisMs ?? 0,
    llmRetryDelaysMs: [5, 5],
  });
  games.start();
  return { games, store, engine };
}

/** Polls `fn` until it returns a truthy value. */
export async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

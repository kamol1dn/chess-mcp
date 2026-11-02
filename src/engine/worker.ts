import { parentPort } from 'node:worker_threads';
import { ChessGame } from './game.js';
import { type SearchLimits, Searcher } from './search.js';

export interface EngineJob {
  id: number;
  startFen: string;
  moves: string[];
  limits: SearchLimits;
}

const searcher = new Searcher();

export function runJob(job: Omit<EngineJob, 'id'>) {
  // Replaying the moves keeps the history on the position so the search can see repetitions.
  const game = ChessGame.fromMoves(job.startFen, job.moves);
  const { bestMove: _bestMove, ...result } = searcher.search(game.pos, job.limits);
  return result;
}

parentPort?.on('message', (job: EngineJob) => {
  try {
    parentPort!.postMessage({ id: job.id, ok: true, result: runJob(job) });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

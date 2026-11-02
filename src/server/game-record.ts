import type { Evaluation, PlayerSpec, Result, Side, Termination } from '../shared/types.js';

/** Persisted state of one game. The position is rebuilt by replaying `moves`. */
export interface GameRecord {
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  startFen: string;
  moves: MoveRecord[];
  white: SeatRecord;
  black: SeatRecord;
  status: 'active' | 'finished';
  result: Result;
  termination: Termination | null;
  /** Side that resigned / flagged / forfeited, when relevant. */
  loser: Side | null;
  clock: { initialMs: number; incrementMs: number; white: number; black: number } | null;
  /** When the side to move started thinking. */
  turnStartedAt: number;
  drawOffer: Side | null;
  startEval?: Evaluation | null;
}

export interface MoveRecord {
  san: string;
  uci: string;
  color: Side;
  fen: string;
  at: number;
  thinkMs: number;
  comment?: string;
  eval?: Evaluation;
}

export interface SeatRecord {
  spec: PlayerSpec;
  name: string;
  /** sha256 of the seat token (human/agent seats once claimed). */
  tokenHash: string | null;
  lastSeenAt: number | null;
  error: string | null;
}

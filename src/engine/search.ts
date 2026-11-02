import { PIECE_VALUE, evaluate, hasNonPawnMaterial } from './eval.js';
import { moveToSan, moveToUci } from './notation.js';
import {
  FLAG_CAPTURE,
  FLAG_PROMO,
  type Position,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  pieceType,
} from './position.js';

export const MATE = 30000;
const INF = 32000;
const MAX_PLY = 128;

const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;
const TT_EXACT = 1;
const TT_LOWER = 2;
const TT_UPPER = 3;

export interface SearchLimits {
  /** Maximum iterative-deepening depth. */
  depth?: number;
  /** Soft time budget in milliseconds. */
  timeMs?: number;
  /** Node budget. */
  nodes?: number;
  /**
   * When > 0, the engine picks randomly among root moves whose score is within
   * this many centipawns of the best one (used for weaker levels).
   */
  randomness?: number;
  /** Source of randomness (defaults to Math.random); injectable for tests. */
  random?: () => number;
}

export interface SearchResult {
  bestMove: number;
  uci: string;
  san: string;
  /** Score in centipawns from the side to move's point of view. */
  score: number;
  /** Moves until mate (positive: side to move mates), if a mate was found. */
  mateIn: number | null;
  depth: number;
  nodes: number;
  timeMs: number;
  pv: string[];
}

class SearchAbort extends Error {}

/** Engine strength presets, 1 (beginner) to 10 (strongest). */
export function levelLimits(level: number): SearchLimits {
  const presets: SearchLimits[] = [
    { depth: 1, randomness: 400, timeMs: 200 },
    { depth: 1, randomness: 200, timeMs: 200 },
    { depth: 2, randomness: 120, timeMs: 300 },
    { depth: 2, randomness: 60, timeMs: 400 },
    { depth: 3, randomness: 30, timeMs: 600 },
    { depth: 4, randomness: 12, timeMs: 1000 },
    { depth: 6, timeMs: 1500 },
    { depth: 8, timeMs: 3000 },
    { depth: 64, timeMs: 5000 },
    { depth: 64, timeMs: 10000 },
  ];
  const i = Math.min(10, Math.max(1, Math.round(level))) - 1;
  return { ...presets[i] };
}

export class Searcher {
  // Transposition table (parallel typed arrays to avoid per-entry objects).
  private ttKey = new Int32Array(TT_SIZE);
  private ttMove = new Int32Array(TT_SIZE);
  private ttScore = new Int32Array(TT_SIZE);
  private ttDepth = new Int8Array(TT_SIZE);
  private ttFlag = new Int8Array(TT_SIZE);

  private killers = new Int32Array(MAX_PLY * 2);
  private history = new Int32Array(16 * 128);

  private nodes = 0;
  /** Best root move found in the current iteration (0 until one completes). */
  private rootBest = 0;
  private deadline = Infinity;
  private nodeLimit = Infinity;
  private pos!: Position;

  clear(): void {
    this.ttKey.fill(0);
    this.ttMove.fill(0);
    this.ttDepth.fill(0);
    this.ttFlag.fill(0);
  }

  search(pos: Position, limits: SearchLimits = {}): SearchResult {
    const start = performance.now();
    this.pos = pos;
    this.nodes = 0;
    this.deadline = limits.timeMs ? start + limits.timeMs : Infinity;
    this.nodeLimit = limits.nodes ?? Infinity;
    this.killers.fill(0);
    this.history.fill(0);
    const maxDepth = Math.min(limits.depth ?? 64, MAX_PLY - 1);

    const legal = pos.legalMoves();
    if (legal.length === 0) throw new Error('No legal moves in this position');

    let bestMove = legal[0];
    let bestScore = -INF;
    let completedDepth = 0;
    let rootScores: Map<number, number> | null = null;

    if (legal.length === 1 && !limits.randomness) {
      // Only one move: no need to think.
      bestScore = evaluate(pos);
      completedDepth = 1;
    } else {
      for (let depth = 1; depth <= maxDepth; depth++) {
        try {
          if (limits.randomness) {
            rootScores = this.scoreRootMoves(legal, depth);
            let best = -INF;
            for (const [m, s] of rootScores) if (s > best) [best, bestMove] = [s, m];
            bestScore = best;
          } else {
            this.rootBest = 0;
            bestScore = this.negamax(depth, -INF, INF, 0, true);
            if (this.rootBest) bestMove = this.rootBest;
          }
          completedDepth = depth;
        } catch (e) {
          if (!(e instanceof SearchAbort)) throw e;
          // Moves are searched best-first, so a root move completed in the aborted
          // iteration is at least as good as the previous iteration's choice.
          if (!limits.randomness && this.rootBest) bestMove = this.rootBest;
          break;
        }
        if (Math.abs(bestScore) >= MATE - MAX_PLY) break; // forced mate found
        // Do not start an iteration we are unlikely to finish.
        if (performance.now() - start > (this.deadline - start) * 0.5) break;
      }
    }

    if (limits.randomness && rootScores && rootScores.size > 0) {
      const rnd = limits.random ?? Math.random;
      const candidates = [...rootScores].filter(([, s]) => s >= bestScore - limits.randomness!);
      // Weight candidates so better moves are still preferred.
      const weights = candidates.map(([, s]) => 1 + (s - (bestScore - limits.randomness!)));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = rnd() * total;
      for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          [bestMove, bestScore] = candidates[i];
          break;
        }
      }
    }

    const pv = this.extractPv(bestMove, completedDepth);
    const mateIn =
      Math.abs(bestScore) >= MATE - MAX_PLY
        ? Math.sign(bestScore) * Math.ceil((MATE - Math.abs(bestScore)) / 2)
        : null;
    return {
      bestMove,
      uci: moveToUci(bestMove),
      san: moveToSan(pos, bestMove, legal),
      score: bestScore,
      mateIn,
      depth: completedDepth,
      nodes: this.nodes,
      timeMs: Math.round(performance.now() - start),
      pv,
    };
  }

  /** Exact score for every root move (used when the engine plays with randomness). */
  private scoreRootMoves(legal: number[], depth: number): Map<number, number> {
    const scores = new Map<number, number>();
    for (const m of legal) {
      this.pos.makeMove(m);
      try {
        scores.set(m, -this.negamax(depth - 1, -INF, INF, 1, true));
      } finally {
        this.pos.unmakeMove();
      }
    }
    return scores;
  }

  private ttIndex(): number {
    return this.pos.hashLo & (TT_SIZE - 1);
  }

  private probeMove(): number {
    const i = this.ttIndex();
    return this.ttKey[i] === this.pos.hashHi ? this.ttMove[i] : 0;
  }

  private store(depth: number, score: number, flag: number, move: number, ply: number): void {
    const i = this.ttIndex();
    // Mate scores are stored relative to the node, not the root.
    if (score >= MATE - MAX_PLY) score += ply;
    else if (score <= -MATE + MAX_PLY) score -= ply;
    if (this.ttKey[i] !== this.pos.hashHi || depth >= this.ttDepth[i] || flag === TT_EXACT) {
      this.ttKey[i] = this.pos.hashHi;
      this.ttMove[i] = move;
      this.ttScore[i] = score;
      this.ttDepth[i] = depth;
      this.ttFlag[i] = flag;
    }
  }

  private checkLimits(): void {
    if ((this.nodes & 1023) === 0 && (performance.now() > this.deadline || this.nodes > this.nodeLimit)) {
      throw new SearchAbort();
    }
  }

  private negamax(depth: number, alpha: number, beta: number, ply: number, allowNull: boolean): number {
    const pos = this.pos;
    this.nodes++;
    this.checkLimits();

    if (ply > 0 && (pos.halfmove >= 100 || pos.isRepetition())) return 0;
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    const inCheck = pos.inCheck();
    if (inCheck) depth++;
    if (depth <= 0) return this.quiesce(alpha, beta, ply);

    // Transposition table probe
    const ti = this.ttIndex();
    let ttMove = 0;
    if (this.ttKey[ti] === pos.hashHi) {
      ttMove = this.ttMove[ti];
      if (ply > 0 && this.ttDepth[ti] >= depth) {
        let s = this.ttScore[ti];
        if (s >= MATE - MAX_PLY) s -= ply;
        else if (s <= -MATE + MAX_PLY) s += ply;
        const f = this.ttFlag[ti];
        if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
      }
    }

    const isPv = beta - alpha > 1;

    // Null-move pruning
    if (allowNull && !inCheck && !isPv && depth >= 3 && hasNonPawnMaterial(pos, pos.turn) && evaluate(pos) >= beta) {
      pos.makeNull();
      let score: number;
      try {
        score = -this.negamax(depth - 3, -beta, -beta + 1, ply + 1, false);
      } finally {
        pos.unmakeNull();
      }
      if (score >= beta) return beta;
    }

    const moves = pos.generatePseudo([]);
    const scores = this.scoreMoves(moves, ttMove, ply);

    const alphaOrig = alpha;
    let bestScore = -INF;
    let bestMove = 0;
    let legalCount = 0;

    for (let i = 0; i < moves.length; i++) {
      // Selection sort: pick the best-scored remaining move.
      let bi = i;
      for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[bi]) bi = j;
      if (bi !== i) {
        [moves[i], moves[bi]] = [moves[bi], moves[i]];
        [scores[i], scores[bi]] = [scores[bi], scores[i]];
      }
      const m = moves[i];
      if (!pos.makeLegal(m)) continue;
      legalCount++;
      const quiet = !(moveFlags(m) & (FLAG_CAPTURE | FLAG_PROMO));

      let score: number;
      try {
        if (legalCount === 1) {
          score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
        } else {
          // Late move reductions for quiet moves searched late in the list.
          let reduction = 0;
          if (depth >= 3 && legalCount > 4 && quiet && !inCheck && !pos.inCheck()) reduction = legalCount > 10 ? 2 : 1;
          score = -this.negamax(depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, true);
          if (score > alpha && (reduction > 0 || score < beta)) {
            score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
          }
        }
      } finally {
        pos.unmakeMove();
      }

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (ply === 0) this.rootBest = m;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (quiet) {
          if (this.killers[ply * 2] !== m) {
            this.killers[ply * 2 + 1] = this.killers[ply * 2];
            this.killers[ply * 2] = m;
          }
          this.history[pos.board[moveFrom(m)] * 128 + moveTo(m)] += depth * depth;
        }
        break;
      }
    }

    if (legalCount === 0) return inCheck ? -MATE + ply : 0;

    const flag = bestScore <= alphaOrig ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;
    this.store(depth, bestScore, flag, bestMove, ply);
    return bestScore;
  }

  private quiesce(alpha: number, beta: number, ply: number): number {
    const pos = this.pos;
    this.nodes++;
    this.checkLimits();

    const standPat = evaluate(pos);
    if (ply >= MAX_PLY - 1) return standPat;
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;

    const moves = pos.generatePseudo([], true);
    const scores = this.scoreMoves(moves, 0, ply);
    let best = standPat;
    for (let i = 0; i < moves.length; i++) {
      let bi = i;
      for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[bi]) bi = j;
      if (bi !== i) {
        [moves[i], moves[bi]] = [moves[bi], moves[i]];
        [scores[i], scores[bi]] = [scores[bi], scores[i]];
      }
      const m = moves[i];
      // Delta pruning: skip captures that cannot raise alpha even if they win the piece outright.
      const victim = pieceType(pos.board[moveTo(m)]);
      if (!(moveFlags(m) & FLAG_PROMO) && standPat + PIECE_VALUE[victim || 1] + 200 < alpha) continue;
      if (!pos.makeLegal(m)) continue;
      let score: number;
      try {
        score = -this.quiesce(-beta, -alpha, ply + 1);
      } finally {
        pos.unmakeMove();
      }
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  private scoreMoves(moves: number[], ttMove: number, ply: number): Int32Array {
    const b = this.pos.board;
    const scores = new Int32Array(moves.length);
    const k1 = this.killers[ply * 2];
    const k2 = this.killers[ply * 2 + 1];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const flags = moveFlags(m);
      if (m === ttMove) scores[i] = 10_000_000;
      else if (flags & FLAG_CAPTURE) {
        // MVV-LVA (en-passant victims are pawns)
        const victim = pieceType(b[moveTo(m)]) || 1;
        const attacker = pieceType(b[moveFrom(m)]);
        scores[i] = 1_000_000 + PIECE_VALUE[victim] * 10 - PIECE_VALUE[attacker] / 10;
      } else if (flags & FLAG_PROMO) scores[i] = 900_000 + movePromo(m);
      else if (m === k1) scores[i] = 800_000;
      else if (m === k2) scores[i] = 700_000;
      else scores[i] = Math.min(600_000, this.history[b[moveFrom(m)] * 128 + moveTo(m)]);
    }
    return scores;
  }

  /** Follows the transposition table from the root to build a principal variation. */
  private extractPv(first: number, maxLen: number): string[] {
    const pos = this.pos;
    const pv: string[] = [];
    let made = 0;
    let m = first;
    const seen = new Set<string>();
    try {
      while (m && pv.length < Math.max(1, maxLen)) {
        const legal = pos.legalMoves();
        if (!legal.includes(m)) break;
        pv.push(moveToSan(pos, m, legal));
        pos.makeMove(m);
        made++;
        const key = pos.key();
        if (seen.has(key)) break;
        seen.add(key);
        m = this.probeMove();
      }
    } finally {
      while (made-- > 0) pos.unmakeMove();
    }
    return pv;
  }
}

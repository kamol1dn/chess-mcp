import { describe, expect, it } from 'vitest';
import { ChessGame } from '../src/engine/game.js';
import { Position } from '../src/engine/position.js';
import { MATE, Searcher, levelLimits } from '../src/engine/search.js';

describe('search', () => {
  it('finds mate in one', () => {
    const pos = Position.fromFen('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
    const r = new Searcher().search(pos, { depth: 3 });
    expect(r.san).toBe('Rd8#');
    expect(r.mateIn).toBe(1);
    expect(r.score).toBeGreaterThan(MATE - 10);
  });

  it('finds mate in two', () => {
    // Classic smothered-style / back-rank combination
    const pos = Position.fromFen('r5k1/5ppp/8/8/8/8/1Q3PPP/1R4K1 w - - 0 1');
    const r = new Searcher().search(pos, { depth: 5 });
    expect(r.mateIn).toBe(2);
  });

  it('wins hanging material', () => {
    const rook = Position.fromFen('4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1');
    expect(new Searcher().search(rook, { depth: 3 }).san).toBe('Rxd5');
    const bishop = Position.fromFen('rnb1kbnr/pppp1ppp/8/4p1q1/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1');
    expect(new Searcher().search(bishop, { depth: 3 }).san).toBe('Bxg5');
  });

  it('avoids stalemating when winning', () => {
    const pos = Position.fromFen('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1');
    const r = new Searcher().search(pos, { depth: 6, timeMs: 3000 });
    const g = new ChessGame(pos.toFen());
    g.move(r.uci);
    expect(g.outcome()).not.toBe('stalemate');
  });

  it('respects the time limit and leaves the position untouched', () => {
    const pos = Position.start();
    const fen = pos.toFen();
    const t = performance.now();
    const r = new Searcher().search(pos, { timeMs: 300 });
    expect(performance.now() - t).toBeLessThan(1500);
    expect(r.depth).toBeGreaterThan(1);
    expect(pos.toFen()).toBe(fen);
    expect(pos.legalMoves().map(String)).toContain(String(r.bestMove));
  });

  it('plays legal moves at every level', () => {
    for (let level = 1; level <= 6; level++) {
      const pos = Position.fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
      const r = new Searcher().search(pos, levelLimits(level));
      expect(pos.legalMoves()).toContain(r.bestMove);
    }
  });

  it('finds Qxf7# at a decent level', () => {
    const pos = Position.fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
    expect(new Searcher().search(pos, levelLimits(7)).san).toBe('Qxf7#');
  });
});

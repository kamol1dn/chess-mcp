import { describe, expect, it } from 'vitest';
import { ChessGame, IllegalMoveError } from '../src/engine/game.js';
import { moveToSan, parseMove } from '../src/engine/notation.js';
import { Position } from '../src/engine/position.js';

describe('SAN generation', () => {
  it('produces standard SAN for an opening', () => {
    const g = new ChessGame();
    for (const m of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5c6', 'd7c6', 'e1g1']) g.move(m);
    expect(g.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'O-O']);
    expect(g.movetext()).toBe('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O');
  });

  it('disambiguates by file, rank and square', () => {
    // Knights on b1 and f1 can both reach d2; rooks on a1 and a5 both reach a3.
    const pos = Position.fromFen('7k/8/8/R7/8/8/8/RN3N1K w - - 0 1');
    const sans = pos.legalMoves().map((m) => moveToSan(pos, m));
    expect(sans).toContain('Nbd2');
    expect(sans).toContain('Nfd2');
    expect(sans).toContain('R1a3');
    expect(sans).toContain('R5a3');
    // Three queens attacking the same square need the full square.
    const q = Position.fromFen('7k/8/8/8/Q1Q5/8/Q7/7K w - - 0 1');
    const qs = q.legalMoves().map((m) => moveToSan(q, m));
    expect(qs).toContain('Qa4b3');
  });

  it('marks check and mate', () => {
    const g = new ChessGame();
    for (const m of ['f3', 'e5', 'g4', 'Qh4']) g.move(m);
    expect(g.lastMove()?.san).toBe('Qh4#');
    expect(g.outcome()).toBe('checkmate');
    expect(g.resultFor('checkmate')).toBe('0-1');
  });

  it('handles promotion and en passant', () => {
    const g = new ChessGame('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    g.move('b8=N');
    expect(g.lastMove()?.san).toBe('b8=N');
    const ep = new ChessGame('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    ep.move('exd6');
    expect(ep.lastMove()?.uci).toBe('e5d6');
    expect(ep.fen().startsWith('4k3/8/3P4/8/8/8/8/4K3 b')).toBe(true);
  });
});

describe('move parsing', () => {
  const pos = Position.fromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const cases: Array<[string, string]> = [
    ['O-O', 'e1g1'],
    ['0-0-0', 'e1c1'],
    ['e1g1', 'e1g1'],
    ['Nxf7', 'e5f7'],
    ['Nf7', 'e5f7'],
    ['nxf7', 'e5f7'],
    ['Ne5xf7+', 'e5f7'],
    ['dxe6', 'd5e6'],
    ['de6', 'd5e6'],
    ['Qxf6!?', 'f3f6'],
    ['g2-g3', 'g2g3'],
    ['12. a3', 'a2a3'],
    ['Bxa6', 'e2a6'],
    ['bxa6', 'e2a6'],
  ];
  for (const [input, uci] of cases) {
    it(`parses '${input}'`, () => {
      expect(parseMove(pos, input)?.uci).toBe(uci);
    });
  }

  it('rejects illegal and ambiguous input', () => {
    expect(parseMove(pos, 'Ke3')).toBeNull();
    expect(parseMove(pos, 'Nd5')).toBeNull(); // both knights? no: c3 knight only... ensure garbage fails
    expect(parseMove(pos, 'hello')).toBeNull();
    expect(parseMove(pos, '')).toBeNull();
  });

  it('defaults bare UCI promotions to a queen', () => {
    const p = Position.fromFen('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    expect(parseMove(p, 'b7b8')?.san).toBe('b8=Q+');
  });
});

describe('game rules', () => {
  it('detects stalemate', () => {
    const g = new ChessGame('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(g.outcome()).toBe('stalemate');
  });

  it('detects threefold repetition', () => {
    const g = new ChessGame();
    for (const m of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) g.move(m);
    expect(g.outcome()).toBe('threefold');
  });

  it('detects the fifty-move rule', () => {
    const g = new ChessGame('7k/8/8/8/8/8/R7/K7 w - - 99 80');
    expect(g.outcome()).toBeNull();
    g.move('Rb2');
    expect(g.outcome()).toBe('fifty-move');
  });

  it('detects insufficient material', () => {
    expect(new ChessGame('8/8/4k3/8/8/2KB4/8/8 w - - 0 1').outcome()).toBe('insufficient-material');
    expect(new ChessGame('8/8/4k3/8/3b4/2KB4/8/8 w - - 0 1').outcome()).toBeNull(); // opposite-colored bishops can mate
    expect(new ChessGame('8/8/4k3/8/4b3/2KB4/8/8 w - - 0 1').outcome()).toBe('insufficient-material');
  });

  it('throws IllegalMoveError listing legal moves', () => {
    const g = new ChessGame();
    try {
      g.move('e5');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalMoveError);
      expect((e as IllegalMoveError).legal).toContain('e4');
      expect((e as IllegalMoveError).legal).toHaveLength(20);
    }
  });

  it('keeps the incremental hash consistent with a freshly parsed FEN', () => {
    const g = new ChessGame();
    const line = ['e4', 'd5', 'exd5', 'c5', 'dxc6', 'Nf6', 'cxb7', 'Bd7', 'bxa8=Q', 'Qc7', 'Qxb8+', 'Qc8', 'Qxc8+', 'Bxc8', 'Nf3', 'e5', 'Bc4', 'Bd6', 'O-O'];
    for (const m of line) {
      g.move(m);
      expect(g.pos.key()).toBe(Position.fromFen(g.fen()).key());
    }
  });

  it('writes PGN with a FEN header for custom starts', () => {
    const g = new ChessGame('4k3/8/8/8/8/8/4P3/4K3 b - - 0 30');
    g.move('Kd7');
    g.move('e4');
    const pgn = g.pgn({ White: 'A', Black: 'B' }, '*');
    expect(pgn).toContain('[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 30"]');
    expect(pgn).toContain('30... Kd7 31. e4 *');
  });

  it('rejects invalid FENs', () => {
    expect(() => new ChessGame('8/8/8/8/8/8/8/8 w - - 0 1')).toThrow(/king/);
    expect(() => new ChessGame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1')).toThrow();
    expect(() => new ChessGame('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1 extra')).not.toThrow();
    expect(() => new ChessGame('4k2R/8/8/8/8/8/8/4K3 w - - 0 1')).toThrow(/not to move is in check/);
  });
});

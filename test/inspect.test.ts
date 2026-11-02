import { describe, expect, it } from 'vitest';
import { formatSafety, safetyReport } from '../src/engine/inspect.js';
import { BLACK, Position, WHITE } from '../src/engine/position.js';
import { makeManager } from './helpers.js';

// The Claude-vs-Claude game in which White blundered with 23. Na5?? and 46. Rh8+??.
const GAME =
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2 cxd4 cxd4 Nc6 Nb3 a5 Be3 a4 Nbd2 Bd7 Rc1 Qb7 d5 Nb4 Bb1 a3 bxa3 Rxa3 Nb3 Nxa2 Bxa2 Rxa2 ' +
  'Na5 Rxa5 Qd2 Ra4 Qd3 b4 Nd2 Bb5 Nc4 Bxc4 Rxc4 b3 Rxa4 b2 Rb1 Ra8 Rxa8+ Qxa8 Qc2 Qa1 Qxb2 Qxb2 Rxb2 Kf8 f3 Nd7 Rb7 Ke8 Kf2 Kd8 Ke2 Kc8 Ra7 g6 Ra8+ Kc7 Rh8 Nf6 Bg5 Kd7 Bxf6 Bxf6 Rxh7 Ke7 g3 Kf8';
const MOVES = GAME.split(' ');

function replay(plies: number) {
  const { games } = makeManager();
  const { game, tokens } = games.create({ white: { kind: 'agent' }, black: { kind: 'agent' }, claim: ['white', 'black'] });
  MOVES.slice(0, plies).forEach((m, i) => games.move(game.id, tokens[i % 2 === 0 ? 'white' : 'black']!, m));
  return { games, id: game.id };
}

describe('safety report', () => {
  it('flags hanging pieces and attacks by cheaper pieces', () => {
    // The white knight on e5 is attacked by the d6 pawn and has no defender; nothing of Black's is attacked.
    const pos = Position.fromFen('4k3/8/3p4/4N3/7q/8/8/4K3 w - - 0 1');
    const white = safetyReport(pos, WHITE);
    expect(white.threatened).toEqual([
      expect.objectContaining({ piece: 'Ne5', attackers: ['d6'], hanging: true, attackedByLesser: true }),
    ]);
    expect(safetyReport(pos, BLACK).threatened).toEqual([]);
  });

  it('finds pins to the king and to more valuable pieces', () => {
    const pos = Position.fromFen('4k3/4r3/8/8/1b6/8/3N4/4K2R w - - 0 1');
    const pins = safetyReport(pos, WHITE).pins;
    expect(pins).toEqual([{ pinned: 'Nd2', by: 'Bb4', to: 'Ke1' }]);
    expect(formatSafety(pos, WHITE)).toContain('Nd2 (pinned by Bb4 to Ke1)');
  });

  it('is included in the briefing on your turn', () => {
    const { games, id } = replay(44); // after 22...Rxa2, White to move
    const info = games.turnInfo(id, 'white');
    expect(info.text).toContain('Safety check');
    expect(info.text).toContain('Your pieces in danger');
  });
});

describe('line preview', () => {
  it('would have caught 23. Na5??', () => {
    const { games, id } = replay(44);
    const { info } = games.preview(id, 'white', ['Na5']);
    expect(info.ok).toBe(true);
    expect(info.text).toMatch(/Na5 attacked by Ra\d[^;\n]*HANGING/);
    expect(info.text).toContain("Opponent's captures and checks available now:");
    expect(info.text).toContain('Rxa5');
    // The game itself is untouched.
    expect(games.get(id).moves).toHaveLength(44);
  });

  it('would have caught 46. Rh8+??', () => {
    const { games, id } = replay(90); // after 45...Kf8, White to move
    const { info, png } = games.preview(id, 'white', ['Rh8+']);
    expect(info.line).toEqual(['Rh8+']);
    expect(info.text).toMatch(/Rh8 attacked by Bf6[^;\n]*HANGING/);
    expect(info.text).toContain('Bxh8');
    expect(png(256).subarray(1, 4).toString()).toBe('PNG');
  });

  it('plays multi-move lines and reports illegal moves', () => {
    const { games, id } = replay(0);
    const ok = games.preview(id, 'black', ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']).info;
    expect(ok.outcome).toBe('checkmate');
    expect(ok.text).toContain('Line: 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#');
    expect(ok.text).toContain('White wins');
    const bad = games.preview(id, 'white', ['e4', 'e4']).info;
    expect(bad.ok).toBe(false);
    expect(bad.line).toEqual(['e4']);
    expect(bad.error).toContain('"e4", is not legal for Black');
  });
});

import { asciiBoard, describePieces } from '../render/text.js';
import type { GameView, SeatView, Side } from '../shared/types.js';

export const otherSide = (s: Side): Side => (s === 'white' ? 'black' : 'white');
export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function describeSeat(seat: SeatView): string {
  switch (seat.kind) {
    case 'engine':
      return `${seat.name} (built-in engine, level ${seat.level}/10)`;
    case 'llm':
      return `${seat.name} (${seat.model})`;
    case 'agent':
      return `${seat.name} (AI agent)`;
    default:
      return `${seat.name} (human)`;
  }
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Remaining clock time for each side at `now`. */
export function liveClock(game: GameView, now = Date.now()): { white: number; black: number } | null {
  if (!game.clock) return null;
  const c = game.clock;
  const elapsed = c.running ? now - c.since : 0;
  return {
    white: c.white - (c.running === 'white' ? elapsed : 0),
    black: c.black - (c.running === 'black' ? elapsed : 0),
  };
}

export function movetext(game: GameView): string {
  if (!game.moves.length) return '(no moves yet)';
  const startFull = Number(game.startFen.split(' ')[5] ?? 1);
  const blackFirst = game.startFen.split(' ')[1] === 'b';
  const parts: string[] = [];
  game.moves.forEach((m, i) => {
    const plyFromStart = i + (blackFirst ? 1 : 0);
    const no = startFull + Math.floor(plyFromStart / 2);
    if (m.color === 'white') parts.push(`${no}.`);
    else if (i === 0) parts.push(`${no}...`);
    parts.push(m.san);
  });
  return parts.join(' ');
}

function moveNumberLabel(game: GameView, index: number): string {
  const startFull = Number(game.startFen.split(' ')[5] ?? 1);
  const blackFirst = game.startFen.split(' ')[1] === 'b';
  const no = startFull + Math.floor((index + (blackFirst ? 1 : 0)) / 2);
  return game.moves[index].color === 'white' ? `${no}.` : `${no}...`;
}

/**
 * The plain-text briefing given to AI players. It is self-contained: an agent
 * that only reads this text (or only looks at the board image) can play.
 */
export function buildBriefing(game: GameView, side: Side, legalSan: string[], safety?: string): string {
  const opp = game[otherSide(side)];
  const lines: string[] = [];
  const fullmove = game.fen.split(' ')[5];

  lines.push(`Chess game ${game.id}. You play ${capitalize(side)} against ${describeSeat(opp)}.`);

  if (game.status === 'finished') {
    lines.push(`The game is over: ${game.resultText ?? game.result} (${game.result}).`);
  } else if (game.turn === side) {
    lines.push(`It is YOUR move: move ${fullmove}, ${capitalize(side)} to play.${game.check ? ' You are in CHECK.' : ''}`);
  } else {
    lines.push(`Waiting for ${capitalize(otherSide(side))} (${opp.name}) to move.`);
  }

  const last = game.moves.at(-1);
  if (last) {
    const who = last.color === side ? 'You' : `${capitalize(last.color)}`;
    lines.push(`Last move: ${who} played ${moveNumberLabel(game, game.moves.length - 1)} ${last.san} (${last.uci}).`);
    if (last.color !== side && last.comment) lines.push(`Opponent's note: "${last.comment}"`);
  }

  if (game.drawOffer && game.drawOffer !== side && game.status === 'active') {
    lines.push(`${capitalize(game.drawOffer)} offers a draw. You may accept it, or decline simply by making a move.`);
  }

  const clock = liveClock(game);
  if (clock && game.clock) {
    lines.push(
      `Clock: White ${formatClock(clock.white)}, Black ${formatClock(clock.black)} (+${game.clock.incrementMs / 1000}s per move).` +
        (game.clock.running ? '' : ' Clocks start after both sides have made their first move.'),
    );
  }

  lines.push('', `FEN: ${game.fen}`, '');
  lines.push(`Board from ${capitalize(side)}'s side (UPPERCASE = White, lowercase = Black, "." = empty):`);
  lines.push(asciiBoard(game.fen, side));
  lines.push('', 'Pieces:', describePieces(game.fen), '');
  lines.push(`Moves so far: ${movetext(game)}`);

  if (safety) lines.push('', 'Safety check (facts about the current position, not advice):', safety);

  if (game.status === 'active' && game.turn === side) {
    lines.push('', `Legal moves (${legalSan.length}): ${legalSan.join(', ')}`);
    lines.push('Reply with exactly one legal move in SAN (e.g. Nf3, O-O, exd5, e8=Q) or UCI (e.g. g1f3, e7e8q).');
    lines.push('Before committing, check the square your piece lands on: who attacks it after the move, and what your move stops defending.');
  }
  return lines.join('\n');
}

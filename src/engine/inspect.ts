/**
 * Factual board inspection for AI players: who attacks what, which pieces are
 * hanging or pinned. No search and no evaluation — just what a careful human
 * sees when they scan the board before moving.
 */
import {
  BISHOP,
  type Color,
  KING,
  KNIGHT,
  PAWN,
  type Position,
  QUEEN,
  ROOK,
  WHITE,
  makePiece,
  pieceColor,
  pieceType,
  squareName,
} from './position.js';

const VALUE = [0, 1, 3, 3, 5, 9, 100];
const LETTER = ['', '', 'N', 'B', 'R', 'Q', 'K'];
const KNIGHT_DIRS = [33, 31, 18, 14, -33, -31, -18, -14];
const KING_DIRS = [17, 15, -17, -15, 16, -16, 1, -1];
const DIAGONALS = [17, 15, -17, -15];
const ORTHOGONALS = [16, -16, 1, -1];

/** "Nf3", "e4" (pawns), "Ke1". */
export const pieceLabel = (piece: number, sq: number): string => LETTER[pieceType(piece)] + squareName(sq);

/** Squares of all pieces of color `by` that attack `sq` (pinned pieces included). */
export function attackersOf(pos: Position, sq: number, by: Color): number[] {
  const b = pos.board;
  const out: number[] = [];
  const pawn = makePiece(PAWN, by);
  for (const d of by === WHITE ? [-15, -17] : [15, 17]) {
    const t = sq + d;
    if (!(t & 0x88) && b[t] === pawn) out.push(t);
  }
  const knight = makePiece(KNIGHT, by);
  for (const d of KNIGHT_DIRS) {
    const t = sq + d;
    if (!(t & 0x88) && b[t] === knight) out.push(t);
  }
  const king = makePiece(KING, by);
  for (const d of KING_DIRS) {
    const t = sq + d;
    if (!(t & 0x88) && b[t] === king) out.push(t);
  }
  for (const [dirs, slider] of [
    [DIAGONALS, BISHOP],
    [ORTHOGONALS, ROOK],
  ] as const) {
    for (const d of dirs) {
      let t = sq + d;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) {
          if (pieceColor(p) === by && (pieceType(p) === slider || pieceType(p) === QUEEN)) out.push(t);
          break;
        }
        t += d;
      }
    }
  }
  return out;
}

export interface ThreatenedPiece {
  piece: string;
  attackers: string[];
  defenders: string[];
  /** Attacked and not defended at all. */
  hanging: boolean;
  /** Attacked by a piece worth less than it (losing material even if defended). */
  attackedByLesser: boolean;
}

export interface Pin {
  pinned: string;
  by: string;
  /** What the pinned piece shields: the king (absolute pin) or a more valuable piece. */
  to: string;
}

export interface SafetyReport {
  threatened: ThreatenedPiece[];
  pins: Pin[];
}

/** Pieces of `color` that are under attack, and pieces of `color` that are pinned. */
export function safetyReport(pos: Position, color: Color): SafetyReport {
  const b = pos.board;
  const enemy = (color ^ 1) as Color;
  const threatened: ThreatenedPiece[] = [];
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const p = b[sq];
    if (!p || pieceColor(p) !== color || pieceType(p) === KING) continue;
    const attackers = attackersOf(pos, sq, enemy);
    if (!attackers.length) continue;
    const defenders = attackersOf(pos, sq, color);
    const minAttacker = Math.min(...attackers.map((a) => VALUE[pieceType(b[a])]));
    threatened.push({
      piece: pieceLabel(p, sq),
      attackers: attackers.map((a) => pieceLabel(b[a], a)),
      defenders: defenders.map((d) => pieceLabel(b[d], d)),
      hanging: defenders.length === 0,
      attackedByLesser: minAttacker < VALUE[pieceType(p)],
    });
  }

  // Pins: a slider of the enemy, then exactly one of our pieces, then our king or a more valuable piece.
  const pins: Pin[] = [];
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const p = b[sq];
    if (!p || pieceColor(p) !== enemy) continue;
    const t = pieceType(p);
    const dirs = t === BISHOP ? DIAGONALS : t === ROOK ? ORTHOGONALS : t === QUEEN ? [...DIAGONALS, ...ORTHOGONALS] : [];
    for (const d of dirs) {
      let s = sq + d;
      let first = -1;
      while (!(s & 0x88)) {
        const q = b[s];
        if (q) {
          if (pieceColor(q) !== color) break;
          if (first < 0) first = s;
          else {
            const behind = pieceType(q);
            if (behind === KING || VALUE[behind] > VALUE[pieceType(b[first])]) {
              pins.push({ pinned: pieceLabel(b[first], first), by: pieceLabel(p, sq), to: pieceLabel(q, s) });
            }
            break;
          }
        }
        s += d;
      }
    }
  }
  return { threatened, pins };
}

function describeThreat(t: ThreatenedPiece): string {
  const status = t.hanging ? 'HANGING (undefended)' : t.attackedByLesser ? 'attacked by a cheaper piece' : `defended by ${t.defenders.join(', ')}`;
  return `${t.piece} attacked by ${t.attackers.join(', ')} — ${status}`;
}

/**
 * Text block summarising the tactical facts of a position for `side`
 * ("you") and its opponent.
 */
export function formatSafety(pos: Position, side: Color): string {
  const mine = safetyReport(pos, side);
  const theirs = safetyReport(pos, (side ^ 1) as Color);
  const lines: string[] = [];
  const urgent = mine.threatened.filter((t) => t.hanging || t.attackedByLesser);
  const calm = mine.threatened.filter((t) => !t.hanging && !t.attackedByLesser);
  lines.push(
    urgent.length
      ? `Your pieces in danger: ${urgent.map(describeThreat).join('; ')}`
      : 'Your pieces in danger: none (no piece is hanging or attacked by a cheaper piece).',
  );
  if (calm.length) lines.push(`Your other attacked pieces: ${calm.map(describeThreat).join('; ')}`);
  if (mine.pins.length) lines.push(`Your pinned pieces: ${mine.pins.map((p) => `${p.pinned} (pinned by ${p.by} to ${p.to})`).join('; ')}`);
  const targets = theirs.threatened.filter((t) => t.hanging || t.attackedByLesser);
  if (targets.length) lines.push(`Opponent pieces hanging or attacked by a cheaper piece: ${targets.map(describeThreat).join('; ')}`);
  if (theirs.pins.length) lines.push(`Opponent's pinned pieces: ${theirs.pins.map((p) => `${p.pinned} (pinned by ${p.by} to ${p.to})`).join('; ')}`);
  return lines.join('\n');
}

import { BISHOP, KING, KNIGHT, PAWN, QUEEN, ROOK, type Position, WHITE, pieceColor, pieceType } from './position.js';

/**
 * Static evaluation in centipawns from the side to move's point of view.
 * Material + piece-square tables tapered between middlegame and endgame,
 * plus pawn structure, bishop pair, rook files and a mop-up term that helps
 * the engine convert won endgames.
 */

const MG_VALUE = [0, 82, 337, 365, 477, 1025, 0];
const EG_VALUE = [0, 94, 281, 297, 512, 936, 0];
const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
const TOTAL_PHASE = 24;

/** Plain material values used for move ordering and display. */
export const PIECE_VALUE = [0, 100, 320, 330, 500, 900, 20000];

// Tables are written from White's point of view with rank 8 first (as on a diagram).
// prettier-ignore
const PAWN_MG = [
   0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
   5,  5, 10, 25, 25, 10,  5,  5,
   0,  0,  0, 20, 20,  0,  0,  0,
   5, -5,-10,  0,  0,-10, -5,  5,
   5, 10, 10,-20,-20, 10, 10,  5,
   0,  0,  0,  0,  0,  0,  0,  0,
];
// prettier-ignore
const PAWN_EG = [
   0,  0,  0,  0,  0,  0,  0,  0,
  80, 80, 80, 80, 80, 80, 80, 80,
  50, 50, 50, 50, 50, 50, 50, 50,
  30, 30, 30, 30, 30, 30, 30, 30,
  15, 15, 15, 15, 15, 15, 15, 15,
   5,  5,  5,  5,  5,  5,  5,  5,
   0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,
];
// prettier-ignore
const KNIGHT_T = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];
// prettier-ignore
const BISHOP_T = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];
// prettier-ignore
const ROOK_T = [
   0,  0,  0,  0,  0,  0,  0,  0,
   5, 10, 10, 10, 10, 10, 10,  5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
   0,  0,  0,  5,  5,  0,  0,  0,
];
// prettier-ignore
const QUEEN_T = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5,  5,  5,  5,  0,-10,
   -5,  0,  5,  5,  5,  5,  0, -5,
    0,  0,  5,  5,  5,  5,  0, -5,
  -10,  5,  5,  5,  5,  5,  0,-10,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20,
];
// prettier-ignore
const KING_MG = [
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -10,-20,-20,-20,-20,-20,-20,-10,
   20, 20,  0,  0,  0,  0, 20, 20,
   20, 30, 10,  0,  0, 10, 30, 20,
];
// prettier-ignore
const KING_EG = [
  -50,-40,-30,-20,-20,-30,-40,-50,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -50,-30,-30,-30,-30,-30,-30,-50,
];

const MG_TABLES = [[], PAWN_MG, KNIGHT_T, BISHOP_T, ROOK_T, QUEEN_T, KING_MG];
const EG_TABLES = [[], PAWN_EG, KNIGHT_T, BISHOP_T, ROOK_T, QUEEN_T, KING_EG];

// Bonus for a passed pawn by relative rank (0 = own back rank).
const PASSED_MG = [0, 5, 10, 15, 25, 40, 60, 0];
const PASSED_EG = [0, 10, 20, 35, 60, 100, 150, 0];

const tableIndex = (sq: number, white: boolean): number => (white ? (7 - (sq >> 4)) * 8 + (sq & 7) : (sq >> 4) * 8 + (sq & 7));

export function evaluate(pos: Position): number {
  const b = pos.board;
  let mg = 0;
  let eg = 0;
  let phase = 0;
  const bishops = [0, 0];
  const material = [0, 0];
  const pawnFiles = [new Int8Array(8), new Int8Array(8)];
  // Most advanced / least advanced pawn rank per file per color, for passed-pawn detection.
  const pawnRanks: number[][] = [[], []];

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const p = b[sq];
    if (!p) continue;
    const t = pieceType(p);
    const c = pieceColor(p);
    const white = c === WHITE;
    const sign = white ? 1 : -1;
    const idx = tableIndex(sq, white);
    mg += sign * (MG_VALUE[t] + MG_TABLES[t][idx]);
    eg += sign * (EG_VALUE[t] + EG_TABLES[t][idx]);
    phase += PHASE_WEIGHT[t];
    if (t !== KING && t !== PAWN) material[c] += MG_VALUE[t];
    if (t === BISHOP) bishops[c]++;
    if (t === PAWN) {
      pawnFiles[c][sq & 7]++;
      pawnRanks[c].push(sq);
    }
  }

  // Pawn structure
  for (const c of [0, 1] as const) {
    const sign = c === WHITE ? 1 : -1;
    const files = pawnFiles[c];
    for (let f = 0; f < 8; f++) {
      if (files[f] > 1) {
        mg -= sign * 10 * (files[f] - 1);
        eg -= sign * 20 * (files[f] - 1);
      }
      if (files[f] && !(f > 0 && files[f - 1]) && !(f < 7 && files[f + 1])) {
        mg -= sign * 10 * files[f];
        eg -= sign * 15 * files[f];
      }
    }
    const enemy = pawnRanks[c ^ 1];
    for (const sq of pawnRanks[c]) {
      const f = sq & 7;
      const r = sq >> 4;
      let passed = true;
      for (const e of enemy) {
        const ef = e & 7;
        const er = e >> 4;
        if (Math.abs(ef - f) <= 1 && (c === WHITE ? er > r : er < r)) {
          passed = false;
          break;
        }
      }
      if (passed) {
        const rel = c === WHITE ? r : 7 - r;
        mg += sign * PASSED_MG[rel];
        eg += sign * PASSED_EG[rel];
      }
    }
  }

  // Rooks on open / half-open files
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const p = b[sq];
    if (pieceType(p) !== ROOK) continue;
    const c = pieceColor(p);
    const f = sq & 7;
    const sign = c === WHITE ? 1 : -1;
    if (!pawnFiles[c][f]) {
      const bonus = pawnFiles[c ^ 1][f] ? 10 : 20;
      mg += sign * bonus;
      eg += sign * (bonus >> 1);
    }
  }

  if (bishops[0] >= 2) {
    mg += 30;
    eg += 50;
  }
  if (bishops[1] >= 2) {
    mg -= 30;
    eg -= 50;
  }

  // Mop-up: with a decisive material edge and no enemy pawns, drive the enemy king to the edge.
  for (const c of [0, 1] as const) {
    const enemy = c ^ 1;
    if (pawnRanks[enemy].length === 0 && material[c] - material[enemy] >= 400) {
      const ek = pos.kings[enemy];
      const ok = pos.kings[c];
      const ef = ek & 7;
      const er = ek >> 4;
      const centerDist = Math.max(3 - ef, ef - 4) + Math.max(3 - er, er - 4);
      const kingDist = Math.abs(ef - (ok & 7)) + Math.abs(er - (ok >> 4));
      const bonus = 10 * centerDist + 4 * (14 - kingDist);
      eg += c === WHITE ? bonus : -bonus;
    }
  }

  const p = Math.min(phase, TOTAL_PHASE);
  const score = Math.round((mg * p + eg * (TOTAL_PHASE - p)) / TOTAL_PHASE);
  // Small tempo bonus for the side to move.
  return (pos.turn === WHITE ? score : -score) + 10;
}

export function hasNonPawnMaterial(pos: Position, color: number): boolean {
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const p = pos.board[sq];
    if (p && pieceColor(p) === color) {
      const t = pieceType(p);
      if (t === KNIGHT || t === BISHOP || t === ROOK || t === QUEEN) return true;
    }
  }
  return false;
}


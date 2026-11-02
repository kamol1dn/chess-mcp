import {
  BISHOP,
  FLAG_CAPTURE,
  FLAG_CASTLE,
  FLAG_PROMO,
  KING,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  type Position,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  pieceType,
  squareFile,
  squareName,
  squareRank,
} from './position.js';

const PIECE_LETTERS = ['', '', 'N', 'B', 'R', 'Q', 'K'];
const PROMO_LETTERS = ['', '', 'n', 'b', 'r', 'q', ''];

export function moveToUci(m: number): string {
  const promo = movePromo(m);
  return squareName(moveFrom(m)) + squareName(moveTo(m)) + (moveFlags(m) & FLAG_PROMO ? PROMO_LETTERS[promo] : '');
}

/**
 * Standard Algebraic Notation for a legal move. `legal` must be the legal move
 * list of `pos` (passed in to avoid regenerating it for every move).
 */
export function moveToSan(pos: Position, m: number, legal: number[] = pos.legalMoves()): string {
  const from = moveFrom(m);
  const to = moveTo(m);
  const flags = moveFlags(m);
  const type = pieceType(pos.board[from]);
  let san: string;

  if (flags & FLAG_CASTLE) {
    san = squareFile(to) === 6 ? 'O-O' : 'O-O-O';
  } else if (type === PAWN) {
    san = flags & FLAG_CAPTURE ? `${'abcdefgh'[squareFile(from)]}x${squareName(to)}` : squareName(to);
    if (flags & FLAG_PROMO) san += '=' + PIECE_LETTERS[movePromo(m)];
  } else {
    let ambiguous = false;
    let sameFile = false;
    let sameRank = false;
    for (const other of legal) {
      if (other === m) continue;
      const of = moveFrom(other);
      if (moveTo(other) !== to || of === from || pieceType(pos.board[of]) !== type) continue;
      ambiguous = true;
      if (squareFile(of) === squareFile(from)) sameFile = true;
      if (squareRank(of) === squareRank(from)) sameRank = true;
    }
    let disambig = '';
    if (ambiguous) {
      if (!sameFile) disambig = 'abcdefgh'[squareFile(from)];
      else if (!sameRank) disambig = String(squareRank(from) + 1);
      else disambig = squareName(from);
    }
    san = PIECE_LETTERS[type] + disambig + (flags & FLAG_CAPTURE ? 'x' : '') + squareName(to);
  }

  pos.makeMove(m);
  if (pos.inCheck()) san += pos.legalMoves().length === 0 ? '#' : '+';
  pos.unmakeMove();
  return san;
}

export interface ParsedMove {
  move: number;
  san: string;
  uci: string;
}

function normalize(s: string): string {
  return s
    .trim()
    .replace(/^\d+\.(\.\.)?\s*/, '') // "12." or "12..." move-number prefixes
    .replace(/[!?]+$/, '')
    .replace(/[+#]+$/, '')
    .replace(/0-0-0/g, 'O-O-O')
    .replace(/0-0/g, 'O-O')
    .replace(/ep$|e\.p\.$/i, '')
    .trim();
}

/**
 * Parses a move in SAN ("Nf3", "exd5", "O-O", "e8=Q") or UCI ("g1f3", "e7e8q")
 * notation, tolerating common variations (missing "x", missing "=", check
 * marks, "0-0", lowercase piece letters when unambiguous). Returns null if the
 * input does not match exactly one legal move.
 */
export function parseMove(pos: Position, input: string, legal: number[] = pos.legalMoves()): ParsedMove | null {
  const raw = normalize(input);
  if (!raw) return null;

  // UCI first: it is unambiguous.
  const uciMatch = /^([a-h][1-8])-?([a-h][1-8])([nbrqNBRQ])?$/.exec(raw);
  if (uciMatch) {
    const wanted = (uciMatch[1] + uciMatch[2] + (uciMatch[3] ?? '')).toLowerCase();
    for (const m of legal) {
      const u = moveToUci(m);
      if (u === wanted) return { move: m, san: moveToSan(pos, m, legal), uci: u };
    }
    // "e7e8" without a promotion piece: default to a queen.
    if (!uciMatch[3]) {
      for (const m of legal) {
        if (moveToUci(m) === wanted + 'q') return { move: m, san: moveToSan(pos, m, legal), uci: wanted + 'q' };
      }
    }
  }

  const sans = legal.map((m) => normalize(moveToSan(pos, m, legal)));
  const loose = (s: string) => s.replace(/x/g, '').replace(/=/g, '').replace(/:/g, '');

  const pick = (pred: (san: string) => boolean): ParsedMove | null => {
    const hits: number[] = [];
    sans.forEach((s, i) => {
      if (pred(s)) hits.push(i);
    });
    if (hits.length !== 1) return null;
    const m = legal[hits[0]];
    return { move: m, san: moveToSan(pos, m, legal), uci: moveToUci(m) };
  };

  return (
    pick((s) => s === raw) ??
    pick((s) => loose(s) === loose(raw)) ??
    // Over-specified disambiguation, e.g. "Ng1f3" or "Pe4".
    pick((s) => loose(s) === loose(raw).replace(/^([NBRQK])[a-h]?[1-8]?(?=[a-h][1-8])/, '$1')) ??
    pick((s) => loose(s) === loose(raw.replace(/^P/, ''))) ??
    // Lowercase piece letters ("nf3", "qxd8").
    (/^[nrqk]/.test(raw) ? pick((s) => loose(s) === loose(raw[0].toUpperCase() + raw.slice(1))) : null) ??
    // A lowercase "b" is only read as a bishop once the pawn reading has failed above.
    (/^b/.test(raw) ? pick((s) => loose(s) === loose('B' + raw.slice(1))) : null)
  );
}

export const PIECE_NAMES: Record<number, string> = {
  [PAWN]: 'pawn',
  [KNIGHT]: 'knight',
  [BISHOP]: 'bishop',
  [ROOK]: 'rook',
  [QUEEN]: 'queen',
  [KING]: 'king',
};

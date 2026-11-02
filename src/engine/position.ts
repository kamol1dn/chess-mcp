/**
 * Board representation and move generation.
 *
 * Uses a 0x88 mailbox: square = rank * 16 + file, so `sq & 0x88` is non-zero
 * for off-board squares. Moves are packed into a single integer so the search
 * can generate millions of them without allocating objects.
 */

export type Color = 0 | 1;
export const WHITE: Color = 0;
export const BLACK: Color = 1;

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const pieceType = (p: number): number => p & 7;
export const pieceColor = (p: number): Color => (p >> 3) as Color;
export const makePiece = (type: number, color: Color): number => type | (color << 3);

// Move packing: from (7 bits) | to (7 bits) | promo (3 bits) | flags (5 bits)
export const FLAG_CAPTURE = 1;
export const FLAG_DOUBLE = 2;
export const FLAG_EP = 4;
export const FLAG_CASTLE = 8;
export const FLAG_PROMO = 16;

export const encodeMove = (from: number, to: number, promo: number, flags: number): number =>
  from | (to << 7) | (promo << 14) | (flags << 17);
export const moveFrom = (m: number): number => m & 127;
export const moveTo = (m: number): number => (m >> 7) & 127;
export const movePromo = (m: number): number => (m >> 14) & 7;
export const moveFlags = (m: number): number => (m >> 17) & 31;

export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const KNIGHT_DIRS = [33, 31, 18, 14, -33, -31, -18, -14];
const BISHOP_DIRS = [17, 15, -17, -15];
const ROOK_DIRS = [16, -16, 1, -1];
const KING_DIRS = [17, 15, -17, -15, 16, -16, 1, -1];

const FILES = 'abcdefgh';
const PIECE_CHARS = ' pnbrqk';

export const squareFile = (sq: number): number => sq & 7;
export const squareRank = (sq: number): number => sq >> 4;
export const squareName = (sq: number): string => FILES[sq & 7] + String((sq >> 4) + 1);
export const isOnBoard = (sq: number): boolean => (sq & 0x88) === 0;

export function parseSquare(name: string): number {
  if (!/^[a-h][1-8]$/.test(name)) return -1;
  return (name.charCodeAt(1) - 49) * 16 + (name.charCodeAt(0) - 97);
}

/** Converts a 0x88 square to a 0..63 index (a1 = 0, h8 = 63). */
export const sq64 = (sq: number): number => (sq >> 4) * 8 + (sq & 7);

// Castling rights are cleared whenever a move touches one of these squares.
const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[0x00] = 15 & ~CASTLE_WQ;
CASTLE_MASK[0x07] = 15 & ~CASTLE_WK;
CASTLE_MASK[0x04] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_MASK[0x70] = 15 & ~CASTLE_BQ;
CASTLE_MASK[0x77] = 15 & ~CASTLE_BK;
CASTLE_MASK[0x74] = 15 & ~(CASTLE_BK | CASTLE_BQ);

// ---- Zobrist hashing (two 32-bit halves, deterministic seed) ----
let seed = 0x9e3779b9;
function rand32(): number {
  // xorshift32
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed | 0;
}
const Z_PIECE_LO = new Int32Array(16 * 128);
const Z_PIECE_HI = new Int32Array(16 * 128);
for (let i = 0; i < Z_PIECE_LO.length; i++) {
  Z_PIECE_LO[i] = rand32();
  Z_PIECE_HI[i] = rand32();
}
const Z_CASTLE_LO = Int32Array.from({ length: 16 }, rand32);
const Z_CASTLE_HI = Int32Array.from({ length: 16 }, rand32);
const Z_EP_LO = Int32Array.from({ length: 8 }, rand32);
const Z_EP_HI = Int32Array.from({ length: 8 }, rand32);
const Z_SIDE_LO = rand32();
const Z_SIDE_HI = rand32();

export class FenError extends Error {
  constructor(message: string) {
    super(`Invalid FEN: ${message}`);
    this.name = 'FenError';
  }
}

interface Undo {
  move: number;
  captured: number;
  castling: number;
  ep: number;
  halfmove: number;
  hashLo: number;
  hashHi: number;
}

export class Position {
  board = new Int8Array(128);
  turn: Color = WHITE;
  castling = 0;
  /** En-passant target square, only set when a capture there is pseudo-legal. */
  ep = -1;
  halfmove = 0;
  fullmove = 1;
  kings = [0, 0];
  hashLo = 0;
  hashHi = 0;
  private undo: Undo[] = [];

  static fromFen(fen: string): Position {
    const p = new Position();
    p.loadFen(fen);
    return p;
  }

  static start(): Position {
    return Position.fromFen(START_FEN);
  }

  clone(): Position {
    const p = new Position();
    p.board.set(this.board);
    p.turn = this.turn;
    p.castling = this.castling;
    p.ep = this.ep;
    p.halfmove = this.halfmove;
    p.fullmove = this.fullmove;
    p.kings = [this.kings[0], this.kings[1]];
    p.hashLo = this.hashLo;
    p.hashHi = this.hashHi;
    return p;
  }

  /** Stable 64-bit position key as a string (used for repetition detection). */
  key(): string {
    return (this.hashHi >>> 0).toString(16).padStart(8, '0') + (this.hashLo >>> 0).toString(16).padStart(8, '0');
  }

  loadFen(fen: string): void {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new FenError('expected at least 4 fields');
    const [placement, side, castling, ep, half = '0', full = '1'] = parts;

    this.board.fill(0);
    const ranks = placement.split('/');
    if (ranks.length !== 8) throw new FenError('board must have 8 ranks');
    const kingCount = [0, 0];
    for (let r = 0; r < 8; r++) {
      const rank = 7 - r;
      let file = 0;
      for (const ch of ranks[r]) {
        if (ch >= '1' && ch <= '8') {
          file += Number(ch);
        } else {
          const lower = ch.toLowerCase();
          const type = PIECE_CHARS.indexOf(lower);
          if (type <= 0) throw new FenError(`unknown piece '${ch}'`);
          if (file > 7) throw new FenError(`rank ${rank + 1} has too many squares`);
          const color: Color = ch === lower ? BLACK : WHITE;
          if (type === PAWN && (rank === 0 || rank === 7)) throw new FenError('pawn on first or last rank');
          const sq = rank * 16 + file;
          this.board[sq] = makePiece(type, color);
          if (type === KING) {
            kingCount[color]++;
            this.kings[color] = sq;
          }
          file++;
        }
      }
      if (file !== 8) throw new FenError(`rank ${rank + 1} does not have 8 squares`);
    }
    if (kingCount[0] !== 1 || kingCount[1] !== 1) throw new FenError('each side must have exactly one king');

    if (side !== 'w' && side !== 'b') throw new FenError(`bad side to move '${side}'`);
    this.turn = side === 'w' ? WHITE : BLACK;

    if (!/^(-|[KQkq]{1,4})$/.test(castling)) throw new FenError(`bad castling field '${castling}'`);
    let c = 0;
    const W_K = makePiece(KING, WHITE);
    const B_K = makePiece(KING, BLACK);
    const W_R = makePiece(ROOK, WHITE);
    const B_R = makePiece(ROOK, BLACK);
    // Silently drop castling rights that the piece placement cannot support.
    if (castling.includes('K') && this.board[0x04] === W_K && this.board[0x07] === W_R) c |= CASTLE_WK;
    if (castling.includes('Q') && this.board[0x04] === W_K && this.board[0x00] === W_R) c |= CASTLE_WQ;
    if (castling.includes('k') && this.board[0x74] === B_K && this.board[0x77] === B_R) c |= CASTLE_BK;
    if (castling.includes('q') && this.board[0x74] === B_K && this.board[0x70] === B_R) c |= CASTLE_BQ;
    this.castling = c;

    this.ep = -1;
    if (ep !== '-') {
      const epSq = parseSquare(ep);
      if (epSq < 0) throw new FenError(`bad en-passant square '${ep}'`);
      const expectedRank = this.turn === WHITE ? 5 : 2;
      if (squareRank(epSq) !== expectedRank) throw new FenError(`en-passant square '${ep}' is on the wrong rank`);
      this.ep = this.epIfCapturable(epSq, this.turn);
    }

    const h = Number(half);
    const f = Number(full);
    if (!Number.isInteger(h) || h < 0) throw new FenError('bad halfmove clock');
    if (!Number.isInteger(f) || f < 1) throw new FenError('bad fullmove number');
    this.halfmove = h;
    this.fullmove = f;
    this.undo = [];
    this.computeHash();

    if (this.isAttacked(this.kings[this.turn ^ 1], this.turn)) {
      throw new FenError('the side not to move is in check');
    }
  }

  toFen(): string {
    let out = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.board[rank * 16 + file];
        if (p === 0) {
          empty++;
          continue;
        }
        if (empty) {
          out += empty;
          empty = 0;
        }
        const ch = PIECE_CHARS[pieceType(p)];
        out += pieceColor(p) === WHITE ? ch.toUpperCase() : ch;
      }
      if (empty) out += empty;
      if (rank > 0) out += '/';
    }
    let castle = '';
    if (this.castling & CASTLE_WK) castle += 'K';
    if (this.castling & CASTLE_WQ) castle += 'Q';
    if (this.castling & CASTLE_BK) castle += 'k';
    if (this.castling & CASTLE_BQ) castle += 'q';
    return [
      out,
      this.turn === WHITE ? 'w' : 'b',
      castle || '-',
      this.ep >= 0 ? squareName(this.ep) : '-',
      this.halfmove,
      this.fullmove,
    ].join(' ');
  }

  private computeHash(): void {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = this.board[sq];
      if (p) {
        lo ^= Z_PIECE_LO[p * 128 + sq];
        hi ^= Z_PIECE_HI[p * 128 + sq];
      }
    }
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];
    if (this.ep >= 0) {
      lo ^= Z_EP_LO[this.ep & 7];
      hi ^= Z_EP_HI[this.ep & 7];
    }
    if (this.turn === BLACK) {
      lo ^= Z_SIDE_LO;
      hi ^= Z_SIDE_HI;
    }
    this.hashLo = lo;
    this.hashHi = hi;
  }

  /** Returns `epSq` if `side` has a pawn that could capture onto it, otherwise -1. */
  private epIfCapturable(epSq: number, side: Color): number {
    const pawn = makePiece(PAWN, side);
    // The capturing pawns sit diagonally behind the target square, from the capturer's view.
    const a = side === WHITE ? epSq - 15 : epSq + 15;
    const b = side === WHITE ? epSq - 17 : epSq + 17;
    if ((!(a & 0x88) && this.board[a] === pawn) || (!(b & 0x88) && this.board[b] === pawn)) return epSq;
    return -1;
  }

  /** Is `sq` attacked by any piece of color `by`? */
  isAttacked(sq: number, by: Color): boolean {
    const b = this.board;
    // Pawns
    if (by === WHITE) {
      const wp = makePiece(PAWN, WHITE);
      if ((!((sq - 15) & 0x88) && b[sq - 15] === wp) || (!((sq - 17) & 0x88) && b[sq - 17] === wp)) return true;
    } else {
      const bp = makePiece(PAWN, BLACK);
      if ((!((sq + 15) & 0x88) && b[sq + 15] === bp) || (!((sq + 17) & 0x88) && b[sq + 17] === bp)) return true;
    }
    const knight = makePiece(KNIGHT, by);
    for (const d of KNIGHT_DIRS) {
      const t = sq + d;
      if (!(t & 0x88) && b[t] === knight) return true;
    }
    const king = makePiece(KING, by);
    for (const d of KING_DIRS) {
      const t = sq + d;
      if (!(t & 0x88) && b[t] === king) return true;
    }
    const bishop = makePiece(BISHOP, by);
    const rook = makePiece(ROOK, by);
    const queen = makePiece(QUEEN, by);
    for (const d of BISHOP_DIRS) {
      let t = sq + d;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) {
          if (p === bishop || p === queen) return true;
          break;
        }
        t += d;
      }
    }
    for (const d of ROOK_DIRS) {
      let t = sq + d;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) {
          if (p === rook || p === queen) return true;
          break;
        }
        t += d;
      }
    }
    return false;
  }

  inCheck(color: Color = this.turn): boolean {
    return this.isAttacked(this.kings[color], (color ^ 1) as Color);
  }

  /**
   * Generates pseudo-legal moves (may leave own king in check) into `out`.
   * With `capturesOnly`, only captures and queen promotions are produced.
   */
  generatePseudo(out: number[], capturesOnly = false): number[] {
    const b = this.board;
    const us = this.turn;
    const them = (us ^ 1) as Color;
    for (let from = 0; from < 128; from++) {
      if (from & 0x88) {
        from += 7;
        continue;
      }
      const p = b[from];
      if (!p || pieceColor(p) !== us) continue;
      const type = pieceType(p);

      if (type === PAWN) {
        const fwd = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 7 : 0;
        const one = from + fwd;
        if (!(one & 0x88) && b[one] === 0) {
          if (squareRank(one) === promoRank) {
            out.push(encodeMove(from, one, QUEEN, FLAG_PROMO));
            if (!capturesOnly) {
              out.push(encodeMove(from, one, ROOK, FLAG_PROMO));
              out.push(encodeMove(from, one, BISHOP, FLAG_PROMO));
              out.push(encodeMove(from, one, KNIGHT, FLAG_PROMO));
            }
          } else if (!capturesOnly) {
            out.push(encodeMove(from, one, 0, 0));
            const two = one + fwd;
            if (squareRank(from) === startRank && b[two] === 0) out.push(encodeMove(from, two, 0, FLAG_DOUBLE));
          }
        }
        for (const side of [fwd - 1, fwd + 1]) {
          const to = from + side;
          if (to & 0x88) continue;
          const target = b[to];
          if (target && pieceColor(target) === them) {
            if (squareRank(to) === promoRank) {
              out.push(encodeMove(from, to, QUEEN, FLAG_CAPTURE | FLAG_PROMO));
              out.push(encodeMove(from, to, ROOK, FLAG_CAPTURE | FLAG_PROMO));
              out.push(encodeMove(from, to, BISHOP, FLAG_CAPTURE | FLAG_PROMO));
              out.push(encodeMove(from, to, KNIGHT, FLAG_CAPTURE | FLAG_PROMO));
            } else {
              out.push(encodeMove(from, to, 0, FLAG_CAPTURE));
            }
          } else if (to === this.ep) {
            out.push(encodeMove(from, to, 0, FLAG_CAPTURE | FLAG_EP));
          }
        }
        continue;
      }

      if (type === KNIGHT || type === KING) {
        const dirs = type === KNIGHT ? KNIGHT_DIRS : KING_DIRS;
        for (const d of dirs) {
          const to = from + d;
          if (to & 0x88) continue;
          const target = b[to];
          if (target === 0) {
            if (!capturesOnly) out.push(encodeMove(from, to, 0, 0));
          } else if (pieceColor(target) === them) {
            out.push(encodeMove(from, to, 0, FLAG_CAPTURE));
          }
        }
        if (type === KING && !capturesOnly) this.generateCastles(out);
        continue;
      }

      const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : KING_DIRS;
      for (const d of dirs) {
        let to = from + d;
        while (!(to & 0x88)) {
          const target = b[to];
          if (target === 0) {
            if (!capturesOnly) out.push(encodeMove(from, to, 0, 0));
          } else {
            if (pieceColor(target) === them) out.push(encodeMove(from, to, 0, FLAG_CAPTURE));
            break;
          }
          to += d;
        }
      }
    }
    return out;
  }

  private generateCastles(out: number[]): void {
    const b = this.board;
    if (this.turn === WHITE) {
      if (this.kings[WHITE] !== 0x04 || this.isAttacked(0x04, BLACK)) return;
      if (this.castling & CASTLE_WK && b[0x05] === 0 && b[0x06] === 0 && !this.isAttacked(0x05, BLACK) && !this.isAttacked(0x06, BLACK)) {
        out.push(encodeMove(0x04, 0x06, 0, FLAG_CASTLE));
      }
      if (this.castling & CASTLE_WQ && b[0x03] === 0 && b[0x02] === 0 && b[0x01] === 0 && !this.isAttacked(0x03, BLACK) && !this.isAttacked(0x02, BLACK)) {
        out.push(encodeMove(0x04, 0x02, 0, FLAG_CASTLE));
      }
    } else {
      if (this.kings[BLACK] !== 0x74 || this.isAttacked(0x74, WHITE)) return;
      if (this.castling & CASTLE_BK && b[0x75] === 0 && b[0x76] === 0 && !this.isAttacked(0x75, WHITE) && !this.isAttacked(0x76, WHITE)) {
        out.push(encodeMove(0x74, 0x76, 0, FLAG_CASTLE));
      }
      if (this.castling & CASTLE_BQ && b[0x73] === 0 && b[0x72] === 0 && b[0x71] === 0 && !this.isAttacked(0x73, WHITE) && !this.isAttacked(0x72, WHITE)) {
        out.push(encodeMove(0x74, 0x72, 0, FLAG_CASTLE));
      }
    }
  }

  /** Fully legal moves for the side to move. */
  legalMoves(): number[] {
    const pseudo = this.generatePseudo([]);
    const legal: number[] = [];
    const us = this.turn;
    for (const m of pseudo) {
      this.makeMove(m);
      if (!this.isAttacked(this.kings[us], this.turn)) legal.push(m);
      this.unmakeMove();
    }
    return legal;
  }

  /** Makes a pseudo-legal move. Returns false (and undoes it) if it leaves the king in check. */
  makeLegal(m: number): boolean {
    const us = this.turn;
    this.makeMove(m);
    if (this.isAttacked(this.kings[us], this.turn)) {
      this.unmakeMove();
      return false;
    }
    return true;
  }

  makeMove(m: number): void {
    const b = this.board;
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    const us = this.turn;
    const them = (us ^ 1) as Color;
    const piece = b[from];
    let captured = b[to];

    this.undo.push({
      move: m,
      captured,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
      hashLo: this.hashLo,
      hashHi: this.hashHi,
    });

    let lo = this.hashLo;
    let hi = this.hashHi;

    if (this.ep >= 0) {
      lo ^= Z_EP_LO[this.ep & 7];
      hi ^= Z_EP_HI[this.ep & 7];
    }
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];

    // Lift the moving piece
    lo ^= Z_PIECE_LO[piece * 128 + from];
    hi ^= Z_PIECE_HI[piece * 128 + from];
    b[from] = 0;

    if (flags & FLAG_EP) {
      const capSq = us === WHITE ? to - 16 : to + 16;
      captured = b[capSq];
      lo ^= Z_PIECE_LO[captured * 128 + capSq];
      hi ^= Z_PIECE_HI[captured * 128 + capSq];
      b[capSq] = 0;
      this.undo[this.undo.length - 1].captured = captured;
    } else if (captured) {
      lo ^= Z_PIECE_LO[captured * 128 + to];
      hi ^= Z_PIECE_HI[captured * 128 + to];
    }

    const placed = flags & FLAG_PROMO ? makePiece(movePromo(m), us) : piece;
    b[to] = placed;
    lo ^= Z_PIECE_LO[placed * 128 + to];
    hi ^= Z_PIECE_HI[placed * 128 + to];

    if (flags & FLAG_CASTLE) {
      let rf: number;
      let rt: number;
      if (to === 0x06) [rf, rt] = [0x07, 0x05];
      else if (to === 0x02) [rf, rt] = [0x00, 0x03];
      else if (to === 0x76) [rf, rt] = [0x77, 0x75];
      else [rf, rt] = [0x70, 0x73];
      const rook = b[rf];
      b[rf] = 0;
      b[rt] = rook;
      lo ^= Z_PIECE_LO[rook * 128 + rf] ^ Z_PIECE_LO[rook * 128 + rt];
      hi ^= Z_PIECE_HI[rook * 128 + rf] ^ Z_PIECE_HI[rook * 128 + rt];
    }

    if (pieceType(piece) === KING) this.kings[us] = to;

    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];

    this.ep = -1;
    if (flags & FLAG_DOUBLE) {
      this.ep = this.epIfCapturable(us === WHITE ? from + 16 : from - 16, them);
      if (this.ep >= 0) {
        lo ^= Z_EP_LO[this.ep & 7];
        hi ^= Z_EP_HI[this.ep & 7];
      }
    }

    this.halfmove = pieceType(piece) === PAWN || captured ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.turn = them;
    lo ^= Z_SIDE_LO;
    hi ^= Z_SIDE_HI;
    this.hashLo = lo;
    this.hashHi = hi;
  }

  unmakeMove(): void {
    const u = this.undo.pop();
    if (!u) throw new Error('unmakeMove with empty history');
    const b = this.board;
    const m = u.move;
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    const them = this.turn;
    const us = (them ^ 1) as Color;
    this.turn = us;

    const placed = b[to];
    b[from] = flags & FLAG_PROMO ? makePiece(PAWN, us) : placed;
    b[to] = 0;

    if (flags & FLAG_EP) {
      b[us === WHITE ? to - 16 : to + 16] = u.captured;
    } else {
      b[to] = u.captured;
    }

    if (flags & FLAG_CASTLE) {
      let rf: number;
      let rt: number;
      if (to === 0x06) [rf, rt] = [0x07, 0x05];
      else if (to === 0x02) [rf, rt] = [0x00, 0x03];
      else if (to === 0x76) [rf, rt] = [0x77, 0x75];
      else [rf, rt] = [0x70, 0x73];
      b[rf] = b[rt];
      b[rt] = 0;
    }

    if (pieceType(b[from]) === KING) this.kings[us] = from;
    if (us === BLACK) this.fullmove--;
    this.castling = u.castling;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    this.hashLo = u.hashLo;
    this.hashHi = u.hashHi;
  }

  /** Passes the turn (used by null-move pruning in the search). */
  makeNull(): void {
    this.undo.push({
      move: 0,
      captured: 0,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
      hashLo: this.hashLo,
      hashHi: this.hashHi,
    });
    if (this.ep >= 0) {
      this.hashLo ^= Z_EP_LO[this.ep & 7];
      this.hashHi ^= Z_EP_HI[this.ep & 7];
    }
    this.ep = -1;
    this.halfmove++;
    this.turn = (this.turn ^ 1) as Color;
    this.hashLo ^= Z_SIDE_LO;
    this.hashHi ^= Z_SIDE_HI;
  }

  unmakeNull(): void {
    const u = this.undo.pop();
    if (!u) throw new Error('unmakeNull with empty history');
    this.turn = (this.turn ^ 1) as Color;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    this.hashLo = u.hashLo;
    this.hashHi = u.hashHi;
  }

  /** Number of moves on the make/unmake stack (search depth plus replayed game moves). */
  get ply(): number {
    return this.undo.length;
  }

  /** True if the current position already occurred since the last irreversible move. */
  isRepetition(): boolean {
    const n = this.undo.length;
    const limit = Math.max(0, n - this.halfmove);
    for (let i = n - 2; i >= limit; i -= 2) {
      const u = this.undo[i];
      if (u.hashLo === this.hashLo && u.hashHi === this.hashHi) return true;
    }
    return false;
  }

  /** True when neither side can possibly deliver mate. */
  insufficientMaterial(): boolean {
    let minors = 0;
    const bishopSquareColors = new Set<number>();
    let knights = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const t = pieceType(this.board[sq]);
      if (t === 0 || t === KING) continue;
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      minors++;
      if (t === KNIGHT) knights++;
      if (t === BISHOP) bishopSquareColors.add(((sq >> 4) + (sq & 7)) & 1);
    }
    if (minors <= 1) return true;
    // Only bishops, all on squares of the same color.
    return knights === 0 && bishopSquareColors.size === 1;
  }

  pieceAt(sq: number): number {
    return this.board[sq];
  }

  /** Returns the board as 64 strings ('' for empty, 'P','n', ...), index 0 = a1. */
  toArray(): string[] {
    const out: string[] = [];
    for (let i = 0; i < 64; i++) {
      const p = this.board[(i >> 3) * 16 + (i & 7)];
      if (!p) out.push('');
      else {
        const ch = PIECE_CHARS[pieceType(p)];
        out.push(pieceColor(p) === WHITE ? ch.toUpperCase() : ch);
      }
    }
    return out;
  }
}

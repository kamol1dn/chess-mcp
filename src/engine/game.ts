import { moveToSan, moveToUci, parseMove } from './notation.js';
import { BLACK, type Color, Position, START_FEN, WHITE } from './position.js';

export type BoardOutcome = 'checkmate' | 'stalemate' | 'threefold' | 'fifty-move' | 'insufficient-material';

export interface PlayedMove {
  san: string;
  uci: string;
  color: 'white' | 'black';
  fenAfter: string;
}

export class IllegalMoveError extends Error {
  constructor(
    public readonly input: string,
    public readonly legal: string[],
    reason?: string,
  ) {
    super(reason ?? `Illegal or unrecognised move '${input}'.`);
    this.name = 'IllegalMoveError';
  }
}

export const colorName = (c: Color): 'white' | 'black' => (c === WHITE ? 'white' : 'black');
export const colorFromName = (c: 'white' | 'black'): Color => (c === 'white' ? WHITE : BLACK);

/**
 * A game of chess: a position plus its move history and the draw rules that
 * depend on history (threefold repetition, fifty-move rule).
 * Draws by threefold repetition and the fifty-move rule are applied
 * automatically so that unattended games always terminate.
 */
export class ChessGame {
  readonly startFen: string;
  readonly pos: Position;
  readonly moves: PlayedMove[] = [];
  private readonly repetitions = new Map<string, number>();

  constructor(fen: string = START_FEN) {
    this.pos = Position.fromFen(fen);
    this.startFen = this.pos.toFen();
    this.repetitions.set(this.pos.key(), 1);
  }

  static fromMoves(startFen: string, moves: string[]): ChessGame {
    const g = new ChessGame(startFen);
    for (const m of moves) g.move(m);
    return g;
  }

  get turn(): 'white' | 'black' {
    return colorName(this.pos.turn);
  }

  fen(): string {
    return this.pos.toFen();
  }

  legalMoves(): number[] {
    return this.pos.legalMoves();
  }

  legalSan(): string[] {
    const legal = this.pos.legalMoves();
    return legal.map((m) => moveToSan(this.pos, m, legal));
  }

  legalUci(): string[] {
    return this.pos.legalMoves().map(moveToUci);
  }

  inCheck(): boolean {
    return this.pos.inCheck();
  }

  /** Square name of the king of the side to move if it is in check. */
  checkSquare(): string | null {
    if (!this.pos.inCheck()) return null;
    const sq = this.pos.kings[this.pos.turn];
    return 'abcdefgh'[sq & 7] + String((sq >> 4) + 1);
  }

  outcome(): BoardOutcome | null {
    const legal = this.pos.legalMoves();
    if (legal.length === 0) return this.pos.inCheck() ? 'checkmate' : 'stalemate';
    if (this.pos.insufficientMaterial()) return 'insufficient-material';
    if ((this.repetitions.get(this.pos.key()) ?? 0) >= 3) return 'threefold';
    if (this.pos.halfmove >= 100) return 'fifty-move';
    return null;
  }

  /** Result string for a board outcome (from the perspective of the side to move). */
  resultFor(outcome: BoardOutcome): '1-0' | '0-1' | '1/2-1/2' {
    if (outcome === 'checkmate') return this.pos.turn === WHITE ? '0-1' : '1-0';
    return '1/2-1/2';
  }

  /** Validates and plays a move given in SAN or UCI. Throws IllegalMoveError. */
  move(input: string): PlayedMove {
    if (this.outcome()) throw new IllegalMoveError(input, [], 'The game is already over.');
    const legal = this.pos.legalMoves();
    const parsed = parseMove(this.pos, input, legal);
    if (!parsed) {
      throw new IllegalMoveError(
        input,
        legal.map((m) => moveToSan(this.pos, m, legal)),
      );
    }
    const color = colorName(this.pos.turn);
    this.pos.makeMove(parsed.move);
    const key = this.pos.key();
    this.repetitions.set(key, (this.repetitions.get(key) ?? 0) + 1);
    const played: PlayedMove = { san: parsed.san, uci: parsed.uci, color, fenAfter: this.pos.toFen() };
    this.moves.push(played);
    return played;
  }

  lastMove(): PlayedMove | null {
    return this.moves.at(-1) ?? null;
  }

  /** The from/to squares of the last move, for highlighting. */
  lastMoveSquares(): [string, string] | null {
    const last = this.lastMove();
    return last ? [last.uci.slice(0, 2), last.uci.slice(2, 4)] : null;
  }

  /** Movetext such as "1. e4 e5 2. Nf3", honouring a non-standard start position. */
  movetext(): string {
    const start = Position.fromFen(this.startFen);
    let moveNo = start.fullmove;
    let blackToMove = start.turn === BLACK;
    const parts: string[] = [];
    for (let i = 0; i < this.moves.length; i++) {
      if (!blackToMove) parts.push(`${moveNo}.`);
      else if (i === 0) parts.push(`${moveNo}...`);
      parts.push(this.moves[i].san);
      if (blackToMove) moveNo++;
      blackToMove = !blackToMove;
    }
    return parts.join(' ');
  }

  pgn(headers: Record<string, string> = {}, result = '*'): string {
    const h: Record<string, string> = {
      Event: 'Casual game',
      Site: 'chess-mcp',
      Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      Round: '-',
      White: '?',
      Black: '?',
      ...headers,
      Result: result,
    };
    if (this.startFen !== START_FEN) {
      h.SetUp = '1';
      h.FEN = this.startFen;
    }
    const headerText = Object.entries(h)
      .map(([k, v]) => `[${k} "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`)
      .join('\n');
    const body = `${this.movetext()} ${result}`.trim();
    // Wrap movetext at 80 columns as recommended by the PGN standard.
    const lines: string[] = [];
    let line = '';
    for (const token of body.split(' ')) {
      if (line && line.length + 1 + token.length > 80) {
        lines.push(line);
        line = token;
      } else {
        line = line ? `${line} ${token}` : token;
      }
    }
    if (line) lines.push(line);
    return `${headerText}\n\n${lines.join('\n')}\n`;
  }
}


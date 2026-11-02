import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ChessGame, IllegalMoveError, colorFromName } from '../engine/game.js';
import { formatSafety } from '../engine/inspect.js';
import { asciiBoard, describePieces } from '../render/text.js';
import { FenError, START_FEN } from '../engine/position.js';
import { levelLimits } from '../engine/search.js';
import { renderBoardPng } from '../render/png.js';
import type {
  CreateGameRequest,
  CreateGameResponse,
  Effort,
  Evaluation,
  GameSummary,
  GameView,
  PlayerSpec,
  PreviewInfo,
  Result,
  SeatView,
  Side,
  Termination,
  TurnInfo,
} from '../shared/types.js';
import { buildBriefing, capitalize, otherSide } from './briefing.js';
import { CLAUDE_MODELS, type ClaudeMoveRequest, type ClaudeMoveResponse, ClaudePlayerError } from './claude-player.js';
import type { EnginePool } from './engine-pool.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from './errors.js';
import type { GameRecord, SeatRecord } from './game-record.js';
import type { GameStore } from './store.js';

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface MovePlayer {
  chooseMove(req: ClaudeMoveRequest): Promise<ClaudeMoveResponse>;
}

export interface GameManagerOptions {
  store: GameStore;
  engine: EnginePool;
  claude: MovePlayer | null;
  moveDelayMs: number;
  maxActiveGames: number;
  idleGameTimeoutMs: number;
  llmMaxAttempts: number;
  log: Logger;
  /** Think time for the background analysis that feeds the eval bar (0 disables it). */
  analysisMs?: number;
  /** Backoff schedule for transient Claude API errors (ms). */
  llmRetryDelaysMs?: number[];
}

interface LiveGame {
  rec: GameRecord;
  chess: ChessGame;
  /** Incremented on every state change; automated players use it to drop stale results. */
  version: number;
  thinking: Partial<Record<Side, AbortController>>;
  waiting: Record<Side, number>;
  flagTimer: NodeJS.Timeout | null;
  automationTimer: NodeJS.Timeout | null;
}

const SIDES: Side[] = ['white', 'black'];
const MAX_COMMENT = 500;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const newId = () => crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10);

function tokenMatches(hash: string | null, token: string | undefined): boolean {
  if (!hash || !token) return false;
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashToken(token), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function defaultName(spec: PlayerSpec): string {
  if (spec.name?.trim()) return spec.name.trim().slice(0, 60);
  switch (spec.kind) {
    case 'human':
      return 'Human';
    case 'agent':
      return 'AI agent';
    case 'engine':
      return `Engine L${spec.level}`;
    case 'llm':
      return CLAUDE_MODELS.find((m) => m.id === spec.model)?.label ?? spec.model;
  }
}

function validateSpec(spec: PlayerSpec, side: Side): PlayerSpec {
  switch (spec.kind) {
    case 'human':
    case 'agent':
      return { kind: spec.kind, ...(spec.name ? { name: spec.name } : {}) };
    case 'engine': {
      const level = Math.round(Number(spec.level));
      if (!Number.isFinite(level) || level < 1 || level > 10) throw badRequest(`${side}: engine level must be between 1 and 10`);
      return { kind: 'engine', level, ...(spec.name ? { name: spec.name } : {}) };
    }
    case 'llm': {
      if (!spec.model || !/^[a-z0-9][a-z0-9.\-]{2,80}$/i.test(spec.model)) throw badRequest(`${side}: invalid model id`);
      const effort: Effort = spec.effort ?? 'medium';
      return { kind: 'llm', model: spec.model, effort, ...(spec.name ? { name: spec.name } : {}) };
    }
    default:
      throw badRequest(`${side}: unknown player kind`);
  }
}

export function resultText(rec: Pick<GameRecord, 'termination' | 'result' | 'loser'>): string | null {
  if (!rec.termination) return null;
  const winner = rec.result === '1-0' ? 'White' : rec.result === '0-1' ? 'Black' : null;
  switch (rec.termination) {
    case 'checkmate':
      return `${winner} wins by checkmate`;
    case 'stalemate':
      return 'Draw by stalemate';
    case 'threefold':
      return 'Draw by threefold repetition';
    case 'fifty-move':
      return 'Draw by the fifty-move rule';
    case 'insufficient-material':
      return 'Draw by insufficient material';
    case 'resignation':
      return `${winner} wins by resignation`;
    case 'timeout':
      return winner ? `${winner} wins on time` : 'Draw: time ran out but the opponent cannot mate';
    case 'agreement':
      return 'Draw by agreement';
    case 'forfeit':
      return `${winner} wins by forfeit (${rec.loser ? capitalize(rec.loser) : 'opponent'} failed to make a legal move)`;
    case 'aborted':
      return 'Game aborted';
  }
}

const MATE_CP = 10_000;

/** Converts an engine score for `sideToMove` into a White-relative Evaluation. */
function whiteEval(score: number, mateIn: number | null, sideToMove: Side, depth: number): Evaluation {
  const sign = sideToMove === 'white' ? 1 : -1;
  if (mateIn !== null) {
    const mate = sign * mateIn;
    return { cp: Math.sign(mate) * (MATE_CP - Math.abs(mate)), mate, depth };
  }
  return { cp: Math.max(-MATE_CP + 100, Math.min(MATE_CP - 100, sign * score)), mate: null, depth };
}

/** Can `side` still deliver mate with its remaining material? (approximation used for flag-fall) */
function hasMatingMaterial(chess: ChessGame, side: Side): boolean {
  const pieces = chess.fen().split(' ')[0].replace(/[\d/]/g, '');
  const own = [...pieces].filter((c) => (side === 'white' ? c === c.toUpperCase() : c === c.toLowerCase()));
  const kinds = own.map((c) => c.toLowerCase()).filter((c) => c !== 'k');
  if (kinds.some((k) => k === 'p' || k === 'r' || k === 'q')) return true;
  return kinds.length >= 2;
}

export class GameManager {
  private readonly games = new Map<string, LiveGame>();
  /** Recently viewed finished games, so spectators don't trigger a replay per request. */
  private readonly finishedCache = new Map<string, LiveGame>();
  private readonly events = new EventEmitter();
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly opts: GameManagerOptions) {
    this.events.setMaxListeners(0);
  }

  /** Loads unfinished games from storage and resumes automated players and clocks. */
  start(): void {
    for (const rec of this.opts.store.listActive()) {
      try {
        const chess = ChessGame.fromMoves(rec.startFen, rec.moves.map((m) => m.uci));
        // Do not charge players for server downtime.
        rec.turnStartedAt = Date.now();
        for (const side of SIDES) rec[side].error = null;
        const live = this.register(rec, chess);
        this.afterChange(live, false);
      } catch (err) {
        this.opts.log.error({ err, gameId: rec.id }, 'failed to restore game; aborting it');
        rec.status = 'finished';
        rec.termination = 'aborted';
        rec.result = '*';
        this.opts.store.save(rec);
      }
    }
    if (this.opts.idleGameTimeoutMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), Math.min(600_000, this.opts.idleGameTimeoutMs));
      this.sweepTimer.unref();
    }
    this.opts.log.info({ restored: this.games.size }, 'game manager started');
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const live of this.games.values()) {
      this.clearTimers(live);
      for (const side of SIDES) live.thinking[side]?.abort();
      this.opts.store.save(live.rec);
    }
    this.events.emit('close');
  }

  // ---------------------------------------------------------------- queries

  get(id: string): GameView {
    return this.view(this.load(id));
  }

  list(opts: { status?: 'active' | 'finished'; limit?: number; offset?: number } = {}): GameSummary[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.opts.store.list({ status: opts.status, limit, offset: Math.max(0, opts.offset ?? 0) }).map((rec) => {
      const last = rec.moves.at(-1);
      const fen = last?.fen ?? rec.startFen;
      return {
        id: rec.id,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        status: rec.status,
        result: rec.result,
        resultText: resultText(rec),
        white: rec.white.name,
        black: rec.black.name,
        whiteKind: rec.white.spec.kind,
        blackKind: rec.black.spec.kind,
        moveCount: rec.moves.length,
        fen,
        turn: fen.split(' ')[1] === 'w' ? 'white' : 'black',
      };
    });
  }

  get activeCount(): number {
    return this.games.size;
  }

  pgn(id: string): string {
    const live = this.load(id);
    const date = new Date(live.rec.createdAt).toISOString().slice(0, 10).replace(/-/g, '.');
    const headers: Record<string, string> = {
      Event: 'chess-mcp game',
      Site: live.rec.id,
      Date: date,
      White: live.rec.white.name,
      Black: live.rec.black.name,
    };
    if (live.rec.termination) headers.Termination = resultText(live.rec) ?? live.rec.termination;
    if (live.rec.clock) headers.TimeControl = `${live.rec.clock.initialMs / 1000}+${live.rec.clock.incrementMs / 1000}`;
    return live.chess.pgn(headers, live.rec.result);
  }

  boardPng(id: string, opts: { orientation?: Side; size?: number; ply?: number }): Buffer {
    const live = this.load(id);
    const { fen, lastMove, check } = this.positionAt(live, opts.ply);
    return renderBoardPng(fen, { orientation: opts.orientation ?? 'white', size: opts.size ?? 640, lastMove, check });
  }

  /** FEN / last move / check square after `ply` half-moves (default: current position). */
  positionAt(live: LiveGame, ply?: number): { fen: string; lastMove: [string, string] | null; check: string | null } {
    if (ply === undefined || ply >= live.rec.moves.length) {
      return { fen: live.chess.fen(), lastMove: live.chess.lastMoveSquares(), check: live.chess.checkSquare() };
    }
    const p = Math.max(0, Math.floor(ply));
    const g = ChessGame.fromMoves(live.rec.startFen, live.rec.moves.slice(0, p).map((m) => m.uci));
    return { fen: g.fen(), lastMove: g.lastMoveSquares(), check: g.checkSquare() };
  }

  /** Same as positionAt but by game id (used by the HTTP layer). */
  position(id: string, ply?: number) {
    return this.positionAt(this.load(id), ply);
  }

  turnInfo(id: string, side: Side, token?: string): TurnInfo {
    const live = this.load(id);
    if (token) this.touch(live, side, token);
    const game = this.view(live);
    const yourTurn = game.status === 'active' && game.turn === side;
    const legalSan = yourTurn ? live.chess.legalSan() : [];
    const safety = yourTurn ? formatSafety(live.chess.pos, colorFromName(side)) : undefined;
    return {
      game,
      side,
      yourTurn,
      gameOver: game.status === 'finished',
      text: buildBriefing(game, side, legalSan, safety),
      legalSan,
    };
  }

  /**
   * Plays a hypothetical line from the current position on a scratch board and
   * describes the result from `side`'s point of view. The game is not changed.
   */
  preview(id: string, side: Side, moves: string[]): { info: PreviewInfo; png: (size?: number) => Buffer } {
    const live = this.load(id);
    if (moves.length > 20) throw badRequest('Preview at most 20 moves at a time.');
    const scratch = ChessGame.fromMoves(live.rec.startFen, live.rec.moves.map((m) => m.uci));
    const startFull = Number(scratch.fen().split(' ')[5]);
    const startsBlack = scratch.turn === 'black';
    const line: string[] = [];
    let error: string | null = null;
    for (const input of moves) {
      try {
        line.push(scratch.move(input).san);
      } catch (err) {
        if (!(err instanceof IllegalMoveError)) throw err;
        error = scratch.outcome()
          ? `The line already ends the game before "${input}".`
          : `Move ${line.length + 1} of the line, "${input}", is not legal for ${capitalize(scratch.turn)} there. Legal moves were: ${err.legal.join(', ')}`;
        break;
      }
    }
    const outcome = scratch.outcome();
    const lineText = line
      .map((san, i) => {
        const ply = i + (startsBlack ? 1 : 0);
        const no = startFull + Math.floor(ply / 2);
        return ply % 2 === 0 ? `${no}. ${san}` : i === 0 ? `${no}... ${san}` : san;
      })
      .join(' ');
    const fen = scratch.fen();
    const toMove = scratch.turn;
    const lines: string[] = [
      `PREVIEW ONLY (nothing was played). Game ${id}, seen from ${capitalize(side)}'s side.`,
      `Line: ${lineText || '(no moves: current position)'}`,
    ];
    if (error) lines.push(`Stopped early: ${error}`);
    if (outcome) lines.push(`The line ends the game: ${outcome}${outcome === 'checkmate' ? ` (${capitalize(toMove === 'white' ? 'black' : 'white')} wins)` : ''}.`);
    else lines.push(`Resulting position: ${capitalize(toMove)} to move${scratch.inCheck() ? ' and in CHECK' : ''}.`);
    lines.push('', `FEN: ${fen}`, asciiBoard(fen, side), '', 'Pieces:', describePieces(fen));
    if (!outcome) {
      lines.push('', `Safety check for you (${capitalize(side)}):`, formatSafety(scratch.pos, colorFromName(side)));
      const forcing = scratch.legalSan().filter((m) => /[x+#]/.test(m));
      const who = toMove === side ? 'Your' : "Opponent's";
      lines.push(`${who} captures and checks available now: ${forcing.length ? forcing.join(', ') : 'none'}`);
    }
    const info: PreviewInfo = {
      ok: error === null,
      side,
      line,
      fen,
      lastMove: scratch.lastMoveSquares(),
      check: scratch.checkSquare(),
      outcome,
      error,
      text: lines.join('\n'),
    };
    return {
      info,
      png: (size = 640) => renderBoardPng(fen, { orientation: side, size, lastMove: info.lastMove, check: info.check }),
    };
  }

  /** Resolves the side a seat token belongs to. */
  sideForToken(id: string, token: string): Side {
    const live = this.load(id);
    for (const side of SIDES) if (tokenMatches(live.rec[side].tokenHash, token)) return side;
    throw forbidden('Invalid seat token for this game');
  }

  subscribe(id: string, listener: (game: GameView) => void): () => void {
    this.load(id); // 404 for unknown games
    const ev = `game:${id}`;
    this.events.on(ev, listener);
    return () => this.events.off(ev, listener);
  }

  /**
   * Long-poll until it is `side`'s turn or the game ends. Resolves with the
   * turn information, or with `yourTurn: false` when `timeoutMs` elapses.
   */
  async waitForTurn(id: string, side: Side, token: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<TurnInfo> {
    let live = this.load(id);
    if (token) this.touch(live, side, token);
    const ready = () => live.rec.status === 'finished' || live.chess.turn === side;
    if (ready()) return this.turnInfo(id, side);

    live.waiting[side]++;
    if (live.waiting[side] === 1) this.emit(live);
    try {
      await new Promise<void>((resolve) => {
        const ev = `game:${id}`;
        const done = () => {
          clearTimeout(timer);
          this.events.off(ev, onChange);
          this.events.off('close', done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const onChange = () => {
          live = this.games.get(id) ?? live;
          if (ready()) done();
        };
        const timer = setTimeout(done, Math.max(0, timeoutMs));
        this.events.on(ev, onChange);
        this.events.once('close', done);
        signal?.addEventListener('abort', done, { once: true });
      });
    } finally {
      live.waiting[side] = Math.max(0, live.waiting[side] - 1);
      if (live.waiting[side] === 0 && live.rec.status === 'active' && !this.closed) this.emit(live);
    }
    return this.turnInfo(id, side);
  }

  // ---------------------------------------------------------------- commands

  create(req: CreateGameRequest): CreateGameResponse {
    if (this.games.size >= this.opts.maxActiveGames) {
      throw new ApiError(503, 'capacity', 'Too many active games on this server; try again later.');
    }
    const white = validateSpec(req.white, 'white');
    const black = validateSpec(req.black, 'black');

    let chess: ChessGame;
    try {
      chess = new ChessGame(req.fen?.trim() || START_FEN);
    } catch (err) {
      if (err instanceof FenError) throw badRequest(err.message);
      throw err;
    }
    if (chess.outcome()) throw badRequest('The starting position is already decided (mate, stalemate or dead draw).');

    let clock: GameRecord['clock'] = null;
    if (req.timeControl) {
      const initialMs = Math.round(req.timeControl.initialMinutes * 60_000);
      const incrementMs = Math.round(req.timeControl.incrementSeconds * 1000);
      if (!(initialMs >= 10_000 && initialMs <= 24 * 3_600_000)) throw badRequest('initialMinutes must be between 1/6 and 1440');
      if (!(incrementMs >= 0 && incrementMs <= 600_000)) throw badRequest('incrementSeconds must be between 0 and 600');
      clock = { initialMs, incrementMs, white: initialMs, black: initialMs };
    }

    const now = Date.now();
    const seat = (spec: PlayerSpec): SeatRecord => ({ spec, name: defaultName(spec), tokenHash: null, lastSeenAt: null, error: null });
    const rec: GameRecord = {
      version: 1,
      id: newId(),
      createdAt: now,
      updatedAt: now,
      startFen: chess.startFen,
      moves: [],
      white: seat(white),
      black: seat(black),
      status: 'active',
      result: '*',
      termination: null,
      loser: null,
      clock,
      turnStartedAt: now,
      drawOffer: null,
    };

    const tokens: Partial<Record<Side, string>> = {};
    for (const side of new Set(req.claim ?? [])) {
      const kind = rec[side].spec.kind;
      if (kind !== 'human' && kind !== 'agent') throw badRequest(`Cannot claim the ${side} seat: it is played by the ${kind}`);
      const token = newToken();
      rec[side].tokenHash = hashToken(token);
      rec[side].lastSeenAt = now;
      tokens[side] = token;
    }

    const live = this.register(rec, chess);
    this.opts.store.save(rec);
    this.analyze(live, 0);
    this.opts.log.info({ gameId: rec.id, white: rec.white.name, black: rec.black.name }, 'game created');
    this.afterChange(live, false);
    return { game: this.view(live), tokens };
  }

  claim(id: string, side: Side, name?: string): { token: string; game: GameView } {
    const live = this.active(id);
    const s = live.rec[side];
    if (s.spec.kind !== 'human' && s.spec.kind !== 'agent') {
      throw conflict(`The ${side} seat is played by the built-in ${s.spec.kind === 'engine' ? 'engine' : 'Claude player'} and cannot be claimed.`);
    }
    if (s.tokenHash) throw conflict(`The ${side} seat has already been claimed.`);
    const token = newToken();
    s.tokenHash = hashToken(token);
    s.lastSeenAt = Date.now();
    if (name?.trim()) s.name = name.trim().slice(0, 60);
    this.afterChange(live);
    this.opts.log.info({ gameId: id, side, name: s.name }, 'seat claimed');
    return { token, game: this.view(live) };
  }

  move(id: string, token: string, move: string, comment?: string): GameView {
    const live = this.active(id);
    const side = this.authorize(live, token);
    if (live.chess.turn !== side) throw conflict(`It is not your turn: ${capitalize(live.chess.turn)} is to move.`);
    this.applyMove(live, side, move, { comment, thinkMs: Date.now() - live.rec.turnStartedAt });
    return this.view(live);
  }

  resign(id: string, token: string): GameView {
    const live = this.active(id);
    const side = this.authorize(live, token);
    this.finish(live, 'resignation', side === 'white' ? '0-1' : '1-0', side);
    return this.view(live);
  }

  /** Offers a draw, or accepts the opponent's pending offer. */
  offerDraw(id: string, token: string): GameView {
    const live = this.active(id);
    const side = this.authorize(live, token);
    if (live.rec.drawOffer === otherSide(side)) {
      this.finish(live, 'agreement', '1/2-1/2', null);
    } else if (live.rec.drawOffer !== side) {
      live.rec.drawOffer = side;
      this.afterChange(live);
    }
    return this.view(live);
  }

  acceptDraw(id: string, token: string): GameView {
    const live = this.active(id);
    const side = this.authorize(live, token);
    if (live.rec.drawOffer !== otherSide(side)) throw conflict('There is no draw offer from your opponent to accept.');
    this.finish(live, 'agreement', '1/2-1/2', null);
    return this.view(live);
  }

  declineDraw(id: string, token: string): GameView {
    const live = this.active(id);
    const side = this.authorize(live, token);
    if (live.rec.drawOffer === otherSide(side)) {
      live.rec.drawOffer = null;
      this.afterChange(live);
    }
    return this.view(live);
  }

  /** Abort a game before both sides have moved (e.g. an opponent never showed up). */
  abort(id: string, token: string): GameView {
    const live = this.active(id);
    this.authorize(live, token);
    if (live.rec.moves.length >= 2) throw conflict('Games can only be aborted before both sides have moved. Resign instead.');
    this.finish(live, 'aborted', '*', null);
    return this.view(live);
  }

  /** Clears an automated player's error and lets it try again. */
  retry(id: string, side: Side): GameView {
    const live = this.active(id);
    live.rec[side].error = null;
    this.afterChange(live);
    return this.view(live);
  }

  /** Administrative abort / delete. */
  adminAbort(id: string): GameView {
    const live = this.active(id);
    this.finish(live, 'aborted', '*', null);
    return this.view(live);
  }

  delete(id: string): void {
    const live = this.games.get(id);
    if (live) {
      this.clearTimers(live);
      for (const side of SIDES) live.thinking[side]?.abort();
      this.games.delete(id);
    }
    this.finishedCache.delete(id);
    if (!this.opts.store.delete(id) && !live) throw notFound('Game');
  }

  // ---------------------------------------------------------------- internals

  private register(rec: GameRecord, chess: ChessGame): LiveGame {
    const live: LiveGame = {
      rec,
      chess,
      version: 0,
      thinking: {},
      waiting: { white: 0, black: 0 },
      flagTimer: null,
      automationTimer: null,
    };
    if (rec.status === 'active') this.games.set(rec.id, live);
    return live;
  }

  private load(id: string): LiveGame {
    const live = this.games.get(id) ?? this.finishedCache.get(id);
    if (live) return live;
    const rec = this.opts.store.get(id);
    if (!rec) throw notFound('Game');
    const chess = ChessGame.fromMoves(rec.startFen, rec.moves.map((m) => m.uci));
    const loaded: LiveGame = {
      rec,
      chess,
      version: 0,
      thinking: {},
      waiting: { white: 0, black: 0 },
      flagTimer: null,
      automationTimer: null,
    };
    if (rec.status === 'active') {
      // Active games are always in memory after start(); this only happens with external writers.
      this.games.set(id, loaded);
      this.afterChange(loaded, false);
    } else {
      this.cacheFinished(loaded);
    }
    return loaded;
  }

  private cacheFinished(live: LiveGame): void {
    this.finishedCache.set(live.rec.id, live);
    if (this.finishedCache.size > 200) this.finishedCache.delete(this.finishedCache.keys().next().value!);
  }

  private active(id: string): LiveGame {
    const live = this.load(id);
    if (live.rec.status !== 'active') throw conflict(`The game is over: ${resultText(live.rec) ?? live.rec.result}.`);
    return live;
  }

  private authorize(live: LiveGame, token: string | undefined): Side {
    for (const side of SIDES) {
      if (tokenMatches(live.rec[side].tokenHash, token)) {
        live.rec[side].lastSeenAt = Date.now();
        return side;
      }
    }
    throw forbidden('Invalid or missing seat token. Claim a seat first (join the game).');
  }

  private touch(live: LiveGame, side: Side, token: string): void {
    if (tokenMatches(live.rec[side].tokenHash, token)) live.rec[side].lastSeenAt = Date.now();
  }

  private applyMove(live: LiveGame, side: Side, input: string, meta: { comment?: string; thinkMs: number; eval?: Evaluation }): void {
    const now = Date.now();
    const rec = live.rec;

    // Charge the clock first: a move made after the flag fell does not count.
    if (rec.clock && rec.moves.length >= 2) {
      rec.clock[side] -= now - rec.turnStartedAt;
      if (rec.clock[side] <= 0) {
        rec.clock[side] = 0;
        this.flag(live, side);
        throw conflict('Your time ran out.');
      }
    }

    let played;
    try {
      played = live.chess.move(input);
    } catch (err) {
      if (err instanceof IllegalMoveError) {
        throw new ApiError(400, 'illegal_move', `Illegal move '${input}'. Legal moves: ${err.legal.join(', ')}`, { legalMoves: err.legal });
      }
      throw err;
    }

    if (rec.clock && rec.moves.length >= 2) rec.clock[side] += rec.clock.incrementMs;
    rec.moves.push({
      san: played.san,
      uci: played.uci,
      color: side,
      fen: played.fenAfter,
      at: now,
      thinkMs: Math.max(0, Math.round(meta.thinkMs)),
      ...(meta.comment?.trim() ? { comment: meta.comment.trim().slice(0, MAX_COMMENT) } : {}),
      ...(meta.eval ? { eval: meta.eval } : {}),
    });
    rec.turnStartedAt = now;
    if (rec.drawOffer === otherSide(side)) rec.drawOffer = null; // moving declines a pending offer
    rec[side].error = null;

    const outcome = live.chess.outcome();
    const last = rec.moves[rec.moves.length - 1];
    if (outcome === 'checkmate') last.eval = { cp: side === 'white' ? MATE_CP : -MATE_CP, mate: 0, depth: 0 };
    else if (outcome) last.eval = { cp: 0, mate: null, depth: 0 };
    else if (!last.eval) this.analyze(live, rec.moves.length);
    if (outcome) {
      this.finish(live, outcome as Termination, live.chess.resultFor(outcome), outcome === 'checkmate' ? otherSide(side) : null);
    } else {
      this.afterChange(live);
    }
  }

  private flag(live: LiveGame, side: Side): void {
    const winner = otherSide(side);
    const result: Result = hasMatingMaterial(live.chess, winner) ? (winner === 'white' ? '1-0' : '0-1') : '1/2-1/2';
    this.finish(live, 'timeout', result, side);
  }

  private finish(live: LiveGame, termination: Termination, result: Result, loser: Side | null): void {
    const rec = live.rec;
    if (rec.status === 'finished') return;
    if (rec.clock && rec.moves.length >= 2 && termination !== 'timeout') {
      // Freeze the clock of the side that was thinking.
      const side = live.chess.turn;
      rec.clock[side] = Math.max(0, rec.clock[side] - (Date.now() - rec.turnStartedAt));
    }
    rec.status = 'finished';
    rec.termination = termination;
    rec.result = result;
    rec.loser = loser;
    rec.drawOffer = null;
    this.clearTimers(live);
    for (const side of SIDES) live.thinking[side]?.abort();
    this.games.delete(rec.id);
    this.cacheFinished(live);
    this.opts.log.info({ gameId: rec.id, termination, result }, 'game finished');
    this.afterChange(live);
  }

  private clearTimers(live: LiveGame): void {
    if (live.flagTimer) clearTimeout(live.flagTimer);
    if (live.automationTimer) clearTimeout(live.automationTimer);
    live.flagTimer = null;
    live.automationTimer = null;
  }

  /** Persists, notifies listeners and (re)schedules clocks and automated players. */
  private afterChange(live: LiveGame, persist = true): void {
    live.version++;
    live.rec.updatedAt = Date.now();
    if (persist) this.opts.store.save(live.rec);
    this.emit(live);
    if (live.rec.status !== 'active' || this.closed) return;
    this.scheduleFlag(live);
    this.scheduleAutomation(live);
  }

  private emit(live: LiveGame): void {
    this.events.emit(`game:${live.rec.id}`, this.view(live));
  }

  private scheduleFlag(live: LiveGame): void {
    if (live.flagTimer) clearTimeout(live.flagTimer);
    live.flagTimer = null;
    const rec = live.rec;
    if (!rec.clock || rec.moves.length < 2) return;
    const side = live.chess.turn;
    const remaining = rec.clock[side] - (Date.now() - rec.turnStartedAt);
    live.flagTimer = setTimeout(() => {
      if (rec.status !== 'active' || live.chess.turn !== side) return;
      const left = rec.clock![side] - (Date.now() - rec.turnStartedAt);
      if (left <= 0) {
        rec.clock![side] = 0;
        this.flag(live, side);
      } else {
        this.scheduleFlag(live);
      }
    }, Math.max(0, remaining) + 25);
    live.flagTimer.unref?.();
  }

  private scheduleAutomation(live: LiveGame): void {
    const side = live.chess.turn;
    const seat = live.rec[side];
    if (seat.spec.kind !== 'engine' && seat.spec.kind !== 'llm') return;
    if (live.thinking[side] || seat.error || live.automationTimer) return;
    const version = live.version;
    live.automationTimer = setTimeout(() => {
      live.automationTimer = null;
      if (live.version !== version || live.rec.status !== 'active') {
        if (live.rec.status === 'active') this.scheduleAutomation(live);
        return;
      }
      void this.runAutomated(live, side);
    }, this.opts.moveDelayMs);
  }

  private async runAutomated(live: LiveGame, side: Side): Promise<void> {
    const seat = live.rec[side];
    const controller = new AbortController();
    live.thinking[side] = controller;
    this.emit(live);
    const startMoves = live.rec.moves.length;
    const started = Date.now();
    const stillCurrent = () =>
      !controller.signal.aborted && live.rec.status === 'active' && live.chess.turn === side && this.games.has(live.rec.id);

    try {
      if (seat.spec.kind === 'engine') {
        const limits = levelLimits(seat.spec.level);
        if (live.rec.clock && live.rec.moves.length >= 2) {
          const left = live.rec.clock[side] - (Date.now() - live.rec.turnStartedAt);
          const budget = Math.max(50, left / 30 + live.rec.clock.incrementMs * 0.7);
          limits.timeMs = Math.min(limits.timeMs ?? Infinity, budget);
        }
        const result = await this.opts.engine.search(live.rec.startFen, live.rec.moves.map((m) => m.uci), limits);
        if (!stillCurrent() || live.rec.moves.length !== startMoves) return;
        // Report the evaluation from White's point of view, as is conventional.
        const whiteScore = side === 'white' ? result.score : -result.score;
        const evalText =
          result.mateIn !== null
            ? `${(side === 'white') === result.mateIn > 0 ? 'White' : 'Black'} mates in ${Math.abs(result.mateIn)}`
            : `eval ${(whiteScore >= 0 ? '+' : '') + (whiteScore / 100).toFixed(2)}`;
        // The eval bar uses its own fixed-strength analysis (weak levels search too shallowly to be useful).
        this.applyMove(live, side, result.uci, {
          thinkMs: Date.now() - started,
          comment: `${evalText}, depth ${result.depth}${result.pv.length > 1 ? `; line: ${result.pv.slice(0, 6).join(' ')}` : ''}`,
        });
      } else if (seat.spec.kind === 'llm') {
        await this.playClaude(live, side, controller.signal, stillCurrent, started);
      }
    } catch (err) {
      if (controller.signal.aborted || !stillCurrent()) return;
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log.warn({ gameId: live.rec.id, side, err: message }, 'automated player failed');
      seat.error = message;
      this.afterChange(live);
    } finally {
      if (live.thinking[side] === controller) {
        delete live.thinking[side];
        if (!this.closed) {
          this.emit(live);
          if (live.rec.status === 'active') this.scheduleAutomation(live);
        }
      }
    }
  }

  private async playClaude(
    live: LiveGame,
    side: Side,
    signal: AbortSignal,
    stillCurrent: () => boolean,
    started: number,
  ): Promise<void> {
    const seat = live.rec[side];
    if (seat.spec.kind !== 'llm') return;
    if (!this.opts.claude) throw new Error('Claude players are not available on this server.');
    const feedback: string[] = [];
    const retryDelays = this.opts.llmRetryDelaysMs ?? [2_000, 8_000, 20_000];
    let transientFailures = 0;
    let attempts = 0;

    while (stillCurrent()) {
      const info = this.turnInfo(live.rec.id, side);
      const png = renderBoardPng(live.chess.fen(), {
        orientation: side,
        size: 640,
        lastMove: live.chess.lastMoveSquares(),
        check: live.chess.checkSquare(),
      });
      let answer: ClaudeMoveResponse;
      try {
        answer = await this.opts.claude.chooseMove({
          model: seat.spec.model,
          effort: seat.spec.effort ?? 'medium',
          side,
          briefing: info.text,
          boardPng: png,
          feedback,
          drawOffered: live.rec.drawOffer === otherSide(side),
          signal,
        });
      } catch (err) {
        if (err instanceof ClaudePlayerError && err.retryable && transientFailures < retryDelays.length) {
          await sleep(retryDelays[transientFailures++], signal);
          continue;
        }
        throw err;
      }
      if (!stillCurrent()) return;

      if (answer.acceptDraw && live.rec.drawOffer === otherSide(side)) {
        this.finish(live, 'agreement', '1/2-1/2', null);
        return;
      }
      if (/^resign/i.test(answer.move)) {
        this.finish(live, 'resignation', side === 'white' ? '0-1' : '1-0', side);
        return;
      }
      try {
        this.applyMove(live, side, answer.move, { comment: answer.comment, thinkMs: Date.now() - started });
        return;
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'illegal_move') throw err;
        attempts++;
        this.opts.log.warn({ gameId: live.rec.id, side, move: answer.move, attempts }, 'Claude proposed an illegal move');
        if (attempts >= this.opts.llmMaxAttempts) {
          this.finish(live, 'forfeit', side === 'white' ? '0-1' : '1-0', side);
          return;
        }
        feedback.push(
          `Your previous answer "${answer.move}" is not a legal move in this position (attempt ${attempts} of ${this.opts.llmMaxAttempts}). Choose exactly one move from the legal move list.`,
        );
      }
    }
  }

  /**
   * Evaluates the position after `ply` half-moves in the background and stores
   * it for the eval bar. Spectator-only: it is never shown to agents.
   */
  private analyze(live: LiveGame, ply: number): void {
    const ms = this.opts.analysisMs ?? 0;
    if (ms <= 0) return;
    const rec = live.rec;
    const moves = rec.moves.slice(0, ply).map((m) => m.uci);
    const fen = ply === 0 ? rec.startFen : rec.moves[ply - 1].fen;
    const sideToMove: Side = fen.split(' ')[1] === 'w' ? 'white' : 'black';
    this.opts.engine
      .search(rec.startFen, moves, { timeMs: ms, depth: 30 })
      .then((r) => {
        const evaluation = whiteEval(r.score, r.mateIn, sideToMove, r.depth);
        if (ply === 0) rec.startEval = evaluation;
        else if (rec.moves[ply - 1]?.uci === moves[ply - 1] && !rec.moves[ply - 1].eval) rec.moves[ply - 1].eval = evaluation;
        else return;
        if (this.closed) return;
        this.opts.store.save(rec);
        this.emit(live);
      })
      .catch((err: Error) => this.opts.log.warn({ gameId: rec.id, err: err.message }, 'analysis failed'));
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - this.opts.idleGameTimeoutMs;
    for (const live of [...this.games.values()]) {
      if (live.rec.updatedAt < cutoff && !live.thinking.white && !live.thinking.black) {
        this.opts.log.info({ gameId: live.rec.id }, 'aborting idle game');
        this.finish(live, 'aborted', '*', null);
      }
    }
  }

  view(live: LiveGame): GameView {
    const rec = live.rec;
    const now = Date.now();
    const seatView = (side: Side): SeatView => {
      const s = rec[side];
      const automated = s.spec.kind === 'engine' || s.spec.kind === 'llm';
      return {
        kind: s.spec.kind,
        name: s.name,
        ...(s.spec.kind === 'engine' ? { level: s.spec.level } : {}),
        ...(s.spec.kind === 'llm' ? { model: s.spec.model, effort: s.spec.effort ?? 'medium' } : {}),
        claimed: automated || s.tokenHash !== null,
        thinking: Boolean(live.thinking[side]),
        waiting: live.waiting[side] > 0,
        lastSeenAt: s.lastSeenAt,
        error: s.error,
      };
    };
    const running: Side | null = rec.status === 'active' && rec.clock && rec.moves.length >= 2 ? live.chess.turn : null;
    return {
      id: rec.id,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      status: rec.status,
      result: rec.result,
      termination: rec.termination,
      resultText: resultText(rec),
      startFen: rec.startFen,
      fen: live.chess.fen(),
      turn: live.chess.turn,
      moves: rec.moves.map((m, i) => ({ ply: i + 1, ...m })),
      white: seatView('white'),
      black: seatView('black'),
      legalMoves: rec.status === 'active' ? live.chess.legalUci() : [],
      check: live.chess.checkSquare(),
      lastMove: live.chess.lastMoveSquares(),
      clock: rec.clock
        ? {
            initialMs: rec.clock.initialMs,
            incrementMs: rec.clock.incrementMs,
            white: rec.clock.white,
            black: rec.clock.black,
            running,
            since: running ? rec.turnStartedAt : now,
          }
        : null,
      drawOffer: rec.drawOffer,
      startEval: rec.startEval ?? null,
    };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

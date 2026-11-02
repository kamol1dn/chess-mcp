/** Wire types shared by the server, the HTTP client (MCP/CLI) and the web UI. */

export type Side = 'white' | 'black';
export type Result = '1-0' | '0-1' | '1/2-1/2' | '*';
export type GameStatus = 'active' | 'finished';

export type Termination =
  | 'checkmate'
  | 'stalemate'
  | 'threefold'
  | 'fifty-move'
  | 'insufficient-material'
  | 'resignation'
  | 'timeout'
  | 'agreement'
  | 'forfeit'
  | 'aborted';

/**
 * Engine evaluation from White's point of view. `cp` is always set (mates map to
 * ±10000 minus the distance) so it can drive an eval bar directly; `mate` is the
 * number of moves to mate (positive = White mates, 0 = checkmate on the board).
 */
export interface Evaluation {
  cp: number;
  mate: number | null;
  depth: number;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Who plays a side:
 * - human:  a person moving pieces in the web UI
 * - agent:  any external AI agent connected over MCP, the CLI or the HTTP API
 * - engine: the built-in engine at a strength level 1-10
 * - llm:    a Claude model the server calls directly through the Anthropic API
 */
export type PlayerSpec =
  | { kind: 'human'; name?: string }
  | { kind: 'agent'; name?: string }
  | { kind: 'engine'; level: number; name?: string }
  | { kind: 'llm'; model: string; effort?: Effort; name?: string };

export type PlayerKind = PlayerSpec['kind'];

export interface SeatView {
  kind: PlayerKind;
  name: string;
  level?: number;
  model?: string;
  effort?: Effort;
  /** Human/agent seats must be claimed before they can move. Engine/LLM seats are always ready. */
  claimed: boolean;
  /** An automated player (engine/llm) is currently computing a move. */
  thinking: boolean;
  /** An agent is currently long-polling for its turn. */
  waiting: boolean;
  lastSeenAt: number | null;
  error: string | null;
}

export interface MoveView {
  ply: number;
  san: string;
  uci: string;
  color: Side;
  fen: string;
  at: number;
  thinkMs: number;
  comment?: string;
  /** Evaluation of the position after this move (filled in asynchronously). */
  eval?: Evaluation;
}

export interface ClockView {
  initialMs: number;
  incrementMs: number;
  white: number;
  black: number;
  /** Side whose clock is running, or null when stopped. */
  running: Side | null;
  /** Server timestamp at which `running`'s remaining time was measured. */
  since: number;
}

export interface GameView {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: GameStatus;
  result: Result;
  termination: Termination | null;
  /** Human readable description of the result, e.g. "White wins by checkmate". */
  resultText: string | null;
  startFen: string;
  fen: string;
  turn: Side;
  moves: MoveView[];
  white: SeatView;
  black: SeatView;
  legalMoves: string[];
  check: string | null;
  lastMove: [string, string] | null;
  clock: ClockView | null;
  drawOffer: Side | null;
  /** Evaluation of the starting position. */
  startEval: Evaluation | null;
}

export interface GameSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: GameStatus;
  result: Result;
  resultText: string | null;
  white: string;
  black: string;
  whiteKind: PlayerKind;
  blackKind: PlayerKind;
  moveCount: number;
  fen: string;
  turn: Side;
}

export interface CreateGameRequest {
  white: PlayerSpec;
  black: PlayerSpec;
  /** Optional starting position. */
  fen?: string;
  /** Optional clock, e.g. { initialMinutes: 5, incrementSeconds: 3 }. */
  timeControl?: { initialMinutes: number; incrementSeconds: number } | null;
  /** Seats to claim immediately for the caller (must be human/agent seats). */
  claim?: Side[];
}

export interface CreateGameResponse {
  game: GameView;
  /** Seat tokens for the claimed seats. Keep them secret: they authorise moves. */
  tokens: Partial<Record<Side, string>>;
}

export interface ClaimSeatResponse {
  game: GameView;
  side: Side;
  token: string;
}

/** Everything an agent needs to decide on a move. */
export interface TurnInfo {
  game: GameView;
  side: Side;
  yourTurn: boolean;
  gameOver: boolean;
  /** Plain-text briefing: position, history, legal moves, clocks, instructions. */
  text: string;
  legalSan: string[];
}

/** Result of playing a hypothetical line on a scratch board (nothing is played in the game). */
export interface PreviewInfo {
  ok: boolean;
  side: Side;
  /** The moves that were played on the scratch board, in SAN. */
  line: string[];
  fen: string;
  lastMove: [string, string] | null;
  check: string | null;
  /** e.g. "checkmate", "stalemate" if the line ends the game. */
  outcome: string | null;
  /** Why the line stopped early (illegal move), if it did. */
  error: string | null;
  /** Briefing of the resulting position: board, safety report, forcing replies. */
  text: string;
}

export interface MoveRequest {
  move: string;
  /** Optional short note shown to spectators next to the move. */
  comment?: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  legalMoves?: string[];
}

export interface ServerInfo {
  name: string;
  version: string;
  authRequired: boolean;
  llmAvailable: boolean;
  llmModels: Array<{ id: string; label: string }>;
  publicUrl: string;
}

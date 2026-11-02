import type {
  ClaimSeatResponse,
  CreateGameRequest,
  CreateGameResponse,
  GameSummary,
  GameView,
  PreviewInfo,
  ServerInfo,
  Side,
  TurnInfo,
} from '../shared/types.js';

export type DrawAction = 'offer' | 'accept' | 'decline';

/**
 * Operations an agent front-end (MCP server, CLI) needs. Implemented over HTTP
 * by ChessClient and in-process by the server's own MCP endpoint.
 */
export interface ChessBackend {
  readonly publicUrl: string;
  info(): Promise<ServerInfo>;
  listGames(opts?: { status?: 'active' | 'finished'; limit?: number }): Promise<GameSummary[]>;
  getGame(id: string): Promise<GameView>;
  createGame(req: CreateGameRequest): Promise<CreateGameResponse>;
  claimSeat(id: string, side: Side, name?: string): Promise<ClaimSeatResponse>;
  turn(id: string, side: Side, token?: string): Promise<TurnInfo>;
  /** Long-poll until it is `side`'s turn or the game ends (or the timeout elapses). */
  wait(id: string, side: Side, token: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<TurnInfo>;
  move(id: string, token: string, move: string, comment?: string): Promise<GameView>;
  resign(id: string, token: string): Promise<GameView>;
  draw(id: string, token: string, action: DrawAction): Promise<GameView>;
  abort(id: string, token: string): Promise<GameView>;
  pgn(id: string): Promise<string>;
  /** Plays `moves` on a scratch board from the current position (the game is not changed). */
  preview(id: string, side: Side, moves: string[]): Promise<PreviewInfo>;
  previewPng(id: string, side: Side, moves: string[], size?: number): Promise<Buffer>;
  boardPng(id: string, opts?: { orientation?: Side; size?: number; ply?: number }): Promise<Buffer>;
}

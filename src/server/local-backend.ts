import type { ChessBackend, DrawAction } from '../client/backend.js';
import type { CreateGameRequest, ServerInfo, Side } from '../shared/types.js';
import type { GameManager } from './game-manager.js';

/** ChessBackend that talks to the in-process GameManager (used by the server's /mcp endpoint). */
export class LocalBackend implements ChessBackend {
  constructor(
    private readonly games: GameManager,
    readonly publicUrl: string,
    private readonly serverInfo: () => ServerInfo,
  ) {}

  async info() {
    return this.serverInfo();
  }
  async listGames(opts: { status?: 'active' | 'finished'; limit?: number } = {}) {
    return this.games.list(opts);
  }
  async getGame(id: string) {
    return this.games.get(id);
  }
  async createGame(req: CreateGameRequest) {
    return this.games.create(req);
  }
  async claimSeat(id: string, side: Side, name?: string) {
    const { token, game } = this.games.claim(id, side, name);
    return { token, game, side };
  }
  async turn(id: string, side: Side, token?: string) {
    return this.games.turnInfo(id, side, token);
  }
  wait(id: string, side: Side, token: string | undefined, timeoutMs: number, signal?: AbortSignal) {
    return this.games.waitForTurn(id, side, token, Math.min(timeoutMs, 300_000), signal);
  }
  async move(id: string, token: string, move: string, comment?: string) {
    return this.games.move(id, token, move, comment);
  }
  async resign(id: string, token: string) {
    return this.games.resign(id, token);
  }
  async draw(id: string, token: string, action: DrawAction) {
    if (action === 'accept') return this.games.acceptDraw(id, token);
    return action === 'decline' ? this.games.declineDraw(id, token) : this.games.offerDraw(id, token);
  }
  async abort(id: string, token: string) {
    return this.games.abort(id, token);
  }
  async pgn(id: string) {
    return this.games.pgn(id);
  }
  async preview(id: string, side: Side, moves: string[]) {
    return this.games.preview(id, side, moves).info;
  }
  async previewPng(id: string, side: Side, moves: string[], size?: number) {
    return this.games.preview(id, side, moves).png(size);
  }
  async boardPng(id: string, opts: { orientation?: Side; size?: number; ply?: number } = {}) {
    return this.games.boardPng(id, opts);
  }
}

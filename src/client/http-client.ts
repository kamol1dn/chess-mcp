import type {
  ApiErrorBody,
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
import type { ChessBackend, DrawAction } from './backend.js';

export class ChessApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly legalMoves?: string[],
  ) {
    super(message);
    this.name = 'ChessApiError';
  }
}

/** Typed client for the chess-mcp HTTP API. */
export class ChessClient implements ChessBackend {
  readonly publicUrl: string;

  constructor(
    readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.publicUrl = this.baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string; signal?: AbortSignal; raw?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (opts.token) headers['x-seat-token'] = opts.token;
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ChessApiError(0, 'unreachable', `Cannot reach the chess server at ${this.baseUrl} (${(err as Error).message}). Is it running? Start it with: npx chess-mcp serve`);
    }
    if (!res.ok) {
      let body: Partial<ApiErrorBody> = {};
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        /* non-JSON error */
      }
      throw new ChessApiError(res.status, body.error ?? 'http_error', body.message ?? `HTTP ${res.status}`, body.legalMoves);
    }
    if (opts.raw) return Buffer.from(await res.arrayBuffer()) as T;
    const type = res.headers.get('content-type') ?? '';
    return (type.includes('application/json') ? await res.json() : await res.text()) as T;
  }

  info() {
    return this.request<ServerInfo>('GET', '/api/info');
  }

  listGames(opts: { status?: 'active' | 'finished'; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.limit) q.set('limit', String(opts.limit));
    return this.request<GameSummary[]>('GET', `/api/games?${q}`);
  }

  getGame(id: string) {
    return this.request<GameView>('GET', `/api/games/${encodeURIComponent(id)}`);
  }

  createGame(req: CreateGameRequest) {
    return this.request<CreateGameResponse>('POST', '/api/games', { body: req });
  }

  claimSeat(id: string, side: Side, name?: string) {
    return this.request<ClaimSeatResponse>('POST', `/api/games/${encodeURIComponent(id)}/seats/${side}/claim`, {
      body: name ? { name } : {},
    });
  }

  turn(id: string, side: Side, token?: string) {
    return this.request<TurnInfo>('GET', `/api/games/${encodeURIComponent(id)}/turn?side=${side}`, { token });
  }

  wait(id: string, side: Side, token: string | undefined, timeoutMs: number, signal?: AbortSignal) {
    const t = Math.max(0, Math.min(300_000, Math.round(timeoutMs)));
    return this.request<TurnInfo>('GET', `/api/games/${encodeURIComponent(id)}/wait?side=${side}&timeoutMs=${t}`, { token, signal });
  }

  move(id: string, token: string, move: string, comment?: string) {
    return this.request<GameView>('POST', `/api/games/${encodeURIComponent(id)}/move`, { token, body: { move, comment } });
  }

  resign(id: string, token: string) {
    return this.request<GameView>('POST', `/api/games/${encodeURIComponent(id)}/resign`, { token, body: {} });
  }

  draw(id: string, token: string, action: DrawAction) {
    return this.request<GameView>('POST', `/api/games/${encodeURIComponent(id)}/draw`, { token, body: { action } });
  }

  abort(id: string, token: string) {
    return this.request<GameView>('POST', `/api/games/${encodeURIComponent(id)}/abort`, { token, body: {} });
  }

  pgn(id: string) {
    return this.request<string>('GET', `/api/games/${encodeURIComponent(id)}/pgn`);
  }

  preview(id: string, side: Side, moves: string[]) {
    const q = new URLSearchParams({ side, moves: moves.join(' ') });
    return this.request<PreviewInfo>('GET', `/api/games/${encodeURIComponent(id)}/preview?${q}`);
  }

  previewPng(id: string, side: Side, moves: string[], size?: number) {
    const q = new URLSearchParams({ side, moves: moves.join(' ') });
    if (size) q.set('size', String(size));
    return this.request<Buffer>('GET', `/api/games/${encodeURIComponent(id)}/preview.png?${q}`, { raw: true });
  }

  boardPng(id: string, opts: { orientation?: Side; size?: number; ply?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.orientation) q.set('orientation', opts.orientation);
    if (opts.size) q.set('size', String(opts.size));
    if (opts.ply !== undefined) q.set('ply', String(opts.ply));
    return this.request<Buffer>('GET', `/api/games/${encodeURIComponent(id)}/board.png?${q}`, { raw: true });
  }
}

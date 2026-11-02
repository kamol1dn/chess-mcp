import type {
  ClaimSeatResponse,
  CreateGameRequest,
  CreateGameResponse,
  GameSummary,
  GameView,
  ServerInfo,
  Side,
} from '../../src/shared/types';

const SEATS_KEY = 'chess-mcp:seats';
const API_KEY = 'chess-mcp:api-key';

type SeatStore = Record<string, Partial<Record<Side, string>>>;

function readSeats(): SeatStore {
  try {
    return JSON.parse(localStorage.getItem(SEATS_KEY) ?? '{}') as SeatStore;
  } catch {
    return {};
  }
}

export const seats = {
  get(gameId: string): Partial<Record<Side, string>> {
    return readSeats()[gameId] ?? {};
  },
  set(gameId: string, side: Side, token: string) {
    const all = readSeats();
    all[gameId] = { ...all[gameId], [side]: token };
    try {
      localStorage.setItem(SEATS_KEY, JSON.stringify(all));
    } catch {
      /* storage unavailable: the seat works until the page is reloaded */
    }
  },
};

export function getApiKey(): string | null {
  try {
    return localStorage.getItem(API_KEY);
  } catch {
    return null;
  }
}

export function setApiKey(key: string) {
  try {
    localStorage.setItem(API_KEY, key);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const key = getApiKey();
  if (key) headers.authorization = `Bearer ${key}`;
  if (token) headers['x-seat-token'] = token;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let data: { error?: string; message?: string } = {};
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  info: () => request<ServerInfo>('GET', '/api/info'),
  list: (status?: 'active' | 'finished', limit = 50) =>
    request<GameSummary[]>('GET', `/api/games?limit=${limit}${status ? `&status=${status}` : ''}`),
  get: (id: string) => request<GameView>('GET', `/api/games/${id}`),
  create: (req: CreateGameRequest) => request<CreateGameResponse>('POST', '/api/games', req),
  claim: (id: string, side: Side, name?: string) =>
    request<ClaimSeatResponse>('POST', `/api/games/${id}/seats/${side}/claim`, name ? { name } : {}),
  move: (id: string, token: string, move: string) => request<GameView>('POST', `/api/games/${id}/move`, { move }, token),
  resign: (id: string, token: string) => request<GameView>('POST', `/api/games/${id}/resign`, {}, token),
  abort: (id: string, token: string) => request<GameView>('POST', `/api/games/${id}/abort`, {}, token),
  draw: (id: string, token: string, action: 'offer' | 'accept' | 'decline') =>
    request<GameView>('POST', `/api/games/${id}/draw`, { action }, token),
  retry: (id: string, side: Side) => request<GameView>('POST', `/api/games/${id}/seats/${side}/retry`, {}),
  remove: (id: string) => request<void>('DELETE', `/api/games/${id}`),
};

/** Subscribes to live game updates over server-sent events. */
export function watchGame(id: string, onGame: (g: GameView) => void, onStatus: (connected: boolean) => void): () => void {
  const es = new EventSource(`/api/games/${id}/events`);
  es.addEventListener('game', (e) => {
    onStatus(true);
    onGame(JSON.parse((e as MessageEvent<string>).data) as GameView);
  });
  es.onerror = () => onStatus(false);
  es.onopen = () => onStatus(true);
  return () => es.close();
}

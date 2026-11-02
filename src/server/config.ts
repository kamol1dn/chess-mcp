import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  /** Externally reachable base URL, used in join instructions shown to agents. */
  publicUrl: string;
  /** SQLite file, or ":memory:". */
  dbFile: string;
  /** When set, creating games and claiming seats require `Authorization: Bearer <apiKey>`. */
  apiKey: string | null;
  logLevel: string;
  /** Write logs to stderr instead of stdout (required when sharing a process with a stdio MCP server). */
  logToStderr: boolean;
  /** Pause before automated players (engine / Claude) move, so spectators can follow. */
  moveDelayMs: number;
  /** Worker threads used by the built-in engine. */
  engineThreads: number;
  /** Max simultaneous active games kept in memory. */
  maxActiveGames: number;
  /** Abort games that saw no activity for this long (ms). 0 disables. */
  idleGameTimeoutMs: number;
  /** Serve the built web UI from this directory (null disables). */
  webDir: string | null;
  trustProxy: boolean;
  /** Requests per minute per IP for mutating endpoints. */
  rateLimitPerMinute: number;
  anthropicApiKeyPresent: boolean;
  /** Engine think time per position for the eval bar (0 disables). */
  analysisMs: number;
  /** Attempts an LLM player gets to produce a legal move before forfeiting. */
  llmMaxAttempts: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got '${v}'`);
  return n;
};

const bool = (v: string | undefined, d: boolean): boolean =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const port = overrides.port ?? num(env.PORT ?? env.CHESS_PORT, 8787);
  const host = overrides.host ?? env.HOST ?? env.CHESS_HOST ?? '127.0.0.1';
  const dataDir = env.CHESS_DATA_DIR ?? path.join(process.cwd(), 'data');
  const browserHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return {
    host,
    port,
    publicUrl: (env.CHESS_PUBLIC_URL ?? `http://${browserHost}:${port}`).replace(/\/+$/, ''),
    dbFile: env.CHESS_DB ?? path.join(dataDir, 'chess.db'),
    apiKey: env.CHESS_API_KEY || null,
    logLevel: env.LOG_LEVEL ?? 'info',
    logToStderr: false,
    moveDelayMs: num(env.CHESS_MOVE_DELAY_MS, 400),
    engineThreads: Math.max(1, num(env.CHESS_ENGINE_THREADS, Math.min(4, Math.max(1, os.availableParallelism() - 1)))),
    maxActiveGames: num(env.CHESS_MAX_ACTIVE_GAMES, 200),
    idleGameTimeoutMs: num(env.CHESS_IDLE_TIMEOUT_HOURS, 24) * 3_600_000,
    webDir: env.CHESS_WEB_DIR ?? null,
    trustProxy: bool(env.CHESS_TRUST_PROXY, false),
    rateLimitPerMinute: num(env.CHESS_RATE_LIMIT, 300),
    anthropicApiKeyPresent: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    llmMaxAttempts: num(env.CHESS_LLM_MAX_ATTEMPTS, 3),
    analysisMs: num(env.CHESS_ANALYSIS_MS, 300),
    ...overrides,
  };
}

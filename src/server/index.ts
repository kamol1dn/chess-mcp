import type { FastifyInstance } from 'fastify';
import { ClaudePlayer } from './claude-player.js';
import { type ServerConfig, loadConfig } from './config.js';
import { EnginePool } from './engine-pool.js';
import { GameManager } from './game-manager.js';
import { buildApp } from './http.js';
import { GameStore } from './store.js';

export interface RunningServer {
  app: FastifyInstance;
  games: GameManager;
  config: ServerConfig;
  url: string;
  close(): Promise<void>;
}

export async function startServer(overrides: Partial<ServerConfig> = {}): Promise<RunningServer> {
  const config = loadConfig(process.env, overrides);
  const store = new GameStore(config.dbFile);
  let app: FastifyInstance | null = null;
  const engine = new EnginePool(config.engineThreads, (err) => app?.log.error({ err }, 'engine worker error'));
  const games = new GameManager({
    store,
    engine,
    claude: new ClaudePlayer(),
    moveDelayMs: config.moveDelayMs,
    maxActiveGames: config.maxActiveGames,
    idleGameTimeoutMs: config.idleGameTimeoutMs,
    llmMaxAttempts: config.llmMaxAttempts,
    analysisMs: config.analysisMs,
    log: {
      info: (o, m) => app?.log.info(o, m),
      warn: (o, m) => app?.log.warn(o, m),
      error: (o, m) => app?.log.error(o, m),
    },
  });

  app = await buildApp({ config, games, engineQueue: () => engine.pending });
  games.start();
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host}:${port}`;
  if (!overrides.publicUrl && !process.env.CHESS_PUBLIC_URL && port !== config.port) config.publicUrl = url;
  app.log.info({ url, publicUrl: config.publicUrl, db: config.dbFile, auth: Boolean(config.apiKey) }, 'chess-mcp server ready');

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      await games.close();
      await app!.close();
      await engine.close();
      store.close();
    })());

  return { app, games, config, url, close };
}

/** Starts the server and wires SIGINT/SIGTERM to a graceful shutdown. */
export async function runServer(overrides: Partial<ServerConfig> = {}): Promise<void> {
  const server = await startServer(overrides);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await server.close();
      process.exit(0);
    } catch (err) {
      server.app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

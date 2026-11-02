import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { renderBoardSvg } from '../render/board-svg.js';
import { createMcpServer } from '../mcp/tools.js';
import type { ServerInfo, Side } from '../shared/types.js';
import { CLAUDE_MODELS } from './claude-player.js';
import type { ServerConfig } from './config.js';
import { ApiError, badRequest, unauthorized } from './errors.js';
import type { GameManager } from './game-manager.js';
import { LocalBackend } from './local-backend.js';

const VERSION = '1.0.0';

// ---- request schemas ----
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const name = z.string().trim().max(60).optional();
const playerSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), name }),
  z.object({ kind: z.literal('agent'), name }),
  z.object({ kind: z.literal('engine'), level: z.number().int().min(1).max(10), name }),
  z.object({ kind: z.literal('llm'), model: z.string().min(3).max(80), effort: effort.optional(), name }),
]);
const createGameBody = z.object({
  white: playerSpec,
  black: playerSpec,
  fen: z.string().max(120).optional(),
  timeControl: z
    .object({ initialMinutes: z.number().positive().max(1440), incrementSeconds: z.number().min(0).max(600) })
    .nullable()
    .optional(),
  claim: z.array(z.enum(['white', 'black'])).max(2).optional(),
});
const sideParam = z.enum(['white', 'black']);
const idParams = z.object({ id: z.string().min(1).max(64) });
const seatParams = idParams.extend({ side: sideParam });
const moveBody = z.object({ move: z.string().min(1).max(32), comment: z.string().max(500).optional(), token: z.string().optional() });
const drawBody = z.object({ action: z.enum(['offer', 'accept', 'decline']).default('offer'), token: z.string().optional() });
const tokenBody = z.object({ token: z.string().optional() }).optional();
const boardQuery = z.object({
  orientation: sideParam.optional(),
  size: z.coerce.number().int().min(128).max(2048).optional(),
  ply: z.coerce.number().int().min(0).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw badRequest(msg);
  }
  return r.data;
}

function defaultWebDir(): string | null {
  for (const rel of ['../web/', '../../dist/web/']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(dir + 'index.html')) return dir;
  }
  return null;
}

export interface AppDeps {
  config: ServerConfig;
  games: GameManager;
  engineQueue: () => number;
}

export async function buildApp({ config, games, engineQueue }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.logToStderr ? { stream: process.stderr } : {}),
      redact: ['req.headers.authorization', 'req.headers["x-seat-token"]'],
    },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    // Long-polls can legitimately last up to 5 minutes.
    requestTimeout: 0,
    connectionTimeout: 0,
    keepAliveTimeout: 65_000,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit, { global: false });

  const writeLimit = { rateLimit: { max: config.rateLimitPerMinute, timeWindow: '1 minute' } };

  const info = (): ServerInfo => ({
    name: 'chess-mcp',
    version: VERSION,
    authRequired: Boolean(config.apiKey),
    llmAvailable: config.anthropicApiKeyPresent,
    llmModels: CLAUDE_MODELS.map(({ id, label }) => ({ id, label })),
    publicUrl: config.publicUrl,
  });

  const requireApiKey = (req: FastifyRequest) => {
    if (!config.apiKey) return;
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(crypto.createHash('sha256').update(given).digest('hex'));
    const b = Buffer.from(crypto.createHash('sha256').update(config.apiKey).digest('hex'));
    if (!crypto.timingSafeEqual(a, b)) throw unauthorized();
  };

  const seatToken = (req: FastifyRequest, body?: { token?: string } | null): string => {
    const t = (req.headers['x-seat-token'] as string | undefined) ?? body?.token;
    if (!t) throw new ApiError(401, 'missing_token', 'Missing seat token (send it in the X-Seat-Token header).');
    return t;
  };

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof ApiError) {
      void reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
      return;
    }
    if (err.statusCode && err.statusCode < 500) {
      void reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    void reply.status(500).send({ error: 'internal', message: 'Internal server error' });
  });

  // ---------------------------------------------------------------- health & info
  app.get('/healthz', async () => ({ ok: true, version: VERSION, activeGames: games.activeCount, engineQueue: engineQueue() }));
  app.get('/api/info', async () => info());

  // ---------------------------------------------------------------- games
  app.get('/api/games', async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['active', 'finished']).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      req.query,
    );
    return games.list(q);
  });

  app.post('/api/games', { config: writeLimit }, async (req, reply) => {
    requireApiKey(req);
    const body = parse(createGameBody, req.body);
    const res = games.create(body);
    return reply.status(201).send(res);
  });

  app.get('/api/games/:id', async (req) => games.get(parse(idParams, req.params).id));

  app.delete('/api/games/:id', { config: writeLimit }, async (req, reply) => {
    requireApiKey(req);
    games.delete(parse(idParams, req.params).id);
    return reply.status(204).send();
  });

  app.post('/api/games/:id/admin/abort', { config: writeLimit }, async (req) => {
    requireApiKey(req);
    return games.adminAbort(parse(idParams, req.params).id);
  });

  app.get('/api/games/:id/pgn', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const download = (req.query as Record<string, string>).download;
    void reply.type('application/x-chess-pgn; charset=utf-8');
    if (download) void reply.header('content-disposition', `attachment; filename="chess-${id}.pgn"`);
    return games.pgn(id);
  });

  app.get('/api/games/:id/board.png', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const q = parse(boardQuery, req.query);
    const png = games.boardPng(id, q);
    return reply.type('image/png').header('cache-control', 'no-store').send(png);
  });

  app.get('/api/games/:id/board.svg', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const q = parse(boardQuery, req.query);
    const pos = games.position(id, q.ply);
    const svg = renderBoardSvg(pos.fen, { orientation: q.orientation, size: q.size, lastMove: pos.lastMove, check: pos.check });
    return reply.type('image/svg+xml').header('cache-control', 'no-store').send(svg);
  });

  // Server-sent events: a full game snapshot on every change.
  app.get('/api/games/:id/events', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const initial = games.get(id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (data: unknown) => res.write(`event: game\ndata: ${JSON.stringify(data)}\n\n`);
    send(initial);
    const unsubscribe = games.subscribe(id, send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    res.on('error', cleanup);
  });

  // ---------------------------------------------------------------- seats & play
  app.post('/api/games/:id/seats/:side/claim', { config: writeLimit }, async (req) => {
    requireApiKey(req);
    const { id, side } = parse(seatParams, req.params);
    const body = parse(z.object({ name }).optional(), req.body);
    const { token, game } = games.claim(id, side, body?.name);
    return { game, side, token };
  });

  app.post('/api/games/:id/seats/:side/retry', { config: writeLimit }, async (req) => {
    const { id, side } = parse(seatParams, req.params);
    return games.retry(id, side);
  });

  app.get('/api/games/:id/turn', async (req) => {
    const { id } = parse(idParams, req.params);
    const { side } = parse(z.object({ side: sideParam }), req.query);
    return games.turnInfo(id, side, req.headers['x-seat-token'] as string | undefined);
  });

  app.get('/api/games/:id/wait', async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(z.object({ side: sideParam, timeoutMs: z.coerce.number().int().min(0).max(300_000).default(55_000) }), req.query);
    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());
    return games.waitForTurn(id, q.side, req.headers['x-seat-token'] as string | undefined, q.timeoutMs, controller.signal);
  });

  app.post('/api/games/:id/move', { config: writeLimit }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(moveBody, req.body);
    return games.move(id, seatToken(req, body), body.move, body.comment);
  });

  app.post('/api/games/:id/resign', { config: writeLimit }, async (req) => {
    const { id } = parse(idParams, req.params);
    return games.resign(id, seatToken(req, parse(tokenBody, req.body)));
  });

  app.post('/api/games/:id/abort', { config: writeLimit }, async (req) => {
    const { id } = parse(idParams, req.params);
    return games.abort(id, seatToken(req, parse(tokenBody, req.body)));
  });

  app.post('/api/games/:id/draw', { config: writeLimit }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(drawBody, req.body ?? {});
    const token = seatToken(req, body);
    if (body.action === 'accept') return games.acceptDraw(id, token);
    if (body.action === 'decline') return games.declineDraw(id, token);
    return games.offerDraw(id, token);
  });

  // Hypothetical lines on a scratch board ("what does the board look like after these moves?").
  const previewQuery = z.object({
    side: sideParam.default('white'),
    moves: z.string().max(400).default(''),
    size: z.coerce.number().int().min(128).max(2048).optional(),
  });
  const splitMoves = (s: string) => s.split(/[\s,;]+/).map((m) => m.trim()).filter(Boolean);
  app.get('/api/games/:id/preview', async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(previewQuery, req.query);
    return games.preview(id, q.side, splitMoves(q.moves)).info;
  });
  app.get('/api/games/:id/preview.png', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const q = parse(previewQuery, req.query);
    const png = games.preview(id, q.side, splitMoves(q.moves)).png(q.size);
    return reply.type('image/png').header('cache-control', 'no-store').send(png);
  });

  app.get('/api/games/:id/side', async (req) => {
    const { id } = parse(idParams, req.params);
    return { side: games.sideForToken(id, seatToken(req)) as Side };
  });

  // ---------------------------------------------------------------- MCP (Streamable HTTP)
  const backend = new LocalBackend(games, config.publicUrl, info);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handleMcp = async (req: FastifyRequest, reply: FastifyReply) => {
    requireApiKey(req);
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId) throw new ApiError(404, 'unknown_session', 'Unknown MCP session. Reconnect to start a new one.');
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
        throw badRequest('No MCP session: send an initialize request first.');
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      const server = createMcpServer(backend);
      await server.connect(transport);
    }
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/mcp', { config: writeLimit }, handleMcp);
  app.get('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);
  app.addHook('onClose', async () => {
    await Promise.all([...transports.values()].map((t) => t.close().catch(() => {})));
  });

  // ---------------------------------------------------------------- web UI
  const webDir = config.webDir ?? defaultWebDir();
  if (webDir) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
      cacheControl: false,
      // Hashed bundles never change; index.html must always be revalidated so deploys take effect.
      setHeaders: (res, filePath) => {
        res.header('cache-control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // Client-side routes get the SPA shell; missing files (anything with an extension) get a real 404.
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/mcp') && !/\.[a-z0-9]+$/i.test(path)) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url} not found` });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send('<h1>chess-mcp</h1><p>The web UI has not been built. Run <code>npm run build</code>. The API is available under <code>/api</code>.</p>'),
    );
  }

  return app;
}

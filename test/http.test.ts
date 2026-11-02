import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { buildApp } from '../src/server/http.js';
import { makeManager } from './helpers.js';

let app: FastifyInstance;
let secured: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({}, { logLevel: 'silent', dbFile: ':memory:', webDir: null });
  app = await buildApp({ config, games: makeManager().games, engineQueue: () => 0 });
  secured = await buildApp({ config: { ...config, apiKey: 'sekret' }, games: makeManager().games, engineQueue: () => 0 });
});
afterAll(async () => {
  await app.close();
  await secured.close();
});

describe('HTTP API', () => {
  it('serves health and info', async () => {
    expect((await app.inject('/healthz')).json()).toMatchObject({ ok: true });
    expect((await app.inject('/api/info')).json()).toMatchObject({ name: 'chess-mcp', authRequired: false });
  });

  it('creates games, claims seats and plays moves', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { white: { kind: 'human' }, black: { kind: 'agent', name: 'Bot' }, claim: ['white'] },
    });
    expect(created.statusCode).toBe(201);
    const { game, tokens } = created.json();

    const claim = await app.inject({ method: 'POST', url: `/api/games/${game.id}/seats/black/claim`, payload: {} });
    expect(claim.statusCode).toBe(200);
    const blackToken = claim.json().token;
    expect((await app.inject({ method: 'POST', url: `/api/games/${game.id}/seats/black/claim`, payload: {} })).statusCode).toBe(409);

    const noToken = await app.inject({ method: 'POST', url: `/api/games/${game.id}/move`, payload: { move: 'e4' } });
    expect(noToken.statusCode).toBe(401);
    const moved = await app.inject({
      method: 'POST',
      url: `/api/games/${game.id}/move`,
      headers: { 'x-seat-token': tokens.white },
      payload: { move: 'e4' },
    });
    expect(moved.json().moves[0].san).toBe('e4');

    const illegal = await app.inject({
      method: 'POST',
      url: `/api/games/${game.id}/move`,
      headers: { 'x-seat-token': blackToken },
      payload: { move: 'e4' },
    });
    expect(illegal.statusCode).toBe(400);
    expect(illegal.json()).toMatchObject({ error: 'illegal_move' });
    expect(illegal.json().legalMoves).toContain('e5');

    const turn = await app.inject({ url: `/api/games/${game.id}/wait?side=black&timeoutMs=1000`, headers: { 'x-seat-token': blackToken } });
    expect(turn.json()).toMatchObject({ yourTurn: true, side: 'black' });
    expect(turn.json().text).toContain('Legal moves (20)');

    const png = await app.inject(`/api/games/${game.id}/board.png?orientation=black&size=256`);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const svg = await app.inject(`/api/games/${game.id}/board.svg?ply=0`);
    expect(svg.body.startsWith('<svg')).toBe(true);
    expect((await app.inject(`/api/games/${game.id}/pgn`)).body).toContain('1. e4 *');

    const list = (await app.inject('/api/games?status=active')).json();
    expect(list.map((g: { id: string }) => g.id)).toContain(game.id);
  });

  it('validates input', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/games', payload: { white: { kind: 'robot' }, black: { kind: 'agent' } } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject('/api/games/nope')).statusCode).toBe(404);
    expect((await app.inject('/api/games/nope/board.png?size=99999')).statusCode).toBe(400);
  });

  it('requires the API key for creating games when configured', async () => {
    const payload = { white: { kind: 'agent' }, black: { kind: 'engine', level: 1 } };
    expect((await secured.inject({ method: 'POST', url: '/api/games', payload })).statusCode).toBe(401);
    expect((await secured.inject({ method: 'POST', url: '/api/games', payload, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const ok = await secured.inject({ method: 'POST', url: '/api/games', payload, headers: { authorization: 'Bearer sekret' } });
    expect(ok.statusCode).toBe(201);
    // Spectating stays public.
    expect((await secured.inject(`/api/games/${ok.json().game.id}`)).statusCode).toBe(200);
  });
});

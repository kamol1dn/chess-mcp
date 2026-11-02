import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/tools.js';
import { LocalBackend } from '../src/server/local-backend.js';
import type { ServerInfo } from '../src/shared/types.js';
import { makeManager } from './helpers.js';

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

async function connect(backend: LocalBackend) {
  const server = createMcpServer(backend);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Content; isError?: boolean };
    return { ...r, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
  };
  return { client, call };
}

describe('MCP tools', () => {
  const { games } = makeManager();
  const backend = new LocalBackend(games, 'http://chess.test', () => ({}) as ServerInfo);

  it('lets two agents play each other through join_game / wait_for_turn / make_move', async () => {
    const alice = await connect(backend);
    const bob = await connect(backend);

    const tools = await alice.client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['new_game', 'join_game', 'wait_for_turn', 'make_move', 'get_board', 'resign', 'offer_draw', 'list_games']),
    );

    const created = await alice.call('new_game', { my_side: 'white', opponent: 'agent', my_name: 'Alice' });
    const id = /Created game (\S+)\./.exec(created.text)![1];
    expect(created.text).toContain(`http://chess.test/#/game/${id}`);

    const joined = await bob.call('join_game', { game_id: id, name: 'Bob' });
    expect(joined.text).toContain('as black');

    const bobWaits = bob.call('wait_for_turn', { game_id: id, timeout_seconds: 10 });
    const aliceTurn = await alice.call('wait_for_turn', { game_id: id, timeout_seconds: 5 });
    expect(aliceTurn.text).toContain('It is YOUR move');
    const image = aliceTurn.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');

    const preview = await alice.call('preview_line', { game_id: id, moves: ['e4', 'd5'] });
    expect(preview.text).toContain('PREVIEW ONLY');
    expect(preview.text).toContain('e4 attacked by d5');
    expect(preview.text).toMatch(/Your captures and checks available now: .*Bb5\+.*exd5/);
    expect(preview.content.some((c) => c.type === 'image')).toBe(true);
    expect(games.get(id).moves).toHaveLength(0);

    const bad = await alice.call('make_move', { game_id: id, move: 'Nf6' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Legal moves');
    expect((await alice.call('make_move', { game_id: id, move: 'f3', comment: 'bold' })).text).toContain('You played f3');

    const bobTurn = await bobWaits;
    expect(bobTurn.text).toContain('Last move: White played 1. f3');
    expect(bobTurn.text).toContain(`Opponent's note: "bold"`);
    await bob.call('make_move', { game_id: id, move: 'e5' });
    await alice.call('make_move', { game_id: id, move: 'g4' });
    const mate = await bob.call('make_move', { game_id: id, move: 'Qh4#' });
    expect(mate.text).toContain('GAME OVER: Black wins by checkmate');

    const after = await alice.call('wait_for_turn', { game_id: id, timeout_seconds: 1 });
    expect(after.text).toContain('GAME OVER');
    expect((await alice.call('get_pgn', { game_id: id })).text).toContain('2. g4 Qh4# 0-1');
  });

  it('reports a timeout as "still waiting" and explains missing seats', async () => {
    const carol = await connect(backend);
    const created = await carol.call('new_game', { my_side: 'black', opponent: 'human' });
    const id = /Created game (\S+)\./.exec(created.text)![1];
    expect((await carol.call('wait_for_turn', { game_id: id, timeout_seconds: 0 })).text).toContain('Still waiting');
    const stranger = await connect(backend);
    const res = await stranger.call('make_move', { game_id: id, move: 'e5' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('have not joined');
  });
});

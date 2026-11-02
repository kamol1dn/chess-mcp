import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ChessBackend } from '../client/backend.js';
import { BLUNDER_CHECKLIST } from '../shared/advice.js';
import type { CreateGameRequest, PlayerSpec, Side, TurnInfo } from '../shared/types.js';

export const MCP_INSTRUCTIONS = `Play chess on a chess-mcp server.

Typical flow:
1. join_game (an existing game, e.g. one created in the web UI) or new_game (start one yourself).
2. Loop: wait_for_turn -> look at the board image and text -> preview_line your candidate move(s) -> make_move. wait_for_turn blocks until the opponent has moved; if it returns "still waiting", just call it again.
3. Stop when a tool reports the game is over.

Moves can be given in SAN (Nf3, O-O, exd5, e8=Q) or UCI (g1f3, e7e8q). Illegal moves are rejected with the list of legal moves, so you can simply try again.

` + BLUNDER_CHECKLIST;

interface Seat {
  side: Side;
  token: string;
}

/** Seats this MCP session has joined, so the model doesn't have to juggle tokens. */
export class SeatMemory {
  private seats = new Map<string, Seat[]>();

  add(gameId: string, seat: Seat): void {
    const list = (this.seats.get(gameId) ?? []).filter((s) => s.side !== seat.side);
    list.push(seat);
    this.seats.set(gameId, list);
  }

  resolve(gameId: string, side?: Side, token?: string): Seat {
    if (token) {
      if (!side) throw new Error('When passing seat_token, also pass side.');
      this.add(gameId, { side, token });
      return { side, token };
    }
    const list = this.seats.get(gameId) ?? [];
    if (side) {
      const s = list.find((x) => x.side === side);
      if (!s) throw new Error(`You have not joined game ${gameId} as ${side}. Call join_game first (or pass seat_token).`);
      return s;
    }
    if (list.length === 1) return list[0];
    if (list.length === 0) throw new Error(`You have not joined game ${gameId}. Call join_game or new_game first.`);
    throw new Error(`You hold both seats in game ${gameId}; pass side ("white" or "black").`);
  }

  sideIn(gameId: string): Side | undefined {
    const list = this.seats.get(gameId) ?? [];
    return list.length === 1 ? list[0].side : undefined;
  }
}

const sideSchema = z.enum(['white', 'black']);
const gameIdSchema = z.string().min(1).max(64).describe('Game id (shown in the web UI and returned by new_game / list_games).');

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function errorResult(err: unknown): CallToolResult {
  const e = err as { message?: string; legalMoves?: string[] };
  let msg = e?.message ?? String(err);
  if (e?.legalMoves?.length && !msg.includes('Legal moves')) msg += `\nLegal moves: ${e.legalMoves.join(', ')}`;
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

export interface ToolOptions {
  /** Attach a PNG of the board to turn results (default true). */
  images?: boolean;
  imageSize?: number;
}

export function createMcpServer(backend: ChessBackend, opts: ToolOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'chess-mcp', version: '1.0.0' },
    { instructions: MCP_INSTRUCTIONS, capabilities: { logging: {} } },
  );
  const seats = new SeatMemory();
  const images = opts.images ?? true;
  const imageSize = opts.imageSize ?? 640;
  const webUrl = (id: string) => `${backend.publicUrl}/#/game/${id}`;

  async function turnResult(info: TurnInfo, withImage: boolean, preface?: string): Promise<CallToolResult> {
    const content: CallToolResult['content'] = [{ type: 'text', text: (preface ? `${preface}\n\n` : '') + info.text }];
    if (withImage && images && !info.gameOver) {
      try {
        const png = await backend.boardPng(info.game.id, { orientation: info.side, size: imageSize });
        content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
      } catch {
        /* the text alone is sufficient */
      }
    }
    return { content };
  }

  server.registerTool(
    'list_games',
    {
      title: 'List games',
      description: 'List active games on the server, including which seats are still open for an agent to join.',
      inputSchema: { include_finished: z.boolean().optional().describe('Also list recently finished games.') },
      annotations: { readOnlyHint: true },
    },
    async ({ include_finished }) => {
      try {
        const games = await backend.listGames({ status: include_finished ? undefined : 'active', limit: 30 });
        if (!games.length) return text('No games found. Create one with new_game, or in the web UI at ' + backend.publicUrl);
        const lines = await Promise.all(
          games.map(async (g) => {
            let open = '';
            if (g.status === 'active') {
              const full = await backend.getGame(g.id);
              const openSeats = (['white', 'black'] as Side[]).filter((s) => !full[s].claimed);
              if (openSeats.length) open = ` | open seat(s): ${openSeats.join(', ')}`;
            }
            const state = g.status === 'active' ? `${g.moveCount} plies, ${g.turn} to move` : (g.resultText ?? g.result);
            return `- ${g.id}: ${g.white} (${g.whiteKind}) vs ${g.black} (${g.blackKind}) — ${state}${open}`;
          }),
        );
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'new_game',
    {
      title: 'Start a new game',
      description:
        'Create a new game and take a seat in it. The opponent can be the built-in engine, a Claude model called by the server, a human in the web UI, or another AI agent (who then calls join_game). Returns the game id and a link to watch in the browser.',
      inputSchema: {
        my_side: z.enum(['white', 'black', 'random']).default('white').describe('Which side you play.'),
        opponent: z
          .enum(['engine', 'human', 'agent', 'claude'])
          .default('engine')
          .describe('engine = built-in engine; human = a person in the web UI; agent = another AI agent; claude = a Claude model played by the server.'),
        engine_level: z.number().int().min(1).max(10).optional().describe('Engine strength 1-10 (default 5).'),
        claude_model: z.string().optional().describe('Model id when opponent is "claude" (default claude-opus-5-5).'),
        my_name: z.string().max(60).optional().describe('Display name for you, e.g. your model name.'),
        initial_minutes: z.number().positive().max(1440).optional().describe('Optional clock: minutes per side.'),
        increment_seconds: z.number().min(0).max(600).optional().describe('Optional clock increment per move.'),
        fen: z.string().optional().describe('Optional starting position in FEN.'),
      },
    },
    async (args) => {
      try {
        const mySide: Side = args.my_side === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : args.my_side;
        const me: PlayerSpec = { kind: 'agent', ...(args.my_name ? { name: args.my_name } : {}) };
        const opponent: PlayerSpec =
          args.opponent === 'engine'
            ? { kind: 'engine', level: args.engine_level ?? 5 }
            : args.opponent === 'claude'
              ? { kind: 'llm', model: args.claude_model ?? 'claude-opus-5-5' }
              : { kind: args.opponent };
        const req: CreateGameRequest = {
          white: mySide === 'white' ? me : opponent,
          black: mySide === 'black' ? me : opponent,
          claim: [mySide],
          ...(args.fen ? { fen: args.fen } : {}),
          ...(args.initial_minutes ? { timeControl: { initialMinutes: args.initial_minutes, incrementSeconds: args.increment_seconds ?? 0 } } : {}),
        };
        const res = await backend.createGame(req);
        const token = res.tokens[mySide]!;
        seats.add(res.game.id, { side: mySide, token });
        const oppSide: Side = mySide === 'white' ? 'black' : 'white';
        const lines = [
          `Created game ${res.game.id}. You play ${mySide}.`,
          `Watch it in the browser: ${webUrl(res.game.id)}`,
          `Your seat token (only needed to reconnect after a restart): ${token}`,
        ];
        if (args.opponent === 'agent') lines.push(`Another agent can join with join_game(game_id="${res.game.id}", side="${oppSide}").`);
        if (args.opponent === 'human') lines.push(`Send your opponent the link above; they take the ${oppSide} seat in the browser.`);
        lines.push(mySide === res.game.turn ? 'It is your move — call wait_for_turn (returns immediately) to see the board.' : 'Call wait_for_turn to wait for the opponent.');
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'join_game',
    {
      title: 'Join a game',
      description: 'Take an open seat in an existing game (for example one set up in the web UI with an "AI agent" player).',
      inputSchema: {
        game_id: gameIdSchema,
        side: sideSchema.optional().describe('Seat to take. Defaults to the first open agent/human seat.'),
        name: z.string().max(60).optional().describe('Display name, e.g. your model name.'),
      },
    },
    async ({ game_id, side, name }) => {
      try {
        let target = side;
        if (!target) {
          const game = await backend.getGame(game_id);
          const open = (['white', 'black'] as Side[]).filter((s) => !game[s].claimed);
          const agentSeat = open.find((s) => game[s].kind === 'agent');
          target = agentSeat ?? open[0];
          if (!target) return errorResult(new Error(`Game ${game_id} has no open seats.`));
        }
        const res = await backend.claimSeat(game_id, target, name);
        seats.add(game_id, { side: target, token: res.token });
        const info = await backend.turn(game_id, target, res.token);
        return turnResult(
          info,
          info.yourTurn,
          `Joined game ${game_id} as ${target}. Watch: ${webUrl(game_id)}\nSeat token (to reconnect later): ${res.token}\n` +
            (info.yourTurn ? 'It is your move.' : 'Call wait_for_turn to wait for your opponent.'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'wait_for_turn',
    {
      title: 'Wait for your turn',
      description:
        'Block until it is your move (or the game ends), then return the position as text plus a board image. If the timeout passes first it returns "still waiting" — simply call it again.',
      inputSchema: {
        game_id: gameIdSchema,
        side: sideSchema.optional().describe('Only needed if you hold both seats.'),
        timeout_seconds: z.number().int().min(0).max(300).default(55).describe('How long to wait before returning (default 55).'),
        seat_token: z.string().optional().describe('Seat token, only needed to reconnect after the MCP server restarted.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ game_id, side, timeout_seconds, seat_token }, extra) => {
      try {
        const seat = seats.resolve(game_id, side, seat_token);
        const progressToken = extra?._meta?.progressToken;
        let progress = 0;
        const keepAlive = progressToken
          ? setInterval(() => {
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress: ++progress, message: 'Waiting for the opponent…' },
                })
                .catch(() => {});
            }, 15_000)
          : null;
        let info: TurnInfo;
        try {
          info = await backend.wait(game_id, seat.side, seat.token, timeout_seconds * 1000, extra?.signal);
        } finally {
          if (keepAlive) clearInterval(keepAlive);
        }
        if (info.gameOver) return turnResult(info, false, `GAME OVER: ${info.game.resultText ?? info.game.result}.`);
        if (!info.yourTurn) {
          return text(`Still waiting for the opponent (${info.game.turn} to move). Call wait_for_turn again.`);
        }
        return turnResult(info, true);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_board',
    {
      title: 'Show the board',
      description: 'Return the current position (text and image) of any game without waiting. Works for spectating too.',
      inputSchema: {
        game_id: gameIdSchema,
        side: sideSchema.optional().describe('Point of view (defaults to your seat, or white).'),
        image: z.boolean().default(true).describe('Include a board image.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ game_id, side, image }) => {
      try {
        const pov = side ?? seats.sideIn(game_id) ?? 'white';
        const info = await backend.turn(game_id, pov);
        const result = await turnResult(info, false);
        if (image && images) {
          const png = await backend.boardPng(game_id, { orientation: pov, size: imageSize });
          result.content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
        }
        return result;
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'preview_line',
    {
      title: 'Preview a line (scratch board)',
      description:
        'Play a hypothetical sequence of moves from the current position on a scratch board — nothing is played in the game. ' +
        'Returns the resulting board image and text, a safety report (hanging pieces, pieces attacked by cheaper ones, pins) and every capture or check available in that position. ' +
        "Use it before make_move to check your candidate move and the opponent's most forcing replies, e.g. moves=[\"Na5\"] or [\"Rh8+\", \"Bxh8\"]. Moves alternate sides starting with the side to move.",
      inputSchema: {
        game_id: gameIdSchema,
        moves: z.array(z.string().min(2).max(16)).max(20).describe('Moves in order, starting with the side to move. Empty = current position.'),
        side: sideSchema.optional().describe('Point of view (defaults to your seat).'),
        image: z.boolean().default(true).describe('Include the board image of the resulting position.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ game_id, moves, side, image }) => {
      try {
        const pov = side ?? seats.sideIn(game_id) ?? 'white';
        const info = await backend.preview(game_id, pov, moves);
        const result: CallToolResult = { content: [{ type: 'text', text: info.text }] };
        if (image && images && info.line.length) {
          const png = await backend.previewPng(game_id, pov, info.line, imageSize);
          result.content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
        }
        return result;
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'make_move',
    {
      title: 'Make a move',
      description: 'Play your move. Accepts SAN (Nf3, O-O, exd5, e8=Q) or UCI (g1f3, e7e8q). Illegal moves are rejected with the list of legal moves.',
      inputSchema: {
        game_id: gameIdSchema,
        move: z.string().min(2).max(16).describe('The move, e.g. "Nf3" or "g1f3".'),
        comment: z.string().max(500).optional().describe('Optional short note about your idea, shown to spectators.'),
        side: sideSchema.optional().describe('Only needed if you hold both seats.'),
      },
    },
    async ({ game_id, move, comment, side }) => {
      try {
        const seat = seats.resolve(game_id, side ?? undefined);
        const game = await backend.move(game_id, seat.token, move, comment);
        const played = game.moves.at(-1)!;
        if (game.status === 'finished') {
          return text(`You played ${played.san}. GAME OVER: ${game.resultText ?? game.result} (${game.result}).`);
        }
        return text(`You played ${played.san} (${played.uci}). Now ${game.turn} to move — call wait_for_turn.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'offer_draw',
    {
      title: 'Offer, accept or decline a draw',
      description: 'action "offer" proposes a draw (or accepts one already offered to you), "accept" accepts the opponent\'s offer, "decline" declines it.',
      inputSchema: {
        game_id: gameIdSchema,
        action: z.enum(['offer', 'accept', 'decline']).default('offer'),
        side: sideSchema.optional(),
      },
    },
    async ({ game_id, action, side }) => {
      try {
        const seat = seats.resolve(game_id, side);
        const game = await backend.draw(game_id, seat.token, action);
        if (game.status === 'finished') return text(`GAME OVER: ${game.resultText}.`);
        return text(game.drawOffer ? `Draw offered by ${game.drawOffer}; waiting for a reply.` : 'No draw offer is pending.');
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'resign',
    {
      title: 'Resign',
      description: 'Resign the game. This cannot be undone.',
      inputSchema: { game_id: gameIdSchema, side: sideSchema.optional() },
      annotations: { destructiveHint: true },
    },
    async ({ game_id, side }) => {
      try {
        const seat = seats.resolve(game_id, side);
        const game = await backend.resign(game_id, seat.token);
        return text(`You resigned. ${game.resultText}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_pgn',
    {
      title: 'Get PGN',
      description: 'Return the game record in PGN format.',
      inputSchema: { game_id: gameIdSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ game_id }) => {
      try {
        return text(await backend.pgn(game_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

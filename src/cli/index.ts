#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { ChessApiError, ChessClient } from '../client/http-client.js';
import { ChessGame } from '../engine/game.js';
import { Searcher, levelLimits } from '../engine/search.js';
import type { CreateGameRequest, Effort, PlayerSpec, Side, TurnInfo } from '../shared/types.js';
import { imageDir, runAgentBridge, saveBoardImage } from './agent-bridge.js';
import { findSeat, saveSeat } from './seats.js';

const DEFAULT_SERVER = process.env.CHESS_SERVER_URL ?? 'http://localhost:8787';

const program = new Command()
  .name('chess-mcp')
  .description('Chess server, MCP server and CLI. Each side can be a human (web), the built-in engine, Claude, or any AI agent.')
  .version('1.0.0')
  .addOption(new Option('-s, --server <url>', 'chess server URL').env('CHESS_SERVER_URL').default(DEFAULT_SERVER))
  .addOption(new Option('--api-key <key>', 'server API key (if the server requires one)').env('CHESS_API_KEY'));

const client = () => {
  const o = program.opts<{ server: string; apiKey?: string }>();
  return new ChessClient(o.server, o.apiKey);
};
const serverUrl = () => program.opts<{ server: string }>().server.replace(/\/+$/, '');

const sideOption = () => new Option('--side <side>', 'your side').choices(['white', 'black']);

/** Parses "human", "agent", "engine:7", "claude", "claude:claude-sonnet-5-5:high". */
export function parsePlayer(spec: string, name?: string): PlayerSpec {
  const [kind, a, b] = spec.split(':');
  const n = name ? { name } : {};
  switch (kind) {
    case 'human':
    case 'agent':
      return { kind, ...n };
    case 'engine':
      return { kind: 'engine', level: a ? Number(a) : 5, ...n };
    case 'claude':
    case 'llm':
      return { kind: 'llm', model: a || 'claude-opus-5-5', ...(b ? { effort: b as Effort } : {}), ...n };
    default:
      throw new Error(`Unknown player '${spec}'. Use human, agent, engine[:level], or claude[:model[:effort]].`);
  }
}

function printTurn(info: TurnInfo, imagePath?: string) {
  const header = info.gameOver
    ? `=== GAME OVER: ${info.game.resultText ?? info.game.result} (${info.game.result}) ===`
    : info.yourTurn
      ? `=== YOUR TURN — game ${info.game.id}, you are ${info.side} ===`
      : `=== Waiting for ${info.game.turn} — game ${info.game.id} ===`;
  console.log(header);
  console.log(info.text);
  if (imagePath) console.log(`\nBoard image: ${imagePath}`);
  if (info.yourTurn) console.log(`\nMake your move with: chess-mcp move ${info.game.id} <move>${info.side ? ` --side ${info.side}` : ''}`);
}

async function main() {
  program
    .command('serve')
    .description('Run the chess server (HTTP API, web UI and MCP endpoint at /mcp).')
    .option('-p, --port <port>', 'port (env PORT)', (v) => Number(v))
    .option('-H, --host <host>', 'bind address (env HOST)')
    .option('--db <file>', 'SQLite database file (env CHESS_DB)')
    .action(async (opts: { port?: number; host?: string; db?: string }) => {
      const { runServer } = await import('../server/index.js');
      await runServer({
        ...(opts.port ? { port: opts.port } : {}),
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.db ? { dbFile: opts.db } : {}),
      });
    });

  program
    .command('mcp')
    .description('Run an MCP server over stdio (for Claude Code / Claude Desktop). Starts a local chess server if none is running.')
    .option('--no-images', 'do not attach board images to tool results')
    .option('--no-auto-start', 'never start an embedded chess server')
    .action(async (opts: { images: boolean; autoStart: boolean }) => {
      const { runStdioMcp } = await import('../mcp/stdio.js');
      await runStdioMcp({ serverUrl: serverUrl(), apiKey: program.opts().apiKey, images: opts.images, autoStart: opts.autoStart });
    });

  program
    .command('new')
    .description('Create a game. Players: human | agent | engine[:1-10] | claude[:model[:effort]]')
    .option('-w, --white <player>', 'white player', 'agent')
    .option('-b, --black <player>', 'black player', 'engine:5')
    .option('--white-name <name>')
    .option('--black-name <name>')
    .option('-t, --time <control>', 'clock, e.g. 5+3 (minutes+seconds)')
    .option('--fen <fen>', 'starting position')
    .addOption(new Option('--join <side>', 'take this seat yourself (default: the first agent seat)').choices(['white', 'black', 'none']))
    .action(async (opts) => {
      const req: CreateGameRequest = {
        white: parsePlayer(opts.white, opts.whiteName),
        black: parsePlayer(opts.black, opts.blackName),
        ...(opts.fen ? { fen: opts.fen } : {}),
      };
      if (opts.time) {
        const m = /^(\d+(?:\.\d+)?)(?:\+(\d+))?$/.exec(opts.time);
        if (!m) throw new Error('Time control must look like 5+3');
        req.timeControl = { initialMinutes: Number(m[1]), incrementSeconds: Number(m[2] ?? 0) };
      }
      const join: Side | undefined =
        opts.join === 'none' ? undefined : (opts.join ?? (['white', 'black'] as Side[]).find((s) => req[s].kind === 'agent'));
      if (join) req.claim = [join];
      const res = await client().createGame(req);
      const id = res.game.id;
      console.log(`Created game ${id}: ${res.game.white.name} vs ${res.game.black.name}`);
      console.log(`Watch: ${serverUrl()}/#/game/${id}`);
      for (const [side, token] of Object.entries(res.tokens) as Array<[Side, string]>) {
        saveSeat(serverUrl(), id, side, token);
        console.log(`You hold the ${side} seat. Next: chess-mcp wait ${id}`);
      }
    });

  program
    .command('list')
    .description('List games')
    .option('-a, --all', 'include finished games')
    .action(async (opts: { all?: boolean }) => {
      const games = await client().listGames({ status: opts.all ? undefined : 'active', limit: 50 });
      if (!games.length) return console.log('No games.');
      for (const g of games) {
        const state = g.status === 'active' ? `${g.turn} to move, ${g.moveCount} plies` : (g.resultText ?? g.result);
        console.log(`${g.id}  ${g.white} (${g.whiteKind}) vs ${g.black} (${g.blackKind})  —  ${state}`);
      }
    });

  program
    .command('join <game>')
    .description('Claim a seat in a game; the seat token is saved under ~/.chess-mcp')
    .addOption(sideOption())
    .option('-n, --name <name>', 'display name')
    .action(async (gameId: string, opts: { side?: Side; name?: string }) => {
      const c = client();
      let side = opts.side;
      if (!side) {
        const game = await c.getGame(gameId);
        const open = (['white', 'black'] as Side[]).filter((s) => !game[s].claimed);
        side = open.find((s) => game[s].kind === 'agent') ?? open[0];
        if (!side) throw new Error('No open seats in this game.');
      }
      const res = await c.claimSeat(gameId, side, opts.name);
      saveSeat(serverUrl(), gameId, side, res.token);
      console.log(`Joined game ${gameId} as ${side}. Next: chess-mcp wait ${gameId}`);
    });

  program
    .command('wait <game>')
    .description('Block until it is your turn (or the game ends), then print the position and save a board image. Exit code 0 = your turn, 3 = game over, 2 = timed out.')
    .addOption(sideOption())
    .option('--timeout <seconds>', 'give up after this many seconds (0 = wait forever)', (v) => Number(v), 0)
    .option('--no-image', 'do not save a board image')
    .action(async (gameId: string, opts: { side?: Side; timeout: number; image: boolean }) => {
      const c = client();
      const seat = findSeat(serverUrl(), gameId, opts.side);
      const deadline = opts.timeout > 0 ? Date.now() + opts.timeout * 1000 : Infinity;
      for (;;) {
        const remaining = deadline - Date.now();
        let info: TurnInfo;
        try {
          info = await c.wait(gameId, seat.side, seat.token, Math.min(120_000, Math.max(0, remaining)));
        } catch (err) {
          if (err instanceof ChessApiError && err.status === 0 && remaining > 5000) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw err;
        }
        if (info.gameOver) {
          printTurn(info);
          process.exitCode = 3;
          return;
        }
        if (info.yourTurn) {
          printTurn(info, opts.image ? await saveBoardImage(c, info) : undefined);
          return;
        }
        if (Date.now() >= deadline) {
          console.log(`Still waiting for ${info.game.turn} to move. Run this command again to keep waiting.`);
          process.exitCode = 2;
          return;
        }
      }
    });

  program
    .command('move <game> <move>')
    .description('Play a move (SAN like Nf3 or UCI like g1f3)')
    .addOption(sideOption())
    .option('-c, --comment <text>', 'short note shown to spectators')
    .action(async (gameId: string, move: string, opts: { side?: Side; comment?: string }) => {
      const seat = findSeat(serverUrl(), gameId, opts.side);
      const game = await client().move(gameId, seat.token, move, opts.comment);
      const played = game.moves.at(-1)!;
      if (game.status === 'finished') {
        console.log(`Played ${played.san}. GAME OVER: ${game.resultText} (${game.result})`);
      } else {
        console.log(`Played ${played.san}. ${game.turn} to move. Next: chess-mcp wait ${gameId}`);
      }
    });

  program
    .command('board <game>')
    .description('Show the current position; optionally save the board image')
    .addOption(sideOption())
    .option('-o, --out <file>', 'write a PNG of the board to this file')
    .action(async (gameId: string, opts: { side?: Side; out?: string }) => {
      const c = client();
      let side = opts.side;
      if (!side) {
        try {
          side = findSeat(serverUrl(), gameId).side;
        } catch {
          side = 'white';
        }
      }
      const info = await c.turn(gameId, side);
      let image: string | undefined;
      if (opts.out) {
        image = path.resolve(opts.out);
        fs.writeFileSync(image, await c.boardPng(gameId, { orientation: side }));
      }
      printTurn(info, image);
    });

  program
    .command('preview <game> [moves...]')
    .description('Play a hypothetical line on a scratch board (nothing is played) and show the resulting position, a safety report and a board image')
    .addOption(sideOption())
    .option('--no-image', 'do not save a board image')
    .action(async (gameId: string, moves: string[], opts: { side?: Side; image: boolean }) => {
      const c = client();
      let side = opts.side;
      if (!side) {
        try {
          side = findSeat(serverUrl(), gameId).side;
        } catch {
          side = 'white';
        }
      }
      const info = await c.preview(gameId, side, moves);
      console.log(info.text);
      if (opts.image) {
        const file = path.join(imageDir(), `${gameId}-preview-${side}-${Date.now()}.png`);
        fs.writeFileSync(file, await c.previewPng(gameId, side, info.line));
        console.log(`\nBoard image of the resulting position: ${file}`);
      }
      if (!info.ok) process.exitCode = 4;
    });

  program
    .command('resign <game>')
    .addOption(sideOption())
    .action(async (gameId: string, opts: { side?: Side }) => {
      const seat = findSeat(serverUrl(), gameId, opts.side);
      const game = await client().resign(gameId, seat.token);
      console.log(game.resultText);
    });

  program
    .command('draw <game> [action]')
    .description('offer | accept | decline a draw')
    .addOption(sideOption())
    .action(async (gameId: string, action = 'offer', opts: { side?: Side }) => {
      if (!['offer', 'accept', 'decline'].includes(action)) throw new Error('action must be offer, accept or decline');
      const seat = findSeat(serverUrl(), gameId, opts.side);
      const game = await client().draw(gameId, seat.token, action as 'offer' | 'accept' | 'decline');
      console.log(game.status === 'finished' ? game.resultText : game.drawOffer ? `Draw offered by ${game.drawOffer}.` : 'No draw offer pending.');
    });

  program
    .command('pgn <game>')
    .description('Print the game in PGN')
    .action(async (gameId: string) => {
      process.stdout.write(await client().pgn(gameId));
    });

  program
    .command('agent <game>')
    .description(
      'Play a seat by waking an external CLI agent on every turn. The prompt (position, legal moves, image path) goes to the command on stdin; ' +
        'the agent must answer with "MOVE: <move>". Placeholders: {image} = board PNG path, {prompt_file} = prompt text file.',
    )
    .requiredOption('-e, --exec <command>', 'command to run each turn, e.g. "claude -p --allowedTools Read"')
    .addOption(sideOption())
    .option('-n, --name <name>', 'display name when joining')
    .option('--max-attempts <n>', 'tries per turn before resigning', (v) => Number(v), 3)
    .option('--turn-timeout <seconds>', 'max seconds per agent run', (v) => Number(v), 900)
    .action(async (gameId: string, opts: { exec: string; side?: Side; name?: string; maxAttempts: number; turnTimeout: number }) => {
      const c = client();
      let seat: { side: Side; token: string };
      try {
        seat = findSeat(serverUrl(), gameId, opts.side);
      } catch {
        const game = await c.getGame(gameId);
        const open = (['white', 'black'] as Side[]).filter((s) => !game[s].claimed && (!opts.side || s === opts.side));
        const side = open.find((s) => game[s].kind === 'agent') ?? open[0];
        if (!side) throw new Error('No open seat to join in this game.');
        const res = await c.claimSeat(gameId, side, opts.name);
        saveSeat(serverUrl(), gameId, side, res.token);
        seat = { side, token: res.token };
      }
      const log = (m: string) => console.error(`[${new Date().toLocaleTimeString()}] ${seat.side}: ${m}`);
      log(`playing game ${gameId} — watch at ${serverUrl()}/#/game/${gameId}`);
      const final = await runAgentBridge({
        client: c,
        gameId,
        side: seat.side,
        token: seat.token,
        exec: opts.exec,
        maxAttempts: opts.maxAttempts,
        turnTimeoutMs: opts.turnTimeout * 1000,
        log,
      });
      console.log(final.game.resultText ?? final.game.result);
    });

  program
    .command('analyze <fen...>')
    .description('Ask the built-in engine for the best move in a position (offline, no server needed)')
    .option('-l, --level <n>', 'strength 1-10', (v) => Number(v), 9)
    .option('--time <ms>', 'think time in ms', (v) => Number(v))
    .action((fenParts: string[], opts: { level: number; time?: number }) => {
      const game = new ChessGame(fenParts.join(' '));
      const limits = levelLimits(opts.level);
      if (opts.time) limits.timeMs = opts.time;
      const r = new Searcher().search(game.pos, limits);
      const score = r.mateIn !== null ? `mate in ${r.mateIn}` : `${(r.score / 100).toFixed(2)} (side to move)`;
      console.log(`best: ${r.san} (${r.uci})  score: ${score}  depth: ${r.depth}  nodes: ${r.nodes}  pv: ${r.pv.join(' ')}`);
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof ChessApiError) {
    console.error(`Error: ${err.message}`);
    if (err.legalMoves?.length && !err.message.includes('Legal moves')) console.error(`Legal moves: ${err.legalMoves.join(', ')}`);
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});

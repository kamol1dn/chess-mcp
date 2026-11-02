import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChessApiError, type ChessClient } from '../client/http-client.js';
import { BLUNDER_CHECKLIST } from '../shared/advice.js';
import type { Side, TurnInfo } from '../shared/types.js';

export interface BridgeOptions {
  client: ChessClient;
  gameId: string;
  side: Side;
  token: string;
  /** Shell command run once per turn. The prompt is sent on stdin; {image} and {prompt_file} are substituted. */
  exec: string;
  maxAttempts: number;
  turnTimeoutMs: number;
  log: (msg: string) => void;
}

/** Directory where board images for agents are written. */
export function imageDir(): string {
  const dir = path.join(os.tmpdir(), 'chess-mcp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function saveBoardImage(client: ChessClient, info: TurnInfo): Promise<string> {
  const file = path.join(imageDir(), `${info.game.id}-${info.side}-${info.game.moves.length}.png`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, await client.boardPng(info.game.id, { orientation: info.side, size: 640 }));
  return file;
}

function buildPrompt(info: TurnInfo, imagePath: string, feedback: string[], serverUrl: string): string {
  return [
    `You are playing a game of chess as ${info.side}.`,
    `A picture of the current board (from your side) is saved at: ${imagePath}`,
    'Look at it if you can view images; the same information is given as text below.',
    '',
    info.text,
    '',
    BLUNDER_CHECKLIST,
    `To try a line on a scratch board first (nothing is played), run: chess-mcp --server ${serverUrl} preview ${info.game.id} <move> [<reply> ...] --side ${info.side}`,
    ...(feedback.length ? ['', 'IMPORTANT:', ...feedback] : []),
    '',
    'Decide on your move. End your reply with a line of the form',
    'MOVE: <your move>',
    'optionally followed by a line of the form',
    'COMMENT: <one sentence about your idea>',
  ].join('\n');
}

const shellQuote = (s: string) => (process.platform === 'win32' ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);

function runCommand(command: string, input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Agent command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) reject(new Error(`Agent command exited with code ${code}: ${err.trim().slice(0, 500)}`));
      else resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Extracts the move (and an optional comment) from free-form agent output. */
export function extractMove(output: string, legalSan: string[]): { move: string; comment?: string } | null {
  const moveLines = [...output.matchAll(/^\s*\**MOVE\**\s*[:=]\s*\**\s*([^\s*`]+)/gim)];
  const comment = [...output.matchAll(/^\s*\**COMMENT\**\s*[:=]\s*(.+)$/gim)].at(-1)?.[1]?.trim();
  if (moveLines.length) return { move: moveLines.at(-1)![1].replace(/[.,;]+$/, ''), comment };
  // Fallback: the last token in the output that is a legal SAN move.
  const strip = (s: string) => s.replace(/[+#]/g, '');
  const legal = new Set(legalSan.map(strip));
  const tokens = output.split(/[\s,;()"'`*]+/).map((t) => strip(t.replace(/[.!?]+$/, '')));
  for (let i = tokens.length - 1; i >= 0; i--) if (legal.has(tokens[i])) return { move: tokens[i], comment };
  return null;
}

/**
 * Plays a game by waking an external CLI agent (e.g. `claude -p`) each time it
 * is our turn, passing it the position and board image, and submitting the
 * move it answers with.
 */
export async function runAgentBridge(opts: BridgeOptions): Promise<TurnInfo> {
  const { client, gameId, side, token, log } = opts;
  for (;;) {
    let info: TurnInfo;
    try {
      info = await client.wait(gameId, side, token, 120_000);
    } catch (err) {
      if (err instanceof ChessApiError && err.status === 0) {
        log(`server unreachable, retrying in 5s: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw err;
    }
    if (info.gameOver) {
      log(`game over: ${info.game.resultText ?? info.game.result}`);
      return info;
    }
    if (!info.yourTurn) continue;

    const image = await saveBoardImage(client, info);
    const feedback: string[] = [];
    let played = false;
    for (let attempt = 1; attempt <= opts.maxAttempts && !played; attempt++) {
      const prompt = buildPrompt(info, image, feedback, client.baseUrl);
      const promptFile = path.join(imageDir(), `${gameId}-${side}-prompt.txt`);
      fs.writeFileSync(promptFile, prompt);
      const command = opts.exec.replaceAll('{image}', shellQuote(image)).replaceAll('{prompt_file}', shellQuote(promptFile));
      log(`move ${info.game.fen.split(' ')[5]}: asking agent (attempt ${attempt})…`);
      let output: string;
      try {
        output = await runCommand(command, prompt, opts.turnTimeoutMs);
      } catch (err) {
        log(`agent command failed: ${(err as Error).message}`);
        feedback.push(`Your previous run failed (${(err as Error).message}). Answer with MOVE: <move>.`);
        continue;
      }
      const parsed = extractMove(output, info.legalSan);
      if (!parsed) {
        feedback.push('Your previous answer did not contain a move. End your reply with "MOVE: <move>" using one of the legal moves.');
        continue;
      }
      try {
        const game = await client.move(gameId, token, parsed.move, parsed.comment);
        log(`played ${game.moves.at(-1)!.san}${parsed.comment ? ` — ${parsed.comment}` : ''}`);
        played = true;
      } catch (err) {
        if (err instanceof ChessApiError && err.code === 'illegal_move') {
          log(`agent proposed illegal move ${parsed.move}`);
          feedback.push(`"${parsed.move}" is not a legal move here. Choose exactly one move from the legal move list.`);
          continue;
        }
        throw err;
      }
    }
    if (!played) {
      log(`agent failed to produce a legal move in ${opts.maxAttempts} attempts; resigning`);
      return { ...info, game: await client.resign(gameId, token), gameOver: true };
    }
  }
}

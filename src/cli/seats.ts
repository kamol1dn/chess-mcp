import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Side } from '../shared/types.js';

/**
 * Seat tokens the CLI has obtained, kept in ~/.chess-mcp/seats.json (mode 0600)
 * so separate `chess-mcp` invocations can act for the same seat.
 */
type SeatFile = Record<string, Record<string, Partial<Record<Side, string>>>>;

export function configDir(): string {
  return process.env.CHESS_MCP_HOME ?? path.join(os.homedir(), '.chess-mcp');
}

const seatFile = () => path.join(configDir(), 'seats.json');

function read(): SeatFile {
  try {
    return JSON.parse(fs.readFileSync(seatFile(), 'utf8')) as SeatFile;
  } catch {
    return {};
  }
}

function write(data: SeatFile): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = `${seatFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, seatFile());
}

export function saveSeat(server: string, gameId: string, side: Side, token: string): void {
  const data = read();
  data[server] ??= {};
  data[server][gameId] = { ...data[server][gameId], [side]: token };
  write(data);
}

export function findSeat(server: string, gameId: string, side?: Side): { side: Side; token: string } {
  const env = process.env.CHESS_SEAT_TOKEN;
  if (env && side) return { side, token: env };
  const seats = read()[server]?.[gameId] ?? {};
  if (side) {
    const token = seats[side];
    if (!token) throw new Error(`No ${side} seat saved for game ${gameId}. Run: chess-mcp join ${gameId} --side ${side}`);
    return { side, token };
  }
  const held = (Object.keys(seats) as Side[]).filter((s) => seats[s]);
  if (held.length === 1) return { side: held[0], token: seats[held[0]]! };
  if (held.length === 0) throw new Error(`You have not joined game ${gameId}. Run: chess-mcp join ${gameId}`);
  throw new Error(`You hold both seats in game ${gameId}; pass --side white|black.`);
}

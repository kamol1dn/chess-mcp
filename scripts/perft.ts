// Usage: npm run perft -- [depth] [fen]
import { perft } from '../src/engine/perft.js';
import { Position, START_FEN } from '../src/engine/position.js';

const depth = Number(process.argv[2] ?? 5);
const fen = process.argv.slice(3).join(' ') || START_FEN;
const pos = Position.fromFen(fen);
for (let d = 1; d <= depth; d++) {
  const t = performance.now();
  const n = perft(pos, d);
  const ms = performance.now() - t;
  console.log(`depth ${d}: ${n.toLocaleString()} nodes  ${ms.toFixed(0)} ms  ${Math.round(n / (ms / 1000 || 1)).toLocaleString()} nps`);
}

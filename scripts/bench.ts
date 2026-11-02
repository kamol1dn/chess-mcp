// Usage: npm exec tsx scripts/bench.ts [timeMs]
import { Position } from '../src/engine/position.js';
import { Searcher } from '../src/engine/search.js';

const timeMs = Number(process.argv[2] ?? 2000);
const fens = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
];
for (const fen of fens) {
  const r = new Searcher().search(Position.fromFen(fen), { timeMs });
  console.log(`${r.san.padEnd(6)} score ${r.score} depth ${r.depth} nodes ${r.nodes} ${r.timeMs}ms ${Math.round((r.nodes / r.timeMs) * 1000)} nps  pv ${r.pv.join(' ')}`);
}

import type { Position } from './position.js';

/** Counts leaf nodes of the legal move tree; the standard move-generator correctness test. */
export function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = pos.generatePseudo([]);
  let nodes = 0;
  for (const m of moves) {
    if (!pos.makeLegal(m)) continue;
    nodes += depth === 1 ? 1 : perft(pos, depth - 1);
    pos.unmakeMove();
  }
  return nodes;
}

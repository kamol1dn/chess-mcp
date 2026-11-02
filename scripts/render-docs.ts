// Regenerates docs/agent-view.png: the board image an agent receives on its turn.
import fs from 'node:fs';
import { ChessGame } from '../src/engine/game.js';
import { renderBoardPng } from '../src/render/png.js';

// A Claude-vs-Claude game after 22...Rxa2 — White to move (and about to blunder with 23. Na5??).
const moves =
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2 cxd4 cxd4 Nc6 Nb3 a5 Be3 a4 Nbd2 Bd7 Rc1 Qb7 d5 Nb4 Bb1 a3 bxa3 Rxa3 Nb3 Nxa2 Bxa2 Rxa2';
const g = new ChessGame();
for (const m of moves.split(' ')) g.move(m);
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/agent-view.png', renderBoardPng(g.fen(), { orientation: 'white', size: 480, lastMove: g.lastMoveSquares() }));
console.log(`wrote docs/agent-view.png (${g.fen()})`);

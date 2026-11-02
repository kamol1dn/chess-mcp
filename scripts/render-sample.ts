// Renders sample boards to the given directory for visual inspection.
import fs from 'node:fs';
import path from 'node:path';
import { renderBoardPng } from '../src/render/png.js';

const out = process.argv[2] ?? '.';
const fen = 'r1bqk2r/pppp1Bpp/2n2n2/2b1p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4';
fs.writeFileSync(path.join(out, 'board-white.png'), renderBoardPng(fen, { lastMove: ['c4', 'f7'], check: 'e8', caption: 'Black to move' }));
fs.writeFileSync(path.join(out, 'board-black.png'), renderBoardPng(fen, { orientation: 'black', lastMove: ['c4', 'f7'], check: 'e8', size: 512 }));
console.log('ok');

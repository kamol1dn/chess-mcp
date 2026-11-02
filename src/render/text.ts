
function placementToGrid(fen: string): string[][] {
  return fen
    .split(' ')[0]
    .split('/')
    .map((row) => {
      const out: string[] = [];
      for (const ch of row) {
        if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) out.push('');
        else out.push(ch);
      }
      return out;
    });
}

/**
 * ASCII diagram. Uppercase = White, lowercase = Black, "." = empty square.
 * Drawn from the given side's point of view.
 */
export function asciiBoard(fen: string, orientation: 'white' | 'black' = 'white'): string {
  const grid = placementToGrid(fen); // grid[0] is rank 8
  const files = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const ranks = orientation === 'white' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const header = '    ' + files.map((f) => 'abcdefgh'[f]).join(' ');
  const lines = [header, '  +-----------------+'];
  for (const rank of ranks) {
    const row = files.map((f) => grid[7 - rank][f] || '.').join(' ');
    lines.push(`${rank + 1} | ${row} | ${rank + 1}`);
  }
  lines.push('  +-----------------+', header);
  return lines.join('\n');
}

const ORDER = 'kqrbnp';

/** "White: Kg1, Qd1, Ra1, ... / Black: ..." — an unambiguous piece list. */
export function pieceList(fen: string): { white: string[]; black: string[] } {
  const grid = placementToGrid(fen);
  const white: Array<[string, string]> = [];
  const black: Array<[string, string]> = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = grid[r][f];
      if (!p) continue;
      const sq = 'abcdefgh'[f] + String(8 - r);
      (p === p.toUpperCase() ? white : black).push([p.toLowerCase(), sq]);
    }
  }
  const fmt = (list: Array<[string, string]>) =>
    list
      .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]) || a[1].localeCompare(b[1]))
      .map(([p, sq]) => (p === 'p' ? sq : p.toUpperCase() + sq));
  return { white: fmt(white), black: fmt(black) };
}

export function describePieces(fen: string): string {
  const { white, black } = pieceList(fen);
  return `White: ${white.join(', ')}\nBlack: ${black.join(', ')}`;
}


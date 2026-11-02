import { PIECE_SVG } from '../shared/pieces.js';

export interface BoardRenderOptions {
  /** Which side is at the bottom of the image. */
  orientation?: 'white' | 'black';
  /** Total image size in pixels (square). */
  size?: number;
  /** Squares of the last move, e.g. ["e2", "e4"]. */
  lastMove?: [string, string] | null;
  /** Square of a king in check. */
  check?: string | null;
  /** Draw file/rank labels around the board. */
  coordinates?: boolean;
  /** Optional caption drawn under the board (e.g. "Black to move"). */
  caption?: string;
}

export const BOARD_THEME = {
  light: '#f0d9b5',
  dark: '#b58863',
  border: '#3d2b1f',
  label: '#f0d9b5',
  lastMoveLight: '#cdd26a',
  lastMoveDark: '#aaa23a',
  check: '#ff0000',
};

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Renders a position (FEN or just its placement field) as a standalone SVG.
 * Coordinates are drawn on all four sides so the picture is unambiguous for
 * vision models regardless of orientation.
 */
export function renderBoardSvg(fen: string, opts: BoardRenderOptions = {}): string {
  const orientation = opts.orientation ?? 'white';
  const size = opts.size ?? 640;
  const coords = opts.coordinates ?? true;
  const captionH = opts.caption ? Math.round(size * 0.07) : 0;
  const margin = coords ? Math.round(size * 0.05) : 0;
  const sq = (size - 2 * margin) / 8;
  const height = size + captionH;

  const placement = fen.split(' ')[0];
  const rows = placement.split('/');
  const squares: string[][] = rows.map((row) => {
    const out: string[] = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) out.push('');
      else out.push(ch);
    }
    return out;
  });

  const lastSquares = new Set(opts.lastMove ?? []);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}" viewBox="0 0 ${size} ${height}">`,
    '<defs><radialGradient id="check"><stop offset="0%" stop-color="#ff0000" stop-opacity="1"/><stop offset="25%" stop-color="#e70000" stop-opacity="1"/><stop offset="89%" stop-color="#a90000" stop-opacity="0"/><stop offset="100%" stop-color="#9e0000" stop-opacity="0"/></radialGradient></defs>',
    `<rect x="0" y="0" width="${size}" height="${height}" fill="${BOARD_THEME.border}"/>`,
  );

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      // Board coordinates of the square drawn at screen position (f, r).
      const file = orientation === 'white' ? f : 7 - f;
      const rank = orientation === 'white' ? 7 - r : r;
      const name = 'abcdefgh'[file] + String(rank + 1);
      const light = (file + rank) % 2 === 1;
      const x = margin + f * sq;
      const y = margin + r * sq;
      let fill = light ? BOARD_THEME.light : BOARD_THEME.dark;
      if (lastSquares.has(name)) fill = light ? BOARD_THEME.lastMoveLight : BOARD_THEME.lastMoveDark;
      parts.push(`<rect x="${x}" y="${y}" width="${sq}" height="${sq}" fill="${fill}"/>`);
      if (opts.check === name) {
        parts.push(`<rect x="${x}" y="${y}" width="${sq}" height="${sq}" fill="url(#check)"/>`);
      }
      const piece = squares[7 - rank]?.[file];
      if (piece && PIECE_SVG[piece]) {
        const scale = sq / 45;
        parts.push(`<g transform="translate(${x} ${y}) scale(${scale})">${PIECE_SVG[piece]}</g>`);
      }
    }
  }

  if (coords) {
    const fontSize = Math.round(margin * 0.62);
    const textAttrs = `font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${fontSize}" fill="${BOARD_THEME.label}" text-anchor="middle"`;
    for (let i = 0; i < 8; i++) {
      const fileLabel = 'abcdefgh'[orientation === 'white' ? i : 7 - i];
      const rankLabel = String(orientation === 'white' ? 8 - i : i + 1);
      const cx = margin + i * sq + sq / 2;
      const cy = margin + i * sq + sq / 2 + fontSize * 0.36;
      parts.push(
        `<text x="${cx}" y="${margin / 2 + fontSize * 0.36}" ${textAttrs}>${fileLabel}</text>`,
        `<text x="${cx}" y="${size - margin / 2 + fontSize * 0.36}" ${textAttrs}>${fileLabel}</text>`,
        `<text x="${margin / 2}" y="${cy}" ${textAttrs}>${rankLabel}</text>`,
        `<text x="${size - margin / 2}" y="${cy}" ${textAttrs}>${rankLabel}</text>`,
      );
    }
  }

  if (opts.caption) {
    const fontSize = Math.round(captionH * 0.5);
    parts.push(
      `<text x="${size / 2}" y="${size + captionH / 2 + fontSize * 0.2}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${fontSize}" fill="${BOARD_THEME.label}" text-anchor="middle">${escapeXml(opts.caption)}</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}

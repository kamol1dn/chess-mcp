import { createRequire } from 'node:module';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { type BoardRenderOptions, renderBoardSvg } from './board-svg.js';

const require = createRequire(import.meta.url);

let fontFiles: string[] | null = null;
function fonts(): string[] {
  if (!fontFiles) {
    // Bundle a font so coordinate labels render identically on every host (including slim containers).
    const dir = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
    fontFiles = [path.join(dir, 'DejaVuSans-Bold.ttf'), path.join(dir, 'DejaVuSans.ttf')];
  }
  return fontFiles;
}

export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
    shapeRendering: 2,
    textRendering: 1,
  });
  return Buffer.from(resvg.render().asPng());
}

const cache = new Map<string, Buffer>();
const CACHE_LIMIT = 500;

/** Renders a board PNG. Results are memoised because agents request the same board repeatedly. */
export function renderBoardPng(fen: string, opts: BoardRenderOptions = {}): Buffer {
  const key = JSON.stringify([fen, opts]);
  const hit = cache.get(key);
  if (hit) return hit;
  const png = svgToPng(renderBoardSvg(fen, opts));
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, png);
  return png;
}

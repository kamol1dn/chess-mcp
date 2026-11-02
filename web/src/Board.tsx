import { useMemo, useRef, useState } from 'react';
import { PIECE_SVG } from '../../src/shared/pieces';
import type { Side } from '../../src/shared/types';

interface Props {
  fen: string;
  orientation: Side;
  lastMove: [string, string] | null;
  check: string | null;
  /** Legal moves in UCI for the side the user may move; empty disables interaction. */
  legalMoves: string[];
  onMove?: (uci: string) => void;
}

const FILES = 'abcdefgh';

function parsePlacement(fen: string): Map<string, string> {
  const map = new Map<string, string>();
  fen
    .split(' ')[0]
    .split('/')
    .forEach((row, r) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else {
          map.set(FILES[f] + String(8 - r), ch);
          f++;
        }
      }
    });
  return map;
}

export function Board({ fen, orientation, lastMove, check, legalMoves, onMove }: Props) {
  const pieces = useMemo(() => parsePlacement(fen), [fen]);
  const [selected, setSelected] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const [drag, setDrag] = useState<{ from: string; x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const interactive = legalMoves.length > 0 && Boolean(onMove);

  const targets = useMemo(() => {
    const from = drag?.from ?? selected;
    if (!from) return new Set<string>();
    return new Set(legalMoves.filter((m) => m.startsWith(from)).map((m) => m.slice(2, 4)));
  }, [selected, drag, legalMoves]);

  const movable = useMemo(() => new Set(legalMoves.map((m) => m.slice(0, 2))), [legalMoves]);

  const toScreen = (sq: string) => {
    const f = FILES.indexOf(sq[0]);
    const r = Number(sq[1]) - 1;
    return orientation === 'white' ? { x: f, y: 7 - r } : { x: 7 - f, y: r };
  };
  const fromScreen = (x: number, y: number) => {
    const f = orientation === 'white' ? x : 7 - x;
    const r = orientation === 'white' ? 7 - y : y;
    return FILES[f] + String(r + 1);
  };

  const pointToSquare = (clientX: number, clientY: number): string | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = Math.floor(((clientX - rect.left) / rect.width) * 8);
    const y = Math.floor(((clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return fromScreen(x, y);
  };
  const pointToBoard = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: ((clientX - rect.left) / rect.width) * 8, y: ((clientY - rect.top) / rect.height) * 8 };
  };

  const tryMove = (from: string, to: string) => {
    const candidates = legalMoves.filter((m) => m.startsWith(from + to));
    if (!candidates.length) return false;
    if (candidates.length > 1) setPromotion({ from, to });
    else onMove?.(candidates[0]);
    setSelected(null);
    return true;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive || promotion) return;
    const sq = pointToSquare(e.clientX, e.clientY);
    if (!sq) return;
    if (selected && selected !== sq && tryMove(selected, sq)) return;
    if (movable.has(sq)) {
      setSelected(sq);
      const p = pointToBoard(e.clientX, e.clientY);
      setDrag({ from: sq, x: p.x, y: p.y });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } else {
      setSelected(null);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = pointToBoard(e.clientX, e.clientY);
    setDrag({ ...drag, x: p.x, y: p.y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const sq = pointToSquare(e.clientX, e.clientY);
    setDrag(null);
    if (sq && sq !== drag.from) tryMove(drag.from, sq);
  };

  const squares = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sq = fromScreen(x, y);
      const light = (FILES.indexOf(sq[0]) + Number(sq[1])) % 2 === 0;
      const isLast = lastMove?.includes(sq);
      squares.push(
        <rect key={sq} x={x} y={y} width={1} height={1} className={`sq ${light ? 'light' : 'dark'}${isLast ? ' last' : ''}${selected === sq ? ' selected' : ''}`} />,
      );
      if (check === sq) squares.push(<rect key={`${sq}-check`} x={x} y={y} width={1} height={1} fill="url(#check-glow)" />);
      // Coordinates inside the edge squares
      if (x === 0)
        squares.push(
          <text key={`${sq}-r`} x={x + 0.04} y={y + 0.2} className={`coord ${light ? 'on-light' : 'on-dark'}`}>
            {sq[1]}
          </text>,
        );
      if (y === 7)
        squares.push(
          <text key={`${sq}-f`} x={x + 0.96} y={y + 0.95} textAnchor="end" className={`coord ${light ? 'on-light' : 'on-dark'}`}>
            {sq[0]}
          </text>,
        );
    }
  }

  const pieceEls = [...pieces.entries()].map(([sq, p]) => {
    if (drag?.from === sq) return null;
    const { x, y } = toScreen(sq);
    return (
      <g key={sq + p} transform={`translate(${x} ${y}) scale(${1 / 45})`} className="piece" dangerouslySetInnerHTML={{ __html: PIECE_SVG[p] }} />
    );
  });

  const hints = [...targets].map((sq) => {
    const { x, y } = toScreen(sq);
    const capture = pieces.has(sq);
    return capture ? (
      <circle key={`h-${sq}`} cx={x + 0.5} cy={y + 0.5} r={0.46} className="hint-capture" />
    ) : (
      <circle key={`h-${sq}`} cx={x + 0.5} cy={y + 0.5} r={0.15} className="hint" />
    );
  });

  const dragged = drag ? pieces.get(drag.from) : null;
  const promoColor = promotion ? (pieces.get(promotion.from) === 'P' ? 'w' : 'b') : 'w';

  return (
    <div className="board-wrap">
      <svg
        ref={svgRef}
        viewBox="0 0 8 8"
        className={`board${interactive ? ' interactive' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        role="img"
        aria-label={`Chess board, ${fen}`}
      >
        <defs>
          <radialGradient id="check-glow">
            <stop offset="0%" stopColor="#ff0000" stopOpacity="1" />
            <stop offset="25%" stopColor="#e70000" stopOpacity="1" />
            <stop offset="90%" stopColor="#a90000" stopOpacity="0" />
          </radialGradient>
        </defs>
        {squares}
        {hints}
        {pieceEls}
        {dragged && (
          <g
            transform={`translate(${drag!.x - 0.55} ${drag!.y - 0.55}) scale(${1.1 / 45})`}
            className="piece dragging"
            dangerouslySetInnerHTML={{ __html: PIECE_SVG[dragged] }}
          />
        )}
      </svg>
      {promotion && (
        <div className="promotion" onClick={() => setPromotion(null)}>
          <div className="promotion-choices" onClick={(e) => e.stopPropagation()}>
            {['q', 'r', 'b', 'n'].map((p) => (
              <button
                key={p}
                className="promo-btn"
                title={{ q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[p]}
                onClick={() => {
                  onMove?.(promotion.from + promotion.to + p);
                  setPromotion(null);
                }}
              >
                <svg viewBox="0 0 45 45" dangerouslySetInnerHTML={{ __html: PIECE_SVG[promoColor === 'w' ? p.toUpperCase() : p] }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

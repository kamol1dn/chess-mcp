import { useEffect, useMemo, useRef, useState } from 'react';
import type { Evaluation, GameView, SeatView, Side } from '../../src/shared/types';
import { api, seats, watchGame } from './api';
import { Board } from './Board';
import { EvalBar } from './EvalBar';
import { isSoundOn, setSoundOn, sfx, soundForSan } from './sound';

const EVAL_KEY = 'chess-mcp:eval-bar';
const readEvalPref = () => {
  try {
    return localStorage.getItem(EVAL_KEY) !== 'off';
  } catch {
    return true;
  }
};

const other = (s: Side): Side => (s === 'white' ? 'black' : 'white');
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function formatClock(ms: number) {
  const t = Math.max(0, ms);
  const total = Math.floor(t / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (t < 10_000) return `${m}:${String(s).padStart(2, '0')}.${Math.floor((t % 1000) / 100)}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function kindLabel(seat: SeatView) {
  switch (seat.kind) {
    case 'engine':
      return `Engine · level ${seat.level}`;
    case 'llm':
      return `${seat.model} · ${seat.effort}`;
    case 'agent':
      return 'AI agent';
    default:
      return 'Human';
  }
}

function seatStatus(game: GameView, side: Side, mine: boolean): { text: string; tone: string } | null {
  const seat = game[side];
  if (game.status === 'finished') return null;
  if (seat.error) return { text: seat.error, tone: 'error' };
  if (!seat.claimed) return { text: seat.kind === 'agent' ? 'Waiting for an agent to join' : 'Seat open', tone: 'muted' };
  if (seat.thinking) return { text: 'Thinking…', tone: 'active' };
  if (game.turn === side) {
    if (mine) return { text: 'Your move', tone: 'active' };
    if (seat.kind === 'agent') return { text: seat.waiting ? 'To move (agent connected)' : 'To move — waiting for the agent', tone: 'active' };
    return { text: 'To move', tone: 'active' };
  }
  if (seat.kind === 'agent') return { text: seat.waiting ? 'Connected, waiting for its turn' : 'Joined', tone: 'muted' };
  return null;
}

function PlayerBar({ game, side, mine, now }: { game: GameView; side: Side; mine: boolean; now: number }) {
  const seat = game[side];
  const status = seatStatus(game, side, mine);
  let clock: number | null = null;
  if (game.clock) {
    clock = game.clock[side];
    if (game.clock.running === side) clock -= now - game.clock.since;
  }
  const [busy, setBusy] = useState(false);
  return (
    <div className={`player-bar ${game.turn === side && game.status === 'active' ? 'to-move' : ''}`}>
      <span className={`dot ${side}`} />
      <div className="player-info">
        <div className="player-name">
          {seat.name} {mine && <span className="badge">you</span>}
        </div>
        <div className="player-kind">{kindLabel(seat)}</div>
      </div>
      {status && (
        <div className={`player-status ${status.tone}`}>
          {status.tone === 'active' && seat.thinking && <span className="spinner" />}
          {status.text}
          {seat.error && (seat.kind === 'llm' || seat.kind === 'engine') && (
            <button
              className="small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.retry(game.id, side);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {clock !== null && <div className={`clock ${game.clock?.running === side ? 'running' : ''} ${clock < 20_000 ? 'low' : ''}`}>{formatClock(clock)}</div>}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="small ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div className="snippet">
      <div className="snippet-head">
        <span>{title}</span>
        <CopyButton text={code} label="Copy" />
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function ConnectAgent({ game, side }: { game: GameView; side: Side }) {
  const origin = window.location.origin;
  const local = /localhost|127\.0\.0\.1/.test(origin);
  const server = local && origin.endsWith(':8787') ? '' : ` --server ${origin}`;
  return (
    <div className="card connect">
      <h3>
        Connect an AI agent as {cap(side)} <span className="mono muted">game {game.id}</span>
      </h3>
      <p className="muted">Pick one. The agent gets each position as text plus a board image.</p>
      <Snippet title="Claude Code (MCP), then ask it to play" code={`claude mcp add --transport http chess ${origin}/mcp`} />
      <Snippet title="Prompt for the agent" code={`Join chess game ${game.id} as ${side} using the chess MCP tools and play until the game ends.`} />
      <Snippet
        title="Any CLI agent, woken up each turn"
        code={`chess-mcp${server} agent ${game.id} --side ${side} --exec "claude -p --allowedTools Read"`}
      />
      <Snippet
        title="Manual CLI loop"
        code={`chess-mcp${server} join ${game.id} --side ${side}\nchess-mcp${server} wait ${game.id}     # blocks until it's your move\nchess-mcp${server} move ${game.id} e4`}
      />
    </div>
  );
}

export function GamePage({ id, navigate }: { id: string; navigate: (p: string) => void }) {
  const [game, setGame] = useState<GameView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [flipped, setFlipped] = useState<boolean | null>(null);
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [tokens, setTokens] = useState(() => seats.get(id));
  const [actionError, setActionError] = useState<string | null>(null);
  const moveListRef = useRef<HTMLDivElement>(null);
  const [showEval, setShowEval] = useState(readEvalPref);
  const [soundOn, setSoundState] = useState(isSoundOn);
  const prev = useRef<{ id: string; moves: number; status: string; drawOffer: Side | null } | null>(null);

  useEffect(() => {
    setGame(null);
    setTokens(seats.get(id));
    api.get(id).then(setGame, (e: Error) => setError(e.message));
    return watchGame(id, setGame, setConnected);
  }, [id]);

  // Sound effects for changes that arrive live (not for the initial load).
  useEffect(() => {
    if (!game) return;
    const p = prev.current;
    prev.current = { id: game.id, moves: game.moves.length, status: game.status, drawOffer: game.drawOffer };
    if (!p || p.id !== game.id) return;
    if (game.moves.length > p.moves) soundForSan(game.moves[game.moves.length - 1].san)();
    if (p.status === 'active' && game.status === 'finished') {
      const mine = (['white', 'black'] as Side[]).filter((s) => tokens[s]);
      const winner = game.result === '1-0' ? 'white' : game.result === '0-1' ? 'black' : null;
      const outcome =
        game.result === '1/2-1/2' ? 'draw' : mine.length !== 1 || !winner ? 'neutral' : winner === mine[0] ? 'win' : 'loss';
      setTimeout(() => sfx.gameEnd(outcome), 250);
    }
    if (game.drawOffer && game.drawOffer !== p.drawOffer && !tokens[game.drawOffer]) sfx.notify();
  }, [game, tokens]);

  useEffect(() => {
    const list = moveListRef.current;
    if (!list) return;
    if (viewPly === null) list.scrollTop = list.scrollHeight;
    else list.querySelector('.move.current')?.scrollIntoView({ block: 'nearest' });
  }, [game?.moves.length, viewPly]);

  const now = useNow(Boolean(game?.clock?.running));
  const mySides = (['white', 'black'] as Side[]).filter((s) => tokens[s]);
  const orientation: Side = useMemo(() => {
    const base: Side = mySides.length === 1 ? mySides[0] : 'white';
    return flipped ? other(base) : base;
  }, [mySides.join(), flipped]);

  if (error) {
    return (
      <div className="page narrow">
        <p className="error">{error}</p>
        <button onClick={() => navigate('/')}>Back to games</button>
      </div>
    );
  }
  if (!game) return <div className="page narrow muted">Loading…</div>;

  const live = viewPly === null || viewPly >= game.moves.length;
  const shownPly = live ? game.moves.length : viewPly!;
  const shown = live
    ? { fen: game.fen, lastMove: game.lastMove, check: game.check }
    : {
        fen: shownPly === 0 ? game.startFen : game.moves[shownPly - 1].fen,
        lastMove: shownPly === 0 ? null : ([game.moves[shownPly - 1].uci.slice(0, 2), game.moves[shownPly - 1].uci.slice(2, 4)] as [string, string]),
        check: null,
      };
  const myTurnToken = game.status === 'active' && live ? tokens[game.turn] : undefined;
  const actingSide: Side | undefined = mySides.length === 1 ? mySides[0] : mySides.length === 2 ? game.turn : undefined;
  const actingToken = actingSide ? tokens[actingSide] : undefined;

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      sfx.illegal();
      setActionError((e as Error).message);
    }
  };

  // Evaluation for the displayed position; while it is being computed, show the latest earlier one.
  let shownEval: Evaluation | null = null;
  let evalPending = false;
  for (let p = shownPly; p >= 0; p--) {
    const e = p === 0 ? game.startEval : game.moves[p - 1].eval;
    if (e) {
      shownEval = e;
      break;
    }
    evalPending = true;
  }

  const claim = (side: Side) =>
    act(async () => {
      const res = await api.claim(game.id, side);
      seats.set(game.id, side, res.token);
      setTokens(seats.get(game.id));
      setGame(res.game);
    });

  const rows: Array<{ no: number; white?: (typeof game.moves)[number]; black?: (typeof game.moves)[number] }> = [];
  const startNo = Number(game.startFen.split(' ')[5] ?? 1);
  const blackFirst = game.startFen.split(' ')[1] === 'b';
  game.moves.forEach((m, i) => {
    const no = startNo + Math.floor((i + (blackFirst ? 1 : 0)) / 2);
    let row = rows.at(-1);
    if (!row || row.no !== no) rows.push((row = { no }));
    row[m.color] = m;
  });

  const openAgentSeats = (['white', 'black'] as Side[]).filter((s) => game[s].kind === 'agent' && !game[s].claimed);
  const openHumanSeats = (['white', 'black'] as Side[]).filter((s) => game[s].kind === 'human' && !game[s].claimed);
  const comments = game.moves.filter((m) => m.comment).slice(-6).reverse();
  const top = other(orientation);

  return (
    <div className="game-page">
      <section className="board-col">
        <PlayerBar game={game} side={top} mine={Boolean(tokens[top])} now={now} />
        <div className="board-row">
          {showEval && <EvalBar evaluation={shownEval} orientation={orientation} pending={evalPending && game.status === 'active'} />}
          <Board
          fen={shown.fen}
          orientation={orientation}
          lastMove={shown.lastMove}
          check={shown.check}
          legalMoves={myTurnToken ? game.legalMoves : []}
          onMove={(uci) => act(() => api.move(game.id, myTurnToken!, uci).then(setGame))}
          />
        </div>
        <PlayerBar game={game} side={orientation} mine={Boolean(tokens[orientation])} now={now} />
        {!connected && <p className="warn">Live connection lost — reconnecting…</p>}
      </section>

      <aside className="side-col">
        {game.status === 'finished' && (
          <div className="result-banner">
            <div className="result-score">{game.result === '1/2-1/2' ? '½–½' : game.result}</div>
            <div>{game.resultText}</div>
          </div>
        )}
        {game.drawOffer && game.status === 'active' && (
          <div className="card draw-offer">
            {cap(game.drawOffer)} offers a draw.
            {actingSide && game.drawOffer !== actingSide && actingToken && (
              <span className="row">
                <button className="small" onClick={() => act(() => api.draw(game.id, actingToken, 'accept'))}>
                  Accept
                </button>
                <button className="small ghost" onClick={() => act(() => api.draw(game.id, actingToken, 'decline'))}>
                  Decline
                </button>
              </span>
            )}
          </div>
        )}

        <div className="card moves-card">
          <div className="card-head">
            <h3>Moves</h3>
            <div className="nav-buttons">
              <button className="small ghost" title="Start" onClick={() => setViewPly(0)}>
                ⏮
              </button>
              <button className="small ghost" title="Back" onClick={() => setViewPly(Math.max(0, shownPly - 1))}>
                ◀
              </button>
              <button className="small ghost" title="Forward" onClick={() => setViewPly(shownPly + 1 >= game.moves.length ? null : shownPly + 1)}>
                ▶
              </button>
              <button className="small ghost" title="Live" onClick={() => setViewPly(null)}>
                ⏭
              </button>
              <button className="small ghost" title="Flip board" onClick={() => setFlipped(!flipped)}>
                ⇅
              </button>
              <button
                className={`small ghost${showEval ? ' on' : ''}`}
                title={showEval ? 'Hide eval bar' : 'Show eval bar'}
                aria-pressed={showEval}
                onClick={() => {
                  setShowEval(!showEval);
                  try {
                    localStorage.setItem(EVAL_KEY, showEval ? 'off' : 'on');
                  } catch {
                    /* ignore */
                  }
                }}
              >
                ±
              </button>
              <button
                className={`small ghost${soundOn ? ' on' : ''}`}
                title={soundOn ? 'Mute sounds' : 'Unmute sounds'}
                aria-pressed={soundOn}
                onClick={() => {
                  setSoundOn(!soundOn);
                  setSoundState(!soundOn);
                  if (!soundOn) setTimeout(sfx.move, 50);
                }}
              >
                {soundOn ? '🔊' : '🔇'}
              </button>
            </div>
          </div>
          <div className="move-list" ref={moveListRef}>
            {rows.length === 0 && <p className="muted">No moves yet.</p>}
            {rows.map((r) => (
              <div className="move-row" key={r.no}>
                <span className="move-no">{r.no}.</span>
                {(['white', 'black'] as Side[]).map((c) => {
                  const m = r[c];
                  return m ? (
                    <button
                      key={c}
                      className={`move ${shownPly === m.ply ? 'current' : ''}`}
                      title={m.comment ? `${m.comment}\n(${(m.thinkMs / 1000).toFixed(1)}s)` : `${(m.thinkMs / 1000).toFixed(1)}s`}
                      onClick={() => setViewPly(m.ply === game.moves.length ? null : m.ply)}
                    >
                      {m.san}
                      {m.comment && <span className="has-comment">•</span>}
                    </button>
                  ) : (
                    <span key={c} className="move empty">
                      {c === 'white' && r.black ? '…' : ''}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {comments.length > 0 && (
          <div className="card">
            <h3>Players' notes</h3>
            <ul className="comments">
              {comments.map((m) => (
                <li key={m.ply}>
                  <span className={`dot ${m.color}`} /> <strong>{m.san}</strong> <span className="muted">— {game[m.color].name}</span>
                  <div>{m.comment}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {game.status === 'active' &&
          openHumanSeats.map((s) => (
            <div className="card" key={s}>
              <p>The {s} seat is open for a human player.</p>
              <div className="row">
                <button className="primary" onClick={() => claim(s)}>
                  Play as {s}
                </button>
                <CopyButton text={window.location.href} label="Copy invite link" />
              </div>
            </div>
          ))}
        {game.status === 'active' && openAgentSeats.map((s) => <ConnectAgent key={s} game={game} side={s} />)}

        {actionError && <p className="error">{actionError}</p>}

        <div className="card">
          <div className="row wrap">
            {game.status === 'active' && actingToken && (
              <>
                <button className="small" onClick={() => act(() => api.draw(game.id, actingToken, 'offer'))}>
                  Offer draw
                </button>
                {game.moves.length < 2 ? (
                  <button className="small danger" onClick={() => act(() => api.abort(game.id, actingToken))}>
                    Abort
                  </button>
                ) : (
                  <button
                    className="small danger"
                    onClick={() => {
                      if (confirm('Resign this game?')) void act(() => api.resign(game.id, actingToken));
                    }}
                  >
                    Resign
                  </button>
                )}
              </>
            )}
            <CopyButton text={shown.fen} label="Copy FEN" />
            <a className="button small ghost" href={`/api/games/${game.id}/pgn?download=1`}>
              Download PGN
            </a>
            <a className="button small ghost" href={`/api/games/${game.id}/board.png?orientation=${orientation}&ply=${shownPly}`} target="_blank" rel="noreferrer">
              Board image
            </a>
          </div>
          <p className="mono muted small-text">Game {game.id}</p>
        </div>
      </aside>
    </div>
  );
}

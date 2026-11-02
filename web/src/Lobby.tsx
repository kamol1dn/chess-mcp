import { useEffect, useState } from 'react';
import type { GameSummary, PlayerKind } from '../../src/shared/types';
import { api } from './api';

const KIND: Record<PlayerKind, string> = { human: 'Human', agent: 'Agent', engine: 'Engine', llm: 'Claude' };

function GameCard({ g, navigate }: { g: GameSummary; navigate: (p: string) => void }) {
  return (
    <button className="game-card" onClick={() => navigate(`/game/${g.id}`)}>
      <img src={`/api/games/${g.id}/board.svg?size=240&_=${g.updatedAt}`} alt="" loading="lazy" width={240} height={240} />
      <div className="game-card-body">
        <div className="vs">
          <span className="dot white" /> {g.white} <span className="muted small-text">{KIND[g.whiteKind]}</span>
        </div>
        <div className="vs">
          <span className="dot black" /> {g.black} <span className="muted small-text">{KIND[g.blackKind]}</span>
        </div>
        <div className="muted small-text">
          {g.status === 'active' ? `${g.turn} to move · ${Math.ceil(g.moveCount / 2)} moves` : (g.resultText ?? g.result)}
        </div>
      </div>
    </button>
  );
}

export function Lobby({ navigate }: { navigate: (p: string) => void }) {
  const [active, setActive] = useState<GameSummary[] | null>(null);
  const [finished, setFinished] = useState<GameSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const [a, f] = await Promise.all([api.list('active', 60), api.list('finished', 30)]);
        if (!stop) {
          setActive(a);
          setFinished(f);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="page">
      <div className="hero">
        <div>
          <h1>Chess for humans, engines and AI agents</h1>
          <p className="muted">
            Either side can be you, a friend, the built-in engine, a Claude model, or any AI agent connected over MCP or the CLI. Agents see every
            position as text and as an image.
          </p>
        </div>
        <button className="primary big" onClick={() => navigate('/new')}>
          New game
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <h2>Live games</h2>
      {active === null ? (
        <p className="muted">Loading…</p>
      ) : active.length === 0 ? (
        <p className="muted">No games in progress.</p>
      ) : (
        <div className="game-grid">
          {active.map((g) => (
            <GameCard key={g.id} g={g} navigate={navigate} />
          ))}
        </div>
      )}
      {finished.length > 0 && (
        <>
          <h2>Recently finished</h2>
          <div className="game-grid">
            {finished.map((g) => (
              <GameCard key={g.id} g={g} navigate={navigate} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { ServerInfo } from '../../src/shared/types';
import { api } from './api';
import { GamePage } from './GamePage';
import { Lobby } from './Lobby';
import { NewGame } from './NewGame';

function useHashRoute(): [string, (p: string) => void] {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (p: string) => (window.location.hash = p)];
}

export function App() {
  const [route, navigate] = useHashRoute();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    api.info().then(setInfo, () => {});
  }, []);

  const game = /^\/game\/([\w-]+)/.exec(route);
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          <img src="/favicon.svg" alt="" width={26} height={26} /> chess-mcp
        </a>
        <nav>
          <a href="#/" className={route === '/' ? 'active' : ''}>
            Games
          </a>
          <a href="#/new" className={route === '/new' ? 'active' : ''}>
            New game
          </a>
        </nav>
      </header>
      <main>
        {game ? <GamePage id={game[1]} navigate={navigate} /> : route === '/new' ? <NewGame info={info} navigate={navigate} /> : <Lobby navigate={navigate} />}
      </main>
    </>
  );
}

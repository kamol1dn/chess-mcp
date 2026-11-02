import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudePlayerError, type ClaudeMoveRequest, type ClaudeMoveResponse } from '../src/server/claude-player.js';
import { ApiError } from '../src/server/errors.js';
import { GameStore } from '../src/server/store.js';
import { makeManager, until } from './helpers.js';

const agentVsAgent = { white: { kind: 'agent' as const }, black: { kind: 'agent' as const }, claim: ['white' as const, 'black' as const] };

function expectApiError(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    if (code) expect((e as ApiError).code).toBe(code);
    return e as ApiError;
  }
  throw new Error('expected an ApiError');
}

function scripted(answers: Array<Partial<ClaudeMoveResponse> | Error>) {
  const calls: ClaudeMoveRequest[] = [];
  return {
    calls,
    async chooseMove(req: ClaudeMoveRequest): Promise<ClaudeMoveResponse> {
      calls.push(req);
      const next = answers.shift();
      if (!next) throw new Error('no more scripted answers');
      if (next instanceof Error) throw next;
      return { move: '', comment: '', acceptDraw: false, usage: { inputTokens: 0, outputTokens: 0 }, ...next };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GameManager', () => {
  it('plays a game between two token holders and enforces turns', () => {
    const { games } = makeManager();
    const { game, tokens } = games.create(agentVsAgent);
    expect(game.turn).toBe('white');
    expect(game.legalMoves).toHaveLength(20);

    expectApiError(() => games.move(game.id, tokens.black!, 'e5'), 409);
    expectApiError(() => games.move(game.id, 'not-a-token', 'e4'), 403);
    const illegal = expectApiError(() => games.move(game.id, tokens.white!, 'e5'), 400, 'illegal_move');
    expect(illegal.extra.legalMoves).toContain('e4');

    games.move(game.id, tokens.white!, 'e4', 'center!');
    const after = games.move(game.id, tokens.black!, 'e7e5');
    expect(after.moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect(after.moves[0].comment).toBe('center!');
    expect(games.pgn(game.id)).toContain('1. e4 e5 *');
  });

  it('ends the game on checkmate', () => {
    const { games } = makeManager();
    const { game, tokens } = games.create(agentVsAgent);
    for (const [side, m] of [['white', 'f3'], ['black', 'e5'], ['white', 'g4'], ['black', 'Qh4']] as const) {
      games.move(game.id, tokens[side]!, m);
    }
    const g = games.get(game.id);
    expect(g.status).toBe('finished');
    expect(g.result).toBe('0-1');
    expect(g.resultText).toBe('Black wins by checkmate');
    expectApiError(() => games.move(game.id, tokens.white!, 'a3'), 409);
  });

  it('lets agents claim open seats exactly once', () => {
    const { games } = makeManager();
    const { game } = games.create({ white: { kind: 'agent' }, black: { kind: 'engine', level: 1 } });
    expect(game.white.claimed).toBe(false);
    const { token } = games.claim(game.id, 'white', 'Claude');
    expect(games.get(game.id).white).toMatchObject({ claimed: true, name: 'Claude' });
    expect(games.sideForToken(game.id, token)).toBe('white');
    expectApiError(() => games.claim(game.id, 'white'), 409);
    expectApiError(() => games.claim(game.id, 'black'), 409);
  });

  it('wakes a waiting agent when the opponent moves', async () => {
    const { games } = makeManager();
    const { game, tokens } = games.create(agentVsAgent);
    const waiting = games.waitForTurn(game.id, 'black', tokens.black, 5000);
    await until(() => games.get(game.id).black.waiting);
    games.move(game.id, tokens.white!, 'd4');
    const info = await waiting;
    expect(info.yourTurn).toBe(true);
    expect(info.legalSan).toContain('d5');
    expect(info.text).toContain('Last move: White played 1. d4');
    expect(games.get(game.id).black.waiting).toBe(false);
  });

  it('returns "not your turn" when a wait times out', async () => {
    const { games } = makeManager();
    const { game, tokens } = games.create(agentVsAgent);
    const info = await games.waitForTurn(game.id, 'black', tokens.black, 30);
    expect(info.yourTurn).toBe(false);
    expect(info.gameOver).toBe(false);
  });

  it('lets the built-in engine answer moves', async () => {
    const { games } = makeManager();
    const { game, tokens } = games.create({ white: { kind: 'agent' }, black: { kind: 'engine', level: 3 }, claim: ['white'] });
    games.move(game.id, tokens.white!, 'e4');
    const info = await games.waitForTurn(game.id, 'white', tokens.white, 10_000);
    expect(info.yourTurn).toBe(true);
    expect(info.game.moves).toHaveLength(2);
    expect(info.game.moves[1].comment).toMatch(/eval|mates/);
  });

  it('runs engine-vs-engine games to completion', async () => {
    const { games } = makeManager();
    // White to move has mate in one.
    const { game } = games.create({
      white: { kind: 'engine', level: 6 },
      black: { kind: 'engine', level: 6 },
      fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
    });
    const done = await until(() => {
      const g = games.get(game.id);
      return g.status === 'finished' ? g : null;
    });
    expect(done.result).toBe('1-0');
    expect(done.moves[0].san).toBe('Rd8#');
  });

  it('handles resignation, draw offers and aborts', () => {
    const { games } = makeManager();
    const a = games.create(agentVsAgent);
    expectApiError(() => games.acceptDraw(a.game.id, a.tokens.black!), 409);
    games.offerDraw(a.game.id, a.tokens.white!);
    expect(games.get(a.game.id).drawOffer).toBe('white');
    games.offerDraw(a.game.id, a.tokens.black!); // offering back accepts
    expect(games.get(a.game.id)).toMatchObject({ status: 'finished', result: '1/2-1/2', termination: 'agreement' });

    const b = games.create(agentVsAgent);
    games.offerDraw(b.game.id, b.tokens.black!);
    games.move(b.game.id, b.tokens.white!, 'e4'); // moving declines
    expect(games.get(b.game.id).drawOffer).toBeNull();
    games.move(b.game.id, b.tokens.black!, 'e5');
    expectApiError(() => games.abort(b.game.id, b.tokens.white!), 409);
    expect(games.resign(b.game.id, b.tokens.white!)).toMatchObject({ result: '0-1', resultText: 'Black wins by resignation' });

    const c = games.create(agentVsAgent);
    expect(games.abort(c.game.id, c.tokens.black!)).toMatchObject({ termination: 'aborted', result: '*' });
  });

  it('validates new games', () => {
    const { games } = makeManager();
    expectApiError(() => games.create({ white: { kind: 'engine', level: 11 }, black: { kind: 'agent' } }), 400);
    expectApiError(() => games.create({ white: { kind: 'agent' }, black: { kind: 'agent' }, fen: 'not a fen' }), 400);
    expectApiError(() => games.create({ white: { kind: 'agent' }, black: { kind: 'agent' }, fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' }), 400);
    expectApiError(() => games.create({ white: { kind: 'engine', level: 2 }, black: { kind: 'agent' }, claim: ['white'] }), 400);
  });

  it('flags a player whose clock runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { games } = makeManager();
    const { game, tokens } = games.create({ ...agentVsAgent, timeControl: { initialMinutes: 1, incrementSeconds: 2 } });
    games.move(game.id, tokens.white!, 'e4');
    vi.advanceTimersByTime(30_000); // clocks only start after both sides moved
    games.move(game.id, tokens.black!, 'e5');
    vi.advanceTimersByTime(20_000);
    const g = games.move(game.id, tokens.white!, 'Nf3');
    expect(g.clock!.white).toBe(60_000 - 20_000 + 2_000);
    expect(g.clock!.running).toBe('black');
    vi.advanceTimersByTime(60_100);
    expect(games.get(game.id)).toMatchObject({ status: 'finished', termination: 'timeout', result: '1-0' });
  });

  it('evaluates positions in the background for the eval bar', async () => {
    const { games } = makeManager({ analysisMs: 50 });
    const { game, tokens } = games.create(agentVsAgent);
    games.move(game.id, tokens.white!, 'e4');
    games.move(game.id, tokens.black!, 'f6');
    games.move(game.id, tokens.white!, 'd4');
    games.move(game.id, tokens.black!, 'g5');
    games.move(game.id, tokens.white!, 'Qh5');
    const g = await until(() => {
      const v = games.get(game.id);
      return v.startEval && v.moves.every((m) => m.eval) ? v : null;
    });
    expect(Math.abs(g.startEval!.cp)).toBeLessThan(100);
    expect(g.moves[1].eval!.cp).toBeGreaterThan(50); // 1...f6 is a bad move
    expect(g.moves[4].eval).toMatchObject({ cp: 10_000, mate: 0 }); // Qh5#
    expect(g.status).toBe('finished');
  });

  it('restores active games from storage', () => {
    const store = new GameStore(':memory:');
    const first = makeManager({ store });
    const { game, tokens } = first.games.create(agentVsAgent);
    first.games.move(game.id, tokens.white!, 'c4');
    const second = makeManager({ store });
    const restored = second.games.get(game.id);
    expect(restored.moves.map((m) => m.san)).toEqual(['c4']);
    expect(restored.turn).toBe('black');
    second.games.move(game.id, tokens.black!, 'e5');
    expect(second.games.list({ status: 'active' })[0]).toMatchObject({ id: game.id, moveCount: 2 });
  });
});

describe('Claude players', () => {
  it('sends the board image and briefing, and retries illegal moves with feedback', async () => {
    const claude = scripted([{ move: 'Ke2??' }, { move: 'e5', comment: 'Symmetry.' }]);
    const { games } = makeManager({ claude });
    const { game, tokens } = games.create({ white: { kind: 'agent' }, black: { kind: 'llm', model: 'claude-opus-5-5' }, claim: ['white'] });
    games.move(game.id, tokens.white!, 'e4');
    const info = await games.waitForTurn(game.id, 'white', tokens.white, 5000);
    expect(info.game.moves[1]).toMatchObject({ san: 'e5', comment: 'Symmetry.' });
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[0].boardPng.subarray(1, 4).toString()).toBe('PNG');
    expect(claude.calls[0].briefing).toContain('You play Black');
    expect(claude.calls[0].effort).toBe('medium');
    expect(claude.calls[1].feedback[0]).toContain('"Ke2??" is not a legal move');
  });

  it('forfeits after too many illegal moves', async () => {
    const claude = scripted([{ move: 'Qxh9' }, { move: 'Ke9' }, { move: 'nonsense' }]);
    const { games } = makeManager({ claude });
    const { game } = games.create({ white: { kind: 'llm', model: 'claude-haiku-5-5' }, black: { kind: 'agent' } });
    const g = await until(() => (games.get(game.id).status === 'finished' ? games.get(game.id) : null));
    expect(g).toMatchObject({ termination: 'forfeit', result: '0-1' });
  });

  it('retries transient API errors and surfaces permanent ones on the seat', async () => {
    const claude = scripted([new ClaudePlayerError('rate limited', true), { move: 'd4' }]);
    const { games } = makeManager({ claude });
    const a = games.create({ white: { kind: 'llm', model: 'claude-opus-5-5' }, black: { kind: 'agent' } });
    await until(() => games.get(a.game.id).moves.length === 1);

    const failing = scripted([new ClaudePlayerError('bad credentials', false), { move: 'Nf3' }]);
    const m2 = makeManager({ claude: failing });
    const b = m2.games.create({ white: { kind: 'llm', model: 'claude-opus-5-5' }, black: { kind: 'agent' } });
    await until(() => m2.games.get(b.game.id).white.error);
    expect(m2.games.get(b.game.id).white).toMatchObject({ error: 'bad credentials', thinking: false });
    m2.games.retry(b.game.id, 'white');
    await until(() => m2.games.get(b.game.id).moves.length === 1);
    expect(m2.games.get(b.game.id).white.error).toBeNull();
  });

  it('can accept a draw offer or resign', async () => {
    const claude = scripted([{ move: 'e5', acceptDraw: true }]);
    const { games } = makeManager({ claude, moveDelayMs: 50 });
    const { game, tokens } = games.create({ white: { kind: 'agent' }, black: { kind: 'llm', model: 'claude-opus-5-5' }, claim: ['white'] });
    games.offerDraw(game.id, tokens.white!);
    games.move(game.id, tokens.white!, 'e4');
    // White moved after offering, so the offer stands until Black answers.
    const g = await until(() => (games.get(game.id).status === 'finished' ? games.get(game.id) : null));
    expect(g.termination).toBe('agreement');
    expect(claude.calls[0].drawOffered).toBe(true);

    const resigner = scripted([{ move: 'resign' }]);
    const m2 = makeManager({ claude: resigner });
    const r = m2.games.create({ white: { kind: 'llm', model: 'claude-opus-5-5' }, black: { kind: 'agent' } });
    const done = await until(() => (m2.games.get(r.game.id).status === 'finished' ? m2.games.get(r.game.id) : null));
    expect(done).toMatchObject({ termination: 'resignation', result: '0-1' });
  });
});

import { useState } from 'react';
import type { CreateGameRequest, Effort, PlayerSpec, ServerInfo, Side } from '../../src/shared/types';
import { ApiError, api, seats, setApiKey } from './api';

type Choice = 'me' | 'invite' | 'agent' | 'engine' | 'claude';

interface SeatConfig {
  choice: Choice;
  name: string;
  level: number;
  model: string;
  effort: Effort;
}

const CHOICES: Array<{ id: Choice; label: string; hint: string }> = [
  { id: 'me', label: 'Me', hint: 'You play this side in this browser.' },
  { id: 'invite', label: 'Human', hint: 'Someone else takes the seat from the game link.' },
  { id: 'agent', label: 'AI agent', hint: 'Any agent over MCP or the CLI (e.g. Claude Code) joins this seat.' },
  { id: 'engine', label: 'Engine', hint: 'The built-in engine.' },
  { id: 'claude', label: 'Claude API', hint: 'The server asks a Claude model for each move (needs ANTHROPIC_API_KEY).' },
];

const TIME_CONTROLS: Array<{ label: string; value: [number, number] | null }> = [
  { label: 'No clock', value: null },
  { label: '1+0', value: [1, 0] },
  { label: '3+2', value: [3, 2] },
  { label: '5+3', value: [5, 3] },
  { label: '10+5', value: [10, 5] },
  { label: '15+10', value: [15, 10] },
  { label: '30+20', value: [30, 20] },
];

function toSpec(c: SeatConfig): PlayerSpec {
  const name = c.name.trim() || undefined;
  switch (c.choice) {
    case 'me':
    case 'invite':
      return { kind: 'human', ...(name ? { name } : {}) };
    case 'agent':
      return { kind: 'agent', ...(name ? { name } : {}) };
    case 'engine':
      return { kind: 'engine', level: c.level, ...(name ? { name } : {}) };
    case 'claude':
      return { kind: 'llm', model: c.model, effort: c.effort, ...(name ? { name } : {}) };
  }
}

function SeatPicker({ side, value, onChange, info }: { side: Side; value: SeatConfig; onChange: (v: SeatConfig) => void; info: ServerInfo | null }) {
  const hint = CHOICES.find((c) => c.id === value.choice)!.hint;
  return (
    <fieldset className="seat-picker">
      <legend>
        <span className={`dot ${side}`} /> {side === 'white' ? 'White' : 'Black'}
      </legend>
      <div className="segmented" role="radiogroup">
        {CHOICES.map((c) => (
          <button
            type="button"
            key={c.id}
            role="radio"
            aria-checked={value.choice === c.id}
            className={value.choice === c.id ? 'active' : ''}
            onClick={() => onChange({ ...value, choice: c.id })}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="hint">{hint}</p>
      {value.choice === 'engine' && (
        <label className="field">
          <span>
            Strength <strong>{value.level}</strong>/10
          </span>
          <input type="range" min={1} max={10} value={value.level} onChange={(e) => onChange({ ...value, level: Number(e.target.value) })} />
        </label>
      )}
      {value.choice === 'claude' && (
        <div className="row">
          <label className="field grow">
            <span>Model</span>
            <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
              {(info?.llmModels ?? [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }]).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Effort</span>
            <select value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value as Effort })}>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {value.choice === 'claude' && info && !info.llmAvailable && (
        <p className="warn">ANTHROPIC_API_KEY is not set on the server, so Claude moves will fail until it is.</p>
      )}
      <label className="field">
        <span>Display name (optional)</span>
        <input value={value.name} maxLength={60} placeholder={value.choice === 'agent' ? 'e.g. Claude Code' : ''} onChange={(e) => onChange({ ...value, name: e.target.value })} />
      </label>
    </fieldset>
  );
}

export function NewGame({ info, navigate }: { info: ServerInfo | null; navigate: (path: string) => void }) {
  const base: SeatConfig = { choice: 'me', name: '', level: 5, model: 'claude-opus-5-5', effort: 'medium' };
  const [white, setWhite] = useState<SeatConfig>(base);
  const [black, setBlack] = useState<SeatConfig>({ ...base, choice: 'agent' });
  const [tc, setTc] = useState<[number, number] | null>(null);
  const [fen, setFen] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needKey, setNeedKey] = useState(false);
  const [key, setKey] = useState('');

  const presets: Array<{ label: string; w: Partial<SeatConfig>; b: Partial<SeatConfig> }> = [
    { label: 'Me vs AI agent', w: { choice: 'me' }, b: { choice: 'agent' } },
    { label: 'Me vs Engine', w: { choice: 'me' }, b: { choice: 'engine' } },
    { label: 'Agent vs Agent', w: { choice: 'agent' }, b: { choice: 'agent' } },
    { label: 'Claude vs Claude', w: { choice: 'claude', model: 'claude-opus-5-5' }, b: { choice: 'claude', model: 'claude-sonnet-5-5' } },
    { label: 'Agent vs Engine', w: { choice: 'agent' }, b: { choice: 'engine' } },
  ];

  const submit = async () => {
    setBusy(true);
    setError(null);
    const req: CreateGameRequest = {
      white: toSpec(white),
      black: toSpec(black),
      claim: (['white', 'black'] as Side[]).filter((s) => (s === 'white' ? white : black).choice === 'me'),
      ...(fen.trim() ? { fen: fen.trim() } : {}),
      ...(tc ? { timeControl: { initialMinutes: tc[0], incrementSeconds: tc[1] } } : {}),
    };
    try {
      const res = await api.create(req);
      for (const [side, token] of Object.entries(res.tokens)) seats.set(res.game.id, side as Side, token!);
      navigate(`/game/${res.game.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedKey(true);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <h1>New game</h1>
      <div className="presets">
        {presets.map((p) => (
          <button
            key={p.label}
            className="chip"
            onClick={() => {
              setWhite({ ...white, ...p.w });
              setBlack({ ...black, ...p.b });
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="seat-grid">
        <SeatPicker side="white" value={white} onChange={setWhite} info={info} />
        <SeatPicker side="black" value={black} onChange={setBlack} info={info} />
      </div>
      <fieldset className="seat-picker">
        <legend>Clock</legend>
        <div className="segmented wrap">
          {TIME_CONTROLS.map((t) => (
            <button key={t.label} type="button" className={JSON.stringify(t.value) === JSON.stringify(tc) ? 'active' : ''} onClick={() => setTc(t.value)}>
              {t.label}
            </button>
          ))}
        </div>
        <p className="hint">AI agents and Claude can take a while per move; clocks are best for engine or human games.</p>
        <details>
          <summary>Start from a custom position (FEN)</summary>
          <input className="mono" value={fen} placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" onChange={(e) => setFen(e.target.value)} />
        </details>
      </fieldset>
      {needKey && (
        <div className="card">
          <p>This server requires an API key to create games.</p>
          <div className="row">
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" />
            <button
              onClick={() => {
                setApiKey(key);
                setNeedKey(false);
                void submit();
              }}
            >
              Save &amp; retry
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="primary big" disabled={busy} onClick={submit}>
          {busy ? 'Creating…' : 'Create game'}
        </button>
      </div>
    </div>
  );
}

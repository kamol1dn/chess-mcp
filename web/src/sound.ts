/**
 * Small synthesized sound effects (Web Audio API) — no audio assets needed.
 * Browsers only allow audio after a user gesture, so the context is created
 * lazily and resumed on the first pointer/keyboard interaction.
 */
const KEY = 'chess-mcp:sound';
let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function enabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function isSoundOn(): boolean {
  return enabled();
}

export function setSoundOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
  if (on) unlock();
}

function audio(): AudioContext | null {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

export function unlock(): void {
  const a = audio();
  if (a && a.state === 'suspended') void a.resume();
}

if (typeof window !== 'undefined') {
  const once = () => {
    unlock();
    window.removeEventListener('pointerdown', once);
    window.removeEventListener('keydown', once);
  };
  window.addEventListener('pointerdown', once);
  window.addEventListener('keydown', once);
}

function noiseBuffer(a: AudioContext): AudioBuffer {
  if (!noise) {
    noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.25), a.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noise;
}

/** A short wooden "tock": filtered noise burst plus a low body thump. */
function knock(a: AudioContext, at: number, gain: number, pitch: number): void {
  const src = a.createBufferSource();
  src.buffer = noiseBuffer(a);
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = pitch;
  bp.Q.value = 1.4;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + 0.07);
  src.connect(bp).connect(g).connect(a.destination);
  src.start(at);
  src.stop(at + 0.08);

  const body = a.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(pitch / 9, at);
  body.frequency.exponentialRampToValueAtTime(pitch / 16, at + 0.08);
  const bg = a.createGain();
  bg.gain.setValueAtTime(gain * 0.9, at);
  bg.gain.exponentialRampToValueAtTime(0.001, at + 0.09);
  body.connect(bg).connect(a.destination);
  body.start(at);
  body.stop(at + 0.1);
}

function tone(a: AudioContext, at: number, freq: number, dur: number, type: OscillatorType, gain: number): void {
  const o = a.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(a.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

function play(fn: (a: AudioContext, t: number) => void): void {
  if (!enabled()) return;
  const a = audio();
  if (!a || a.state !== 'running') return;
  fn(a, a.currentTime + 0.005);
}

export const sfx = {
  move: () => play((a, t) => knock(a, t, 0.55, 1700)),
  capture: () =>
    play((a, t) => {
      knock(a, t, 0.7, 1300);
      knock(a, t + 0.055, 0.45, 2100);
    }),
  castle: () =>
    play((a, t) => {
      knock(a, t, 0.5, 1700);
      knock(a, t + 0.11, 0.5, 1500);
    }),
  check: () =>
    play((a, t) => {
      knock(a, t, 0.55, 1700);
      tone(a, t + 0.02, 988, 0.22, 'triangle', 0.18);
    }),
  promote: () =>
    play((a, t) => {
      knock(a, t, 0.5, 1700);
      tone(a, t + 0.03, 784, 0.12, 'triangle', 0.15);
      tone(a, t + 0.12, 1175, 0.18, 'triangle', 0.15);
    }),
  illegal: () => play((a, t) => tone(a, t, 140, 0.16, 'square', 0.07)),
  notify: () =>
    play((a, t) => {
      tone(a, t, 660, 0.12, 'sine', 0.15);
      tone(a, t + 0.12, 880, 0.16, 'sine', 0.15);
    }),
  gameEnd: (outcome: 'win' | 'loss' | 'draw' | 'neutral') =>
    play((a, t) => {
      const notes = outcome === 'loss' ? [523, 440, 349] : outcome === 'draw' ? [523, 523, 659] : [523, 659, 784, 1047];
      notes.forEach((f, i) => tone(a, t + 0.08 + i * 0.13, f, 0.35, 'triangle', 0.16));
    }),
};

/** Picks the sound for a SAN move. */
export function soundForSan(san: string): () => void {
  if (san.includes('#')) return sfx.check;
  if (san.includes('+')) return sfx.check;
  if (san.includes('=')) return sfx.promote;
  if (san.startsWith('O-O')) return sfx.castle;
  if (san.includes('x')) return sfx.capture;
  return sfx.move;
}

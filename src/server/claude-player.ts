import Anthropic from '@anthropic-ai/sdk';
import { BLUNDER_CHECKLIST } from '../shared/advice.js';
import type { Effort } from '../shared/types.js';

export const CLAUDE_MODELS: Array<{ id: string; label: string; fallback: boolean }> = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', fallback: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', fallback: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', fallback: false },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', fallback: true },
];

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface ClaudeMoveRequest {
  model: string;
  effort: Effort;
  side: 'white' | 'black';
  /** Board briefing (same text external agents receive). */
  briefing: string;
  /** PNG of the board from the player's side. */
  boardPng: Buffer;
  /** Feedback about rejected earlier answers in this turn. */
  feedback: string[];
  drawOffered: boolean;
  signal?: AbortSignal;
}

export interface ClaudeMoveResponse {
  move: string;
  comment: string;
  acceptDraw: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

/** Non-retryable problems (bad credentials, refusals, malformed output). */
export class ClaudePlayerError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ClaudePlayerError';
  }
}

const SYSTEM_PROMPT = `You are a strong chess player taking part in a game. On each turn you receive a picture of the board from your side, a text description of the position (FEN, an ASCII diagram, the list of pieces, the move history) and the complete list of legal moves.

Think about the position: threats against you, tactics available to you (checks, captures, forks, pins), king safety and piece activity. Then choose your move.

Your answer must be one of the listed legal moves, in SAN or UCI. Use "comment" for one short sentence about your idea; spectators see it, your opponent may too. If your opponent has offered a draw, set accept_draw to true to accept it. If your position is completely lost you may resign by answering "resign" as the move.

${BLUNDER_CHECKLIST.split('\n')
  // This player has no scratch-board tool; the per-turn safety check covers the same ground.
  .filter((line) => !line.startsWith('8.'))
  .join('\n')}`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    move: { type: 'string', description: 'Your move in SAN (e.g. Nf3) or UCI (e.g. g1f3), or "resign".' },
    comment: { type: 'string', description: 'One short sentence explaining the idea behind the move.' },
    accept_draw: { type: 'boolean', description: 'True to accept a pending draw offer.' },
  },
  required: ['move', 'comment', 'accept_draw'],
  additionalProperties: false,
};

/** Plays moves by asking a Claude model through the Anthropic API. */
export class ClaudePlayer {
  private client: Anthropic | null = null;

  constructor(private readonly timeoutMs = 10 * 60_000) {}

  private getClient(): Anthropic {
    // Created lazily so the server starts (and other player types work) without credentials.
    this.client ??= new Anthropic({ timeout: this.timeoutMs, maxRetries: 2 });
    return this.client;
  }

  async chooseMove(req: ClaudeMoveRequest): Promise<ClaudeMoveResponse> {
    const model = CLAUDE_MODELS.find((m) => m.id === req.model);
    let text = req.briefing;
    if (req.feedback.length) text += `\n\nIMPORTANT:\n${req.feedback.join('\n')}`;
    if (req.drawOffered) text += '\n\nYour opponent has offered a draw.';

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.getClient().beta.messages.create(
        {
          model: req.model,
          max_tokens: 16000,
          // Server-side fallback re-runs the request on another model if a safety classifier declines it.
          ...(model?.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          output_config: { effort: req.effort, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: req.boardPng.toString('base64') } },
                { type: 'text', text },
              ],
            },
          ],
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw toPlayerError(err);
    }

    if (response.stop_reason === 'refusal') {
      throw new ClaudePlayerError(`The model declined to answer${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}.`, false);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ClaudePlayerError('The model ran out of output tokens before answering.', true);
    }

    const raw = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    let parsed: { move?: unknown; comment?: unknown; accept_draw?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ClaudePlayerError(`Could not parse the model's answer: ${raw.slice(0, 200)}`, true);
    }
    if (typeof parsed.move !== 'string' || !parsed.move.trim()) {
      throw new ClaudePlayerError('The model did not provide a move.', true);
    }
    return {
      move: parsed.move.trim(),
      comment: typeof parsed.comment === 'string' ? parsed.comment.trim().slice(0, 500) : '',
      acceptDraw: parsed.accept_draw === true,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}

function toPlayerError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ClaudePlayerError('Anthropic API authentication failed. Set ANTHROPIC_API_KEY on the server.', false);
  }
  if (err instanceof Anthropic.NotFoundError) return new ClaudePlayerError(`Unknown model: ${err.message}`, false);
  if (err instanceof Anthropic.BadRequestError) return new ClaudePlayerError(`Bad request: ${err.message}`, false);
  if (err instanceof Anthropic.RateLimitError) return new ClaudePlayerError('Rate limited by the Anthropic API.', true);
  if (err instanceof Anthropic.APIConnectionError) return new ClaudePlayerError(`Connection error: ${err.message}`, true);
  if (err instanceof Anthropic.APIError) return new ClaudePlayerError(`Anthropic API error ${err.status}: ${err.message}`, (err.status ?? 500) >= 500);
  if (err instanceof Error && /credentials|api key|apiKey|authToken/i.test(err.message)) {
    return new ClaudePlayerError('No Anthropic credentials found. Set ANTHROPIC_API_KEY on the server.', false);
  }
  return err instanceof Error ? err : new Error(String(err));
}

import { createHash } from 'node:crypto';
import { getSetting, setSetting } from '../settings.ts';
import type { AgentProviderId, AgentToolSpec, ProviderResult } from './provider.ts';

/** Token limits reported by the selected model's catalog, never inferred from its name. */
export interface ModelContext {
  window: number;
  inputLimit: number;
  compactAt: number;
  source: 'catalog' | 'cache';
}

const positive = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;

export function codexContext(m: {
  context_window?: unknown; max_context_window?: unknown;
  effective_context_window_percent?: unknown; auto_compact_token_limit?: unknown;
}): ModelContext | undefined {
  // Same resolution as Codex ModelInfo: max is a fallback, not an opt-in to a larger window.
  const window = positive(m.context_window) ?? positive(m.max_context_window);
  if (!window) return;
  const percent = Math.min(100, positive(m.effective_context_window_percent) ?? 95);
  const inputLimit = Math.floor(window * percent / 100);
  return { window, inputLimit, compactAt: Math.min(inputLimit, Math.floor(window * .9), positive(m.auto_compact_token_limit) ?? Infinity), source: 'catalog' };
}

export function openrouterContext(m: {
  contextLength?: unknown; topProvider?: { contextLength?: unknown; maxCompletionTokens?: unknown };
}): ModelContext | undefined {
  const limits = [positive(m.contextLength), positive(m.topProvider?.contextLength)].filter((n): n is number => n !== undefined);
  if (!limits.length) return;
  const window = Math.min(...limits);
  // Reserve ten percent for a reply (bounded by the advertised output ceiling).
  const reserve = Math.min(Math.ceil(window * .1), positive(m.topProvider?.maxCompletionTokens) ?? Infinity);
  const inputLimit = window - reserve;
  return { window, inputLimit, compactAt: Math.min(inputLimit, Math.floor(window * .9)), source: 'catalog' };
}

export interface ContextUsage {
  model: string;
  tokens: number;
  window: number | null;
  compactAt: number | null;
  source: ModelContext['source'] | 'unknown';
  input?: number;
  cached?: number;
  cacheWrite?: number;
}

/** ponytail: approximate unseen text at four UTF-8 bytes/token; provider usage anchors
 * subsequent estimates. Opaque reasoning/image bytes are not token counts. A provider
 * tokenizer/count endpoint is needed for exact preflight counts, especially images. */
export function estimateTokens(value: unknown): number {
  const json = JSON.stringify(value, (key, v) => {
    if (key === 'encrypted_content' || key === 'encryptedContent') return '[reasoning]';
    if (typeof v === 'string' && /^data:(?:image|audio|video)\//.test(v)) return '[media]';
    return v;
  }) ?? '';
  return Math.ceil(Buffer.byteLength(json) / 4);
}

interface Measurement {
  model: string; provider: AgentProviderId; input: number; cached?: number; cacheWrite?: number;
  tokens: number; estimate: number; count: number; prefix: string;
}
const prefix = (items: unknown[], count: number) => createHash('sha256').update(JSON.stringify(items.slice(0, count))).digest('hex');
const keyOf = (conv: number) => `agent_context:${conv}`;

export function recordContextUsage(conv: number, provider: AgentProviderId, model: string,
  items: unknown[], instructions: string, tools: AgentToolSpec[], usage: ProviderResult['usage'], outputItems: unknown[] = []): void {
  if (!usage || !Number.isSafeInteger(usage.input) || usage.input < 0) return;
  const next = [...items, ...outputItems];
  const estimate = estimateTokens({ instructions, tools, items: next });
  const output = positive(usage.output) ?? Math.max(0, estimate - estimateTokens({ instructions, tools, items }));
  const measurement: Measurement = { model, provider, ...usage,
    tokens: usage.input + output, estimate, count: next.length, prefix: prefix(next, next.length) };
  setSetting(keyOf(conv), JSON.stringify(measurement));
}

export function contextUsage(conv: number, provider: AgentProviderId, model: string,
  items: unknown[], instructions: string, tools: AgentToolSpec[], limits?: ModelContext | null): ContextUsage {
  let tokens = estimateTokens({ instructions, tools, items });
  let measured: Partial<Pick<Measurement, 'input' | 'cached' | 'cacheWrite'>> = {};
  try {
    const m = JSON.parse(getSetting(keyOf(conv)) ?? 'null') as Measurement | null;
    // Model switches, compaction and reconciled histories invalidate the old measurement.
    if (m && m.model === model && m.provider === provider && m.count <= items.length && m.prefix === prefix(items, m.count)) {
      tokens = Math.max(0, m.tokens + tokens - m.estimate);
      measured = { input: m.input, cached: m.cached, cacheWrite: m.cacheWrite };
    }
  } catch { /* No measurement yet. */ }
  return { model, tokens, window: limits?.window ?? null, compactAt: limits?.compactAt ?? null,
    source: limits?.source ?? 'unknown', ...measured };
}

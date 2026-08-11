/**
 * Provider-agnostic LLM client, OpenAI /chat/completions wire format.
 *
 * PS-18 mandates open-source LLMs. That is a constraint on the *model*, not on
 * who owns the GPU. GPU quota for self-hosted vLLM is still pending, so today we
 * call open-weight models through a hosted OpenAI-compatible endpoint. vLLM
 * serves the identical interface, so migrating is a config change:
 *
 *     LLM_BASE_URL=http://sentinel-vllm/v1
 *     LLM_MODEL=<whatever we serve>
 *
 * No code in this file or its callers changes. Keep it that way — endpoint and
 * model selection must never become a code concern.
 *
 * Never fabricates. Every failure path throws LlmUnavailableError carrying the
 * real upstream cause so the UI can render an explicit "AI unavailable" state.
 * A plausible-looking invented assessment is worse than a visible failure.
 *
 * NOTE: cache and call log are per-process and in-memory. They reset on
 * container restart and are not shared across replicas. That is adequate for a
 * demo on a free tier; a shared cache needs Redis or Postgres.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// ─── Errors ────────────────────────────────────────────────────────────────

export class LlmUnavailableError extends Error {
  readonly provider?: string;
  readonly status?: number;
  constructor(message: string, opts?: { provider?: string; status?: number }) {
    super(message);
    this.name = "LlmUnavailableError";
    this.provider = opts?.provider;
    this.status = opts?.status;
  }
}

// ─── Provider configuration ────────────────────────────────────────────────

export interface ProviderConfig {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function readProvider(prefix: "LLM" | "LLM_FALLBACK", label: string): ProviderConfig | null {
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const apiKey = prefix === "LLM" ? process.env.LLM_API_KEY : process.env.LLM_FALLBACK_KEY;
  const model = process.env[`${prefix}_MODEL`];
  if (!baseUrl || !apiKey || !model) return null;
  return { label, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

const primaryProvider = () => readProvider("LLM", "primary");
const fallbackProvider = () => readProvider("LLM_FALLBACK", "fallback");

// ─── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  text: string;
  model: string;
  storedAt: number;
}

const CACHE_MAX = 500;
const cache = new Map<string, CacheEntry>();

async function sha256(input: string): Promise<string> {
  // Dynamic import keeps node:crypto out of anything the bundler might trace
  // toward the client.
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

/** Map preserves insertion order, so the first key is the oldest. */
function cacheSet(key: string, entry: CacheEntry) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

// ─── Call log ──────────────────────────────────────────────────────────────

export interface LlmCallLog {
  at: string;
  provider: string;
  model: string;
  promptHash: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  cacheHit: boolean;
  ok: boolean;
  error?: string;
}

const LOG_MAX = 200;
const callLog: LlmCallLog[] = [];

function record(entry: LlmCallLog) {
  callLog.push(entry);
  if (callLog.length > LOG_MAX) callLog.shift();
}

// ─── Core call ─────────────────────────────────────────────────────────────

interface ChatOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Set for JSON tasks — lowers temperature and asks for raw JSON. */
  json?: boolean;
}

interface ChatResult {
  text: string;
  model: string;
  provider: string;
  cacheHit: boolean;
}

async function chatOnce(
  cfg: ProviderConfig,
  prompt: string,
  opts: ChatOptions,
): Promise<{ text: string; promptTokens: number | null; completionTokens: number | null }> {
  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? (opts.json ? 0.1 : 0.3),
        max_tokens: opts.maxTokens ?? 2000,
      }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (err: any) {
    throw new LlmUnavailableError(
      `${cfg.label} (${cfg.model}) request failed: ${err?.message ?? String(err)}`,
      { provider: cfg.label },
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LlmUnavailableError(
      `${cfg.label} (${cfg.model}) returned HTTP ${res.status}: ${body.slice(0, 300)}`,
      { provider: cfg.label, status: res.status },
    );
  }

  const json: any = await res.json();
  const choice = json?.choices?.[0];
  const message = choice?.message;
  const text = message?.content;
  const finish = choice?.finish_reason;

  // Both sarvam-105b and gpt-oss are REASONING models: they emit chain-of-thought
  // into `reasoning_content` (Sarvam) / `reasoning` (Groq) and only then fill
  // `content`. That thinking is billed against max_tokens, so a budget sized for
  // the answer alone returns finish_reason "length" with content null. Verified
  // 2026-08-03: max_tokens 16 -> empty content; 400 -> clean answer.
  if (typeof text !== "string" || !text.trim()) {
    const thought = message?.reasoning_content ?? message?.reasoning ?? "";
    if (finish === "length") {
      throw new LlmUnavailableError(
        `${cfg.label} (${cfg.model}) exhausted its token budget during internal ` +
          `reasoning before producing an answer (${thought.length} chars of reasoning). ` +
          `Raise maxTokens for this call.`,
        { provider: cfg.label },
      );
    }
    throw new LlmUnavailableError(
      `${cfg.label} (${cfg.model}) returned no message content (finish_reason: ${finish ?? "unknown"}).`,
      { provider: cfg.label },
    );
  }

  // Truncated output is not a usable analytical product — a half-written brief
  // or a JSON object missing its closing brace must fail loudly, not be returned.
  if (finish === "length") {
    throw new LlmUnavailableError(
      `${cfg.label} (${cfg.model}) response was truncated at the token limit. ` +
        `Raise maxTokens rather than using a partial result.`,
      { provider: cfg.label },
    );
  }

  return {
    text,
    promptTokens: json?.usage?.prompt_tokens ?? null,
    completionTokens: json?.usage?.completion_tokens ?? null,
  };
}

/** Retry against the fallback only for transient conditions, not bad requests. */
function isTransient(err: unknown): boolean {
  const status = err instanceof LlmUnavailableError ? err.status : undefined;
  if (status === undefined) return true; // network/timeout
  return status === 429 || status >= 500;
}

/**
 * Exported so task-specific modules (analysis-llm.ts) can own their own prompts
 * without duplicating transport, caching, failover or the reasoning-model
 * handling above. Prompts stay server-side in those modules; the browser only
 * ever calls a typed server function, so no raw prompt crosses the wire.
 */
export async function chat(prompt: string, opts: ChatOptions = {}): Promise<ChatResult> {
  const primary = primaryProvider();
  const fallback = fallbackProvider();

  if (!primary && !fallback) {
    throw new LlmUnavailableError(
      "No LLM provider configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL " +
        "(and optionally the LLM_FALLBACK_* trio).",
    );
  }

  const chain = [primary, fallback].filter(Boolean) as ProviderConfig[];
  const cacheKey = await sha256(`${chain[0].model}::${opts.system ?? ""}::${prompt}`);

  const hit = cache.get(cacheKey);
  if (hit) {
    record({
      at: new Date().toISOString(),
      provider: "cache",
      model: hit.model,
      promptHash: cacheKey.slice(0, 12),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      cacheHit: true,
      ok: true,
    });
    return { text: hit.text, model: hit.model, provider: "cache", cacheHit: true };
  }

  let lastErr: unknown;
  for (let i = 0; i < chain.length; i += 1) {
    const cfg = chain[i];
    const started = Date.now();
    try {
      const out = await chatOnce(cfg, prompt, opts);
      const latencyMs = Date.now() - started;

      record({
        at: new Date().toISOString(),
        provider: cfg.label,
        model: cfg.model,
        promptHash: cacheKey.slice(0, 12),
        promptTokens: out.promptTokens,
        completionTokens: out.completionTokens,
        latencyMs,
        cacheHit: false,
        ok: true,
      });

      cacheSet(cacheKey, { text: out.text, model: cfg.model, storedAt: Date.now() });
      return { text: out.text, model: cfg.model, provider: cfg.label, cacheHit: false };
    } catch (err: any) {
      lastErr = err;
      record({
        at: new Date().toISOString(),
        provider: cfg.label,
        model: cfg.model,
        promptHash: cacheKey.slice(0, 12),
        promptTokens: null,
        completionTokens: null,
        latencyMs: Date.now() - started,
        cacheHit: false,
        ok: false,
        error: err?.message ?? String(err),
      });

      // A 400/401/404 is our mistake or a bad key; failing over would just
      // produce a second identical failure and burn fallback quota.
      const more = i < chain.length - 1;
      if (!more || !isTransient(err)) break;
    }
  }

  throw lastErr instanceof LlmUnavailableError ? lastErr : new LlmUnavailableError(String(lastErr));
}

// ─── JSON handling ─────────────────────────────────────────────────────────

/** Models wrap JSON in ``` fences despite instructions; strip before parsing. */
function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

// Generic over the schema rather than over a bare T: binding to z.ZodType<T>
// makes TypeScript unify T with the schema's INPUT type, so any field carrying
// a .default() came back optional and every caller had to re-assert it.
export async function chatJson<S extends z.ZodTypeAny>(
  prompt: string,
  schema: S,
  opts: ChatOptions = {},
): Promise<{ value: z.infer<S>; model: string; provider: string; cacheHit: boolean }> {
  const res = await chat(prompt, { ...opts, json: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(res.text));
  } catch {
    throw new LlmUnavailableError(
      `${res.model} did not return valid JSON. First 200 chars: ${res.text.slice(0, 200)}`,
      { provider: res.provider },
    );
  }

  const check = schema.safeParse(parsed);
  if (!check.success) {
    // Coercing here would invent structure the model did not produce.
    throw new LlmUnavailableError(
      `${res.model} returned JSON not matching the expected schema: ${check.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      { provider: res.provider },
    );
  }

  return { value: check.data, model: res.model, provider: res.provider, cacheHit: res.cacheHit };
}

// ─── Schemas ───────────────────────────────────────────────────────────────

export const SummarySchema = z.object({
  summary: z.string().min(1),
  keyPoints: z.array(z.string()).max(6).default([]),
});
export type Summary = z.infer<typeof SummarySchema>;

export const EntitySchema = z.object({
  entity: z.string().min(1),
  type: z.enum(["PERSON", "ORGANISATION", "LOCATION", "EQUIPMENT", "EVENT", "OTHER"]),
  confidence: z.number().min(0).max(1),
});
export const EntitiesSchema = z.object({ entities: z.array(EntitySchema).max(40) });
export type ExtractedEntity = z.infer<typeof EntitySchema>;

export const LanguageAssessmentSchema = z.object({
  emotiveLoad: z.number().min(0).max(1),
  hedging: z.number().min(0).max(1),
  absolutism: z.number().min(0).max(1),
  sensationalism: z.number().min(0).max(1),
  rationale: z.string().min(1),
});
export type LanguageAssessment = z.infer<typeof LanguageAssessmentSchema>;

// ─── Public server functions ───────────────────────────────────────────────

const ANALYST_SYSTEM =
  "You are an OSINT analyst assistant. State only what the supplied source states. " +
  "Never speculate, never add facts not present in the text. Reply with raw JSON only, " +
  "no markdown fences and no commentary.";

export async function summariseText(data: { text: string; source?: string }) {
  const text = (data?.text || "").trim();
  if (!text) throw new LlmUnavailableError("No text supplied to summarise.");

  const prompt = `Summarise the article below for an intelligence briefing.

Rules:
- 2-3 sentences, factual, no embellishment.
- State only what the source states. If the source is thin, say less.
- Do not infer motive, blame or consequence that the text does not state.

Return JSON: {"summary": string, "keyPoints": string[] (max 4)}

${data?.source ? `Source: ${data.source}\n` : ""}Article:
"""
${text.slice(0, 6000)}
"""`;

  const out = await chatJson(prompt, SummarySchema, { system: ANALYST_SYSTEM, maxTokens: 1500 });
  return { ...out.value, model: out.model, provider: out.provider, cacheHit: out.cacheHit };
}

export async function extractEntitiesFrom(data: { text: string }) {
  const text = (data?.text || "").trim();
  if (!text) throw new LlmUnavailableError("No text supplied for entity extraction.");

  const prompt = `Extract named entities from the text below.

Rules:
- Only entities explicitly present in the text.
- "confidence" is YOUR calibrated certainty (0-1) that the extraction is correct.
- type must be one of: PERSON, ORGANISATION, LOCATION, EQUIPMENT, EVENT, OTHER.

Return JSON: {"entities": [{"entity": string, "type": string, "confidence": number}]}

Text:
"""
${text.slice(0, 6000)}
"""`;

  const out = await chatJson(prompt, EntitiesSchema, { system: ANALYST_SYSTEM, maxTokens: 2200 });
  return {
    entities: out.value.entities,
    model: out.model,
    provider: out.provider,
    cacheHit: out.cacheHit,
  };
}

export async function assessLanguageOf(data: { text: string }) {
  const text = (data?.text || "").trim();
  if (!text) throw new LlmUnavailableError("No text supplied for language assessment.");

  const prompt = `Assess the LANGUAGE of the text below. Judge how it is written, not
whether its claims are true.

Score each 0-1 (0 = absent, 1 = extreme):
- emotiveLoad: emotionally charged or loaded wording
- hedging: qualifiers such as "reportedly", "allegedly", "sources say"
- absolutism: unqualified absolute claims ("always", "never", "proves")
- sensationalism: framing engineered for reaction over information

Also give a one-sentence "rationale" citing specific wording.

Return JSON: {"emotiveLoad": number, "hedging": number, "absolutism": number,
"sensationalism": number, "rationale": string}

Text:
"""
${text.slice(0, 4000)}
"""`;

  const out = await chatJson(prompt, LanguageAssessmentSchema, {
    system: ANALYST_SYSTEM,
    maxTokens: 1400,
  });
  return { ...out.value, model: out.model, provider: out.provider, cacheHit: out.cacheHit };
}

export const ContentAnalysisSchema = z.object({
  topic: z.enum([
    "Cyber Threat",
    "Military Operations",
    "Disinformation",
    "Political",
    "Economic",
    "Natural Disaster",
    "Other",
  ]),
  sentiment: z.enum(["positive", "neutral", "negative", "critical"]),
  threatLevel: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().min(1),
  keywords: z.array(z.string()).max(5).default([]),
});
export type ContentAnalysis = z.infer<typeof ContentAnalysisSchema>;

export async function analyseContentOf(data: { text: string }) {
  const text = (data?.text || "").trim();
  if (!text) throw new LlmUnavailableError("No text supplied for content analysis.");

  const prompt = `Classify the text below.

Return JSON:
{"topic": one of [Cyber Threat, Military Operations, Disinformation, Political, Economic, Natural Disaster, Other],
 "sentiment": one of [positive, neutral, negative, critical],
 "threatLevel": one of [low, medium, high, critical],
 "summary": one factual sentence,
 "keywords": up to 5 key terms}

Base every field only on the text. Do not infer beyond it.

Text:
"""
${text.slice(0, 6000)}
"""`;

  const out = await chatJson(prompt, ContentAnalysisSchema, {
    system: ANALYST_SYSTEM,
    maxTokens: 1600,
  });
  return { ...out.value, model: out.model, provider: out.provider, cacheHit: out.cacheHit };
}

// ─── Narrative generation ──────────────────────────────────────────────────
// These return prose rather than JSON, so they are validated only for non-empty
// content. Task-specific signatures keep raw prompts off the client, which would
// otherwise be an injection surface.

const NARRATIVE_SYSTEM =
  "You are an intelligence analyst. Write in formal, precise language. Use only the " +
  "information supplied. Where evidence is absent, say so explicitly rather than " +
  "inferring. Never invent figures, dates, names or confidence values.";

export async function caseSummaryOf(data: {
  title: string;
  target: string;
  description: string;
  risk: number;
}) {
  const prompt = `Write an intelligence dossier summary for this investigation.

Structure: Executive Overview, Key Findings, Threat Assessment, Recommendations.
Under 300 words. If a section lacks supporting information, state that plainly.

Case Title: ${data.title}
Target Subject: ${data.target}
Analyst-assigned Risk Score: ${
    // A negative value means the analyst never assigned one. Saying so keeps
    // the model from reasoning off a number nobody set — callers used to
    // substitute a default of 70, which the brief then treated as a finding.
    typeof data.risk === "number" && data.risk >= 0
      ? `${data.risk}/100`
      : "not assigned by the analyst — do not infer or estimate one"
  }
Description: ${data.description}`;

  const res = await chat(prompt, { system: NARRATIVE_SYSTEM, maxTokens: 2200 });
  return { text: res.text, model: res.model, provider: res.provider, cacheHit: res.cacheHit };
}

export async function executiveBriefOf(data: { target: string; context: string }) {
  const prompt = `Write a concise executive intelligence brief.

Cover: Strategic Profile, Known Capabilities, Risk Assessment, Recommended Action.
Under 250 words, bullet points where useful. Where the supplied context does not
support a section, say "insufficient collected information" rather than speculating.

Target: ${data.target}
Collected context: ${data.context}`;

  const res = await chat(prompt, { system: NARRATIVE_SYSTEM, maxTokens: 2000 });
  return { text: res.text, model: res.model, provider: res.provider, cacheHit: res.cacheHit };
}

export async function reportOf(data: { type: string; target: string; data: string }) {
  const prompt = `Generate a structured ${data.type} intelligence report.

Sections: Executive Summary, Key Findings, Threat Assessment, Entity Analysis,
Recommendations, Conclusion. Under 500 words.

Use ONLY the collected data below. Do not introduce facts, figures or attributions
that are absent from it. Where a section cannot be supported, write "No supporting
data collected."

Target: ${data.target}
Collected data:
${data.data}`;

  const res = await chat(prompt, { system: NARRATIVE_SYSTEM, maxTokens: 2800 });
  return { text: res.text, model: res.model, provider: res.provider, cacheHit: res.cacheHit };
}

// ─── Observability ─────────────────────────────────────────────────────────

export interface LlmStats {
  configured: boolean;
  primary: { model: string; baseUrl: string } | null;
  fallback: { model: string; baseUrl: string } | null;
  totalCalls: number;
  cacheHits: number;
  cacheMisses: number;
  failures: number;
  cacheSize: number;
  cacheLimit: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number;
  recent: LlmCallLog[];
}

export async function llmStatsSnapshot(): Promise<LlmStats> {
  const p = primaryProvider();
  const f = fallbackProvider();

  const hits = callLog.filter((c) => c.cacheHit).length;
  const failures = callLog.filter((c) => !c.ok).length;
  const network = callLog.filter((c) => !c.cacheHit && c.ok);
  const avg = network.length
    ? Math.round(network.reduce((s, c) => s + c.latencyMs, 0) / network.length)
    : 0;

  return {
    configured: Boolean(p || f),
    // Keys are never included here — this is rendered in the browser.
    primary: p ? { model: p.model, baseUrl: p.baseUrl } : null,
    fallback: f ? { model: f.model, baseUrl: f.baseUrl } : null,
    totalCalls: callLog.length,
    cacheHits: hits,
    cacheMisses: callLog.length - hits,
    failures,
    cacheSize: cache.size,
    cacheLimit: CACHE_MAX,
    promptTokens: callLog.reduce((s, c) => s + (c.promptTokens ?? 0), 0),
    completionTokens: callLog.reduce((s, c) => s + (c.completionTokens ?? 0), 0),
    avgLatencyMs: avg,
    recent: callLog.slice(-25).reverse(),
  };
}

// ─── Server-function wrappers ──────────────────────────────────────────────
// The logic above lives in plain async functions so it is directly testable and
// reusable server-side. These thin wrappers are what the browser calls; they add
// no behaviour beyond transport.

export const llmSummarise = createServerFn({ method: "POST" })
  .validator((d: { text: string; source?: string }) => d)
  .handler(async ({ data }) => summariseText(data));

export const llmExtractEntities = createServerFn({ method: "POST" })
  .validator((d: { text: string }) => d)
  .handler(async ({ data }) => extractEntitiesFrom(data));

export const llmAssessLanguage = createServerFn({ method: "POST" })
  .validator((d: { text: string }) => d)
  .handler(async ({ data }) => assessLanguageOf(data));

export const llmAnalyseContent = createServerFn({ method: "POST" })
  .validator((d: { text: string }) => d)
  .handler(async ({ data }) => analyseContentOf(data));

export const llmCaseSummary = createServerFn({ method: "POST" })
  .validator((d: { title: string; target: string; description: string; risk: number }) => d)
  .handler(async ({ data }) => caseSummaryOf(data));

export const llmExecutiveBrief = createServerFn({ method: "POST" })
  .validator((d: { target: string; context: string }) => d)
  .handler(async ({ data }) => executiveBriefOf(data));

export const llmReport = createServerFn({ method: "POST" })
  .validator((d: { type: string; target: string; data: string }) => d)
  .handler(async ({ data }) => reportOf(data));

export const getLlmStats = createServerFn({ method: "GET" }).handler(async () =>
  llmStatsSnapshot(),
);

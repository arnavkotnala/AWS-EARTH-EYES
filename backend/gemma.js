/**
 * Earth Intelligence Platform — shared Gemma 4 client (gemma.js)
 * ==============================================================
 * One place that talks to Gemma 4, used by Treeko (Forest Eyes), Aqua (River Eyes)
 * and the Hazard Lens. Server-side only: keys come from the .env file.
 *
 * Providers, tried in this order:
 *   1. Amazon Bedrock  (Gemma 4)  — if BEDROCK_API_KEY and BEDROCK_MODEL_ID are set
 *   2. Gemini API      (Gemma 4)  — GEMINI_API_KEY + GEMMA_MODELS
 *   3. Gemini API      (Gemini)   — only if GEMINI_FALLBACK_MODEL is set
 * Gemma 4 on the free Gemini API often answers "500", hangs or refuses at random, so every
 * attempt is time-capped and retried inside one overall budget. Every answer reports which
 * provider/model produced it, so the UI can be honest about it.
 */
'use strict';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const settings = () => ({
  geminiKey: (process.env.GEMINI_API_KEY || '').trim(),
  gemmaModels: (process.env.GEMMA_MODELS || 'gemma-4-26b-a4b-it,gemma-4-31b-it')
    .split(',').map(s => s.trim()).filter(Boolean),
  fallback: (process.env.GEMINI_FALLBACK_MODEL || '').trim(),
  bedrockKey: (process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK || '').trim(),
  bedrockRegion: (process.env.BEDROCK_REGION || 'us-east-1').trim(),
  bedrockModel: (process.env.BEDROCK_MODEL_ID || '').trim(),
  attempts: Number(process.env.GEMMA_ATTEMPTS) || 3,
  // Each attempt is capped, and so is the whole call (the chat UIs give up at ~75 s).
  timeoutMs: Number(process.env.GEMMA_TIMEOUT_MS) || 35000,
  budgetMs: Number(process.env.GEMMA_BUDGET_MS) || 70000,
});

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildPlan(cfg) {
  const plan = [];
  if (cfg.bedrockKey && cfg.bedrockModel) {
    plan.push(...Array(2).fill({ provider: 'bedrock', model: cfg.bedrockModel }));
  }
  if (cfg.geminiKey) {
    cfg.gemmaModels.forEach((model, i) =>
      plan.push(...Array(i === 0 ? cfg.attempts : 1).fill({ provider: 'gemini', model })));
    if (cfg.fallback) plan.push({ provider: 'gemini', model: cfg.fallback, fallback: true });
  }
  return plan;
}

/** What the server is set up to use (for /api/health — never includes keys). */
function describe() {
  return buildPlan(settings())
    .filter((s, i, a) => a.findIndex(x => x.provider === s.provider && x.model === s.model) === i)
    .map(s => (s.fallback ? 'backup model' : `${s.provider === 'gemini' ? 'google-ai-studio' : s.provider}:${s.model}`));
}

/**
 * @param {object} req
 * @param {string} [req.system]    System prompt (prepended to the first user turn: Gemma has no system role)
 * @param {Array}  req.contents    Gemini-style contents: [{role:'user'|'model', parts:[{text}|{inline_data:{mime_type,data}}]}]
 * @param {object} [req.schema]    JSON schema → JSON answer
 * @param {number} [req.timeoutMs] Per-attempt timeout (raised to the configured minimum)
 * @returns {Promise<{text:string, model:string, provider:string}>}
 */
async function generate({ system, contents, schema, timeoutMs } = {}, fetchImpl = fetch) {
  const cfg = settings();
  const plan = buildPlan(cfg);
  if (!plan.length) throw httpError(503, 'AI is not set up: add GEMINI_API_KEY (or a Bedrock key) to the server settings.');
  if (!Array.isArray(contents) || !contents.length) throw httpError(400, 'Nothing to send to the model.');

  const turns = withSystem(contents, system, schema);
  const fallbackAt = plan.findIndex(s => s.fallback);
  const deadline = Date.now() + cfg.budgetMs;
  let lastErr;

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    // Keep 15 s of the budget for the fallback model, if there is one.
    const reserve = fallbackAt > i ? 15000 : 0;
    const remaining = deadline - Date.now() - reserve;
    if (remaining < 5000) {
      if (fallbackAt > i) { i = fallbackAt - 1; continue; }
      break;
    }
    const perAttempt = Math.min(Math.max(timeoutMs || 0, cfg.timeoutMs), remaining);
    try {
      const text = step.provider === 'bedrock'
        ? await callBedrock(step.model, turns, cfg, perAttempt, fetchImpl)
        : await callGemini(step.model, turns, schema, cfg.geminiKey, perAttempt, fetchImpl);
      // The backup model is reported generically: the UI only names Gemma models.
      const isGemma = step.model.startsWith('gemma');
      return { text, model: isGemma ? step.model : 'backup model', provider: step.provider === 'gemini' ? 'google-ai-studio' : step.provider, gemma: isGemma };
    } catch (err) {
      lastErr = err;
      const retryable = RETRYABLE.has(err.upstreamStatus) || err.retry ||
        err.name === 'TimeoutError' || err.name === 'AbortError';
      console.warn(`[gemma] ${step.provider}:${step.model} failed (${err.upstreamStatus || err.name}: ${String(err.message).slice(0, 120)})`);
      // A bad key or bad request on one provider should not stop the next provider.
      if (!retryable && plan[i + 1]?.provider === step.provider) {
        const next = plan.findIndex((s, j) => j > i && s.provider !== step.provider);
        if (next < 0) break;
        i = next - 1;
      }
      await sleep(300);
    }
  }
  const s = lastErr?.upstreamStatus;
  if (s === 401 || s === 403) throw httpError(502, 'The AI key was rejected. Check the keys in the server settings.');
  if (s === 429) throw httpError(502, 'Too many AI requests right now (rate limit). Try again in a minute.');
  throw httpError(502, 'Gemma 4 could not answer right now. Please try again.');
}

/** Gemma has no system role: put the instructions (and the JSON contract) in the first user turn. */
function withSystem(contents, system, schema) {
  const header = [
    system,
    schema && `Reply with ONLY a JSON object (no markdown fences) matching this JSON schema:\n${JSON.stringify(schema)}`,
  ].filter(Boolean).join('\n\n');
  if (!header) return contents;
  const [first, ...rest] = contents;
  return [{ ...first, parts: [{ text: `${header}\n\n---\n\n` }, ...first.parts] }, ...rest];
}

async function callGemini(model, contents, schema, apiKey, timeoutMs, fetchImpl) {
  const body = { contents };
  // GEMMA_JSON_MODE=prompt: ask for JSON in the prompt only (no constrained decoding).
  if (schema && process.env.GEMMA_JSON_MODE !== 'prompt') {
    body.generationConfig = { responseMimeType: 'application/json', responseJsonSchema: schema };
  }
  const res = await fetchImpl(GEMINI_API + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), { upstreamStatus: res.status });

  const candidate = data?.candidates?.[0];
  const finish = candidate?.finishReason;
  // Gemma 4 may return its reasoning as parts flagged "thought": never show those.
  const text = (candidate?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text || (finish && finish !== 'STOP')) {
    // RECITATION / MAX_TOKENS / empty answers are random with Gemma: just try again.
    throw Object.assign(new Error(`No usable answer (${finish || data?.promptFeedback?.blockReason || 'empty'})`), { retry: true });
  }
  return text;
}

/** Amazon Bedrock Converse API with a Bedrock API key (bearer token) — no AWS SDK needed. */
async function callBedrock(modelId, contents, cfg, timeoutMs, fetchImpl) {
  const messages = contents.map(c => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: c.parts.map(p => p.inline_data
      ? { image: { format: String(p.inline_data.mime_type || 'image/jpeg').split('/')[1].replace('jpg', 'jpeg'), source: { bytes: p.inline_data.data } } }
      : { text: p.text || '' }),
  }));
  const url = `https://bedrock-runtime.${cfg.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.bedrockKey}` },
    body: JSON.stringify({ messages, inferenceConfig: { maxTokens: 2048, temperature: 0.4 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.message || `HTTP ${res.status}`), { upstreamStatus: res.status });
  // Skip reasoning blocks; keep only the answer text.
  const text = (data?.output?.message?.content || []).map(b => b.text || '').join('').trim();
  if (!text) throw Object.assign(new Error(`Empty answer (${data?.stopReason || 'unknown'})`), { retry: true });
  return text;
}

/** Parses a JSON answer, tolerating ```json fences the model sometimes adds. */
function parseJson(text) {
  const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(clean);
}

module.exports = { generate, parseJson, describe, settings };

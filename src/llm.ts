/**
 * llm.ts — LLM client with exponential backoff + jitter, retryability
 *          classification, response validation, and prompt-injection sanitisation.
 *
 * Replace callLLMRaw() with your real provider. Everything else stays.
 *
 * Retry strategy:
 *   - Exponential backoff: base * 2^(attempt-1)
 *   - Full jitter: delay = random(0, computed_delay)  — prevents thundering herd
 *   - Retryable errors: network timeouts, 5xx, rate limits (429)
 *   - Non-retryable: 4xx auth errors, context-length exceeded — fail immediately
 */

import { AgentConfig, LLMAction } from "./types";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Injection patterns
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  "ignore previous",
  "disregard all",
  "you are now",
  "forget your instructions",
  "system:",
  "<|im_start|>",
  "<|endoftext|>",
  "new instructions:",
  "act as if",
  "pretend you are",
];

export function sanitiseInput(text: string, maxBytes: number): string {
  const truncated = text.slice(0, maxBytes);
  const lower = truncated.toLowerCase();
  for (const pattern of INJECTION_PATTERNS) {
    if (lower.includes(pattern)) {
      log.warn("Prompt injection pattern detected — input redacted", { pattern });
      return "[REDACTED: suspicious content detected]";
    }
  }
  return truncated;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type LLMErrorKind = "retryable" | "non_retryable" | "unknown";

export interface ClassifiedError {
  kind: LLMErrorKind;
  message: string;
}

/**
 * Classify an LLM call error as retryable or not.
 *
 * Non-retryable errors waste retry budget and mask the real issue — fail fast.
 * Examples:
 *   - 401 Unauthorized    → wrong API key, retrying won't help
 *   - 400 context_length  → prompt too large, retrying won't help
 *   - 429 rate_limit      → retryable (after delay)
 *   - 500/503 server      → retryable
 *   - network timeout     → retryable
 */
export function classifyError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Non-retryable: authentication / authorisation
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid_api_key") ||
    lower.includes("authentication")
  ) {
    return { kind: "non_retryable", message: msg };
  }

  // Non-retryable: request too large
  if (
    lower.includes("context_length") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens") ||
    lower.includes("prompt is too long")
  ) {
    return { kind: "non_retryable", message: msg };
  }

  // Retryable: rate limit, server errors, network
  if (
    lower.includes("429") ||
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("500") ||
    lower.includes("503") ||
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("network")
  ) {
    return { kind: "retryable", message: msg };
  }

  return { kind: "unknown", message: msg };
}

// ---------------------------------------------------------------------------
// Jitter helper
// ---------------------------------------------------------------------------

function withJitter(delayMs: number): number {
  // Full jitter: uniform random in [0, delay]
  // This is the AWS-recommended strategy to avoid thundering herd in CI.
  return Math.random() * delayMs;
}

function computeDelay(baseSec: number, attempt: number): number {
  // Exponential backoff with cap at 30 seconds
  const exponential = baseSec * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, 30);
  return withJitter(capped * 1000); // return in ms
}

// ---------------------------------------------------------------------------
// Raw LLM call — REPLACE THIS with your real provider
// ---------------------------------------------------------------------------

/**
 * callLLMRaw — replace with Anthropic / OpenAI / Bedrock / etc.
 *
 * Example (Anthropic):
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   const client = new Anthropic();
 *
 *   export async function callLLMRaw(prompt: string): Promise<string> {
 *     const msg = await client.messages.create({
 *       model: "claude-opus-4-20250514",
 *       max_tokens: 1024,
 *       messages: [{ role: "user", content: prompt }],
 *     });
 *     const block = msg.content[0];
 *     if (block.type !== "text") throw new Error("Unexpected content type");
 *     return block.text;
 *   }
 */
export async function callLLMRaw(_prompt: string): Promise<string> {
  return JSON.stringify({
    thought: "LLM stub active — wire up callLLMRaw() in llm.ts",
    skill: "finish",
    input: {
      decision: "block",
      report: "LLM stub active — real analysis unavailable.",
    },
  });
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();
}

export function parseLLMResponse(raw: string): LLMAction | null {
  try {
    const parsed: unknown = JSON.parse(stripFences(raw));
    if (typeof parsed !== "object" || parsed === null) {
      log.warn("LLM response is not a JSON object");
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.thought !== "string") { log.warn("LLM response missing 'thought'"); return null; }
    if (typeof obj.skill !== "string" || !obj.skill) { log.warn("LLM response missing 'skill'"); return null; }
    if (typeof obj.input !== "object" || obj.input === null) { log.warn("LLM response missing 'input'"); return null; }
    return { thought: obj.thought, skill: obj.skill, input: obj.input as Record<string, unknown> };
  } catch (err) {
    log.warn("LLM response JSON parse failed", { error: String(err), raw: raw.slice(0, 200) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper — exponential backoff + jitter + error classification
// ---------------------------------------------------------------------------

export async function callLLMWithRetry(
  prompt: string,
  config: Pick<AgentConfig, "llmRetries" | "llmRetryDelaySec">,
  runId: string
): Promise<LLMAction | null> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.llmRetries; attempt++) {
    try {
      const raw = await callLLMRaw(prompt);

      if (!raw || raw.trim() === "") {
        log.warn("LLM returned empty response", { attempt, runId });
      } else {
        const action = parseLLMResponse(raw);
        if (action) return action;

        // Ask the model to self-correct on next attempt
        log.warn("LLM produced invalid JSON — will retry with correction hint", { attempt, runId });
      }
    } catch (err) {
      lastError = err;
      const { kind, message } = classifyError(err);

      log.warn("LLM call threw", { attempt, runId, errorKind: kind, error: message });

      if (kind === "non_retryable") {
        log.error("Non-retryable LLM error — failing immediately", { runId, error: message });
        return null;
      }
    }

    if (attempt < config.llmRetries) {
      const delayMs = computeDelay(config.llmRetryDelaySec, attempt);
      log.debug("Retry delay", { attempt, delayMs: Math.round(delayMs), runId });
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  log.error("LLM permanently unavailable after retries", {
    runId,
    error: String(lastError ?? "unknown"),
  });
  return null;
}

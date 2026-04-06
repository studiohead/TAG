/**
 * types.ts — Canonical types for the Test Governance Agent.
 *
 * Single source of truth. No type is defined more than once.
 * All other modules import from here.
 */

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export enum Decision {
  PASS = "pass",
  WARN = "warn",
  BLOCK = "block",
}

/** Narrow an arbitrary string to a Decision, defaulting to BLOCK (fail-closed). */
export function toDecision(value: unknown): Decision {
  if (value === Decision.PASS) return Decision.PASS;
  if (value === Decision.WARN) return Decision.WARN;
  return Decision.BLOCK;
}

// ---------------------------------------------------------------------------
// Skills / policy
// ---------------------------------------------------------------------------

export interface SkillRule {
  id: string;
  /** DSL expression — see policy.ts */
  condition: string;
  decision: Decision;
  reason: string;
  /** Higher priority rules are evaluated first. Default 0. */
  priority?: number;
}

export interface Skill {
  name: string;
  description?: string;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  rules?: SkillRule[];
}

// ---------------------------------------------------------------------------
// Agent config
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Maximum LLM-loop iterations before fail-closed. Ignored in no-LLM mode. */
  maxSteps: number;
  /** Decision when no rule matches or agent errors out. */
  defaultDecision: Decision;
  /** Path to the YAML skills directory. */
  skillsDir: string;
  /** Append-only JSONL audit trail path (optional). */
  auditLogPath?: string;
  /** Machine-readable JSON report output path (optional). */
  reportPath?: string;
  /** Max bytes of git diff forwarded to the LLM. */
  maxDiffBytes: number;
  /** Max bytes of a single failure log entry. */
  maxLogBytes: number;
  /** Max number of failure entries forwarded to the LLM. */
  maxFailures: number;
  /** Number of LLM retries on transient errors. */
  llmRetries: number;
  /** Base delay in seconds between retries. */
  llmRetryDelaySec: number;
  /**
   * When true, skip the LLM loop entirely and run only the deterministic
   * invariant + executor + policy pipeline. Safe fallback for LLM outages.
   */
  noLLMMode: boolean;
}

// ---------------------------------------------------------------------------
// Agent context
// ---------------------------------------------------------------------------

export interface AgentContext {
  failures: string[];
  diff: string;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface LLMAction {
  thought: string;
  skill: string;
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Invariant violations — non-overridable hard blocks
// ---------------------------------------------------------------------------

export type InvariantId =
  | "assertion_count_decreased"
  | "tests_and_code_both_modified"
  | "no_tests_for_changed_code";

export interface InvariantViolation {
  id: InvariantId;
  reason: string;
  evidence: string;
}

export interface InvariantResult {
  violations: InvariantViolation[];
  /** True if any hard-block invariant was violated. */
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// Assertion analysis — richer scoring
// ---------------------------------------------------------------------------

/** Strictness ordering: higher index = stricter matcher */
export const MATCHER_STRICTNESS: readonly string[] = [
  "toContain",
  "toContainEqual",
  "toMatchObject",
  "toEqual",
  "toStrictEqual",
  "toBe",
] as const;

export interface AssertionMetrics {
  count: number;
  matchers: string[];
  /** Average strictness score (index in MATCHER_STRICTNESS, or -1 if unknown) */
  avgStrictness: number;
  /** Number of assertions wrapped in conditional branches */
  conditionallyWrapped: number;
  parseError: boolean;
}

export interface AssertionDiff {
  before: AssertionMetrics;
  after: AssertionMetrics;
  /** Count delta: negative = assertions removed */
  countDelta: number;
  /** Strictness delta: negative = weakened */
  strictnessDelta: number;
  /** Net new assertions wrapped behind conditional branches */
  conditionalWrappingAdded: number;
  parseError: boolean;
}

// ---------------------------------------------------------------------------
// Skill results
// ---------------------------------------------------------------------------

export interface SkillResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface AssertionChangeResult extends SkillResult {
  risk: "low" | "medium" | "high";
  reason: string;
  beforeCount: number;
  afterCount: number;
  parseError: boolean;
  metrics: AssertionDiff;
}

export interface FailureSummaryResult extends SkillResult {
  summary: string;
  likelyCauses: string[];
  truncated: boolean;
}

export interface PolicyResult extends SkillResult {
  decision: Decision;
  reason: string;
  /** Every rule that fired (accumulate-then-decide model) */
  matchedRules: Array<{ id: string; decision: Decision; reason: string }>;
}

export interface ClassifyRiskResult extends SkillResult {
  risk: "low" | "medium" | "high";
  explanation: string;
}

// ---------------------------------------------------------------------------
// Agent step / result
// ---------------------------------------------------------------------------

export interface AgentStep {
  step: number;
  thought: string;
  skill: string;
  input: Record<string, unknown>;
  result: SkillResult;
}

export interface AgentResult {
  decision: Decision;
  report: string;
  runId: string;
  steps: number;
  terminatedEarly: boolean;
  noLLMMode: boolean;
  invariantViolations: InvariantViolation[];
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditRecord {
  runId: string;
  ts: string;
  goal: string;
  steps: AgentStep[];
  decision: Decision;
  report: string;
  contextHash: string;
  terminatedEarly: boolean;
  noLLMMode: boolean;
  invariantViolations: InvariantViolation[];
  error: string | null;
}

/**
 * executor.ts — Deterministic skill execution.
 *
 * All skills here are pure functions: same inputs → same outputs.
 * No LLM is involved. Errors are returned as structured SkillResult,
 * never thrown (fail-closed: callers treat error results as block).
 *
 * The detect_assertion_change skill now uses full AssertionDiff metrics,
 * including matcher strictness scoring and conditional wrapping detection.
 */

import { AssertionExtractor } from "./assertion";
import { PolicyEngine, PolicyEvalResult } from "./policy";
import { CONFIG } from "./config";
import { log } from "./logger";
import {
  AssertionChangeResult,
  AssertionDiff,
  ClassifyRiskResult,
  Decision,
  FailureSummaryResult,
  PolicyResult,
  SkillResult,
} from "./types";

// ---------------------------------------------------------------------------
// Root-cause heuristics for failure summaries
// ---------------------------------------------------------------------------

const CAUSE_KEYWORDS = [
  "assertionerror",
  "assert ",
  "expected",
  "typeerror",
  "referenceerror",
  "cannot read",
  "timeout",
  "received",
  "matcher",
  "to equal",
  "to be",
  "tobeundefined",
  "tobetruthy",
  "tobefalsy",
];

function extractCauses(logText: string): string[] {
  const causes: string[] = [];
  for (const line of logText.split("\n")) {
    const lower = line.toLowerCase();
    if (CAUSE_KEYWORDS.some((k) => lower.includes(k))) {
      causes.push(line.trim());
      if (causes.length >= 5) break;
    }
  }
  return causes.length > 0 ? causes : ["No clear root cause identified"];
}

// ---------------------------------------------------------------------------
// Risk scoring from AssertionDiff
// ---------------------------------------------------------------------------

function scoreAssertionDiff(metrics: AssertionDiff): {
  risk: "low" | "medium" | "high";
  reason: string;
} {
  if (metrics.parseError) {
    return { risk: "high", reason: "Diff contained un-parseable JS/TS — treating as high risk" };
  }

  const reasons: string[] = [];
  let risk: "low" | "medium" | "high" = "low";

  // Count decrease — assertions removed
  if (metrics.countDelta < 0) {
    reasons.push(`${Math.abs(metrics.countDelta)} assertion(s) removed`);
    risk = "high";
  }

  // Matcher strictness weakened (e.g. toBe → toContain)
  if (metrics.strictnessDelta < -0.5) {
    reasons.push(
      `matcher strictness weakened (avg score: ${metrics.before.avgStrictness.toFixed(1)} → ${metrics.after.avgStrictness.toFixed(1)})`
    );
    risk = "high";
  }

  // Assertions moved behind conditionals
  if (metrics.conditionalWrappingAdded > 0) {
    reasons.push(
      `${metrics.conditionalWrappingAdded} assertion(s) moved inside conditional branches`
    );
    if (risk !== "high") risk = "high";
  }

  // Assertions added (medium — new coverage, but worth noting)
  if (metrics.countDelta > 0 && risk === "low") {
    reasons.push(`${metrics.countDelta} assertion(s) added`);
    risk = "medium";
  }

  // Assertions modified (different matchers, same count)
  if (
    metrics.countDelta === 0 &&
    metrics.before.count > 0 &&
    metrics.strictnessDelta !== 0
  ) {
    if (metrics.strictnessDelta < 0) {
      reasons.push("assertion matchers weakened");
      risk = "high";
    } else {
      reasons.push("assertion matchers strengthened");
      if (risk === "low") risk = "medium";
    }
  }

  if (reasons.length === 0) {
    reasons.push("No meaningful assertion changes");
  }

  return { risk, reason: reasons.join("; ") };
}

// ---------------------------------------------------------------------------
// High-risk diff keywords for classifyRisk
// ---------------------------------------------------------------------------

const MEDIUM_KEYWORDS = ["assert", "expect", "skip", "xfail", "xit", "xdescribe", "pending"];
const HIGH_KEYWORDS = ["remove", "delete", "disable", "todo", "fixme", "broken", "ignore", "nodiscard"];

// ---------------------------------------------------------------------------
// SkillExecutor
// ---------------------------------------------------------------------------

export class SkillExecutor {
  constructor(private readonly policy: PolicyEngine) {}

  execute(skill: string, inputs: Record<string, unknown>, runId: string): SkillResult {
    log.debug("Executing skill", { skill, runId });

    try {
      switch (skill) {
        case "detect_assertion_change":
          return this.detectAssertionChange(inputs);
        case "summarize_failure":
          return this.summarizeFailure(inputs);
        case "enforce_policy":
          return this.enforcePolicy(inputs);
        case "classify_risk":
          return this.classifyRisk(inputs);
        default:
          log.warn("Unknown skill requested", { skill, runId });
          return { ok: false, error: `Unknown skill: ${skill}` };
      }
    } catch (err) {
      log.error("Skill execution threw unexpectedly", { skill, runId, error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  // -------------------------------------------------------------------------

  detectAssertionChange(inputs: Record<string, unknown>): AssertionChangeResult {
    const diff = typeof inputs.diff === "string" ? inputs.diff : "";
    const metrics = AssertionExtractor.fromDiff(diff);
    const { risk, reason } = scoreAssertionDiff(metrics);

    return {
      ok: true,
      risk,
      reason,
      beforeCount: metrics.before.count,
      afterCount: metrics.after.count,
      parseError: metrics.parseError,
      metrics,
    };
  }

  private summarizeFailure(inputs: Record<string, unknown>): FailureSummaryResult {
    const raw = typeof inputs.failureLog === "string" ? inputs.failureLog : "";
    const truncated = raw.slice(0, CONFIG.maxLogBytes);
    const causes = extractCauses(truncated);

    return {
      ok: true,
      summary: truncated.slice(0, 500),
      likelyCauses: causes,
      truncated: raw.length > CONFIG.maxLogBytes,
    };
  }

  private enforcePolicy(inputs: Record<string, unknown>): PolicyResult {
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(inputs)) {
      safe[k] = String(v ?? "");
    }
    const evalResult: PolicyEvalResult = this.policy.evaluate(safe);
    return {
      ok: true,
      decision: evalResult.decision,
      reason: evalResult.reason,
      matchedRules: evalResult.matchedRules,
    };
  }

  private classifyRisk(inputs: Record<string, unknown>): ClassifyRiskResult {
    const ctx = (typeof inputs.context === "string" ? inputs.context : "").toLowerCase();

    let risk: "low" | "medium" | "high" = "low";
    let explanation = "No risk indicators found";

    if (MEDIUM_KEYWORDS.some((k) => ctx.includes(k))) {
      risk = "medium";
      explanation = "Medium-risk keywords found in context";
    }
    if (HIGH_KEYWORDS.some((k) => ctx.includes(k))) {
      risk = "high";
      explanation = "High-risk destructive keywords detected";
    }

    return { ok: true, risk, explanation };
  }
}

export { Decision };

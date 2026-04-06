/**
 * agent.ts — Deterministic governance pipeline with LLM-assisted analysis.
 *
 * Execution order (fixed, non-negotiable):
 *
 *   1. INVARIANT CHECK  — hard rules, pre-LLM, non-overridable
 *      If any hard invariant fires → BLOCK immediately, no LLM consulted.
 *
 *   2. MANDATORY SKILLS — always run, LLM cannot skip them
 *      a. detect_assertion_change  (deterministic AST analysis)
 *      b. summarize_failure        (if failures present)
 *      c. enforce_policy           (deterministic DSL rule engine)
 *      If enforce_policy returns BLOCK → exit immediately.
 *
 *   3. LLM ADVISORY LOOP (optional, skipped in no-LLM mode)
 *      The LLM sees mandatory skill results and may call additional skills
 *      or produce a more detailed report. It cannot override a BLOCK from
 *      steps 1 or 2 — it can only escalate from PASS → WARN or WARN → BLOCK.
 *
 *   4. FINAL DECISION   — worst signal across all layers
 *
 * No-LLM mode (TGA_NO_LLM=true):
 *   Steps 1 + 2 only. Fully deterministic. Safe fallback during LLM outages.
 *
 * Public surface:
 *   evaluateRun({ context, skills, config }) → AgentResult   (framework-agnostic)
 *   runAgent(opts)                           → AgentResult   (convenience wrapper)
 */

import crypto from "crypto";
import fs from "fs";
import { Audit } from "./audit";
import { CONFIG } from "./config";
import { SkillExecutor } from "./executor";
import { checkInvariants } from "./invariants";
import { callLLMWithRetry, sanitiseInput } from "./llm";
import { log } from "./logger";
import { PolicyEngine } from "./policy";
import { flattenRules, loadSkills } from "./skills";
import {
  AgentConfig,
  AgentContext,
  AgentResult,
  AgentStep,
  AssertionChangeResult,
  Decision,
  InvariantViolation,
  Skill,
  SkillResult,
  toDecision,
} from "./types";

// ---------------------------------------------------------------------------
// Decision severity helpers
// ---------------------------------------------------------------------------

const SEVERITY: Record<Decision, number> = {
  [Decision.PASS]: 0,
  [Decision.WARN]: 1,
  [Decision.BLOCK]: 2,
};

function worstDecision(a: Decision, b: Decision): Decision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Mandatory pipeline — always runs, LLM cannot skip or reorder
// ---------------------------------------------------------------------------

interface MandatoryResults {
  assertionResult: AssertionChangeResult;
  failureSummary: string;
  policyDecision: Decision;
  policyReason: string;
  steps: AgentStep[];
}

function runMandatoryPipeline(
  context: AgentContext,
  executor: SkillExecutor
): MandatoryResults {
  const steps: AgentStep[] = [];

  // Step M1: detect_assertion_change — always
  const assertionResult = executor.detectAssertionChange({ diff: context.diff }) as AssertionChangeResult;
  steps.push({
    step: 0,
    thought: "[mandatory] detect_assertion_change",
    skill: "detect_assertion_change",
    input: { diff: "[diff content]" },
    result: assertionResult,
  });

  log.info("Mandatory: assertion analysis complete", {
    risk: assertionResult.risk,
    beforeCount: assertionResult.beforeCount,
    afterCount: assertionResult.afterCount,
    parseError: assertionResult.parseError,
  });

  // Step M2: summarize_failure — only if failures present
  let failureSummary = "";
  if (context.failures.length > 0) {
    const failureLog = context.failures.join("\n---\n");
    const failureResult = executor.execute("summarize_failure", { failureLog }, "mandatory");
    failureSummary = typeof failureResult.summary === "string" ? failureResult.summary : "";
    steps.push({
      step: 0,
      thought: "[mandatory] summarize_failure",
      skill: "summarize_failure",
      input: { failureLog: "[failure log content]" },
      result: failureResult,
    });
  }

  // Step M3: enforce_policy — always, with mandatory skill outputs as inputs
  const policyInputs: Record<string, string> = {
    assertion_risk: assertionResult.risk,
    assertion_reason: assertionResult.reason,
    failure_summary: failureSummary,
    parse_error: String(assertionResult.parseError),
    conditional_wrapping_added: String(assertionResult.metrics.conditionalWrappingAdded > 0),
    strictness_delta: String(assertionResult.metrics.strictnessDelta < 0 ? "negative" : "non_negative"),
  };

  const policyResult = executor.execute("enforce_policy", policyInputs, "mandatory");
  const policyDecision = toDecision((policyResult as { decision?: unknown }).decision);
  const policyReason = typeof policyResult.reason === "string"
    ? policyResult.reason
    : "Policy evaluation complete";

  steps.push({
    step: 0,
    thought: "[mandatory] enforce_policy",
    skill: "enforce_policy",
    input: policyInputs,
    result: policyResult,
  });

  log.info("Mandatory: policy evaluation complete", { decision: policyDecision, reason: policyReason });

  return { assertionResult, failureSummary, policyDecision, policyReason, steps };
}

// ---------------------------------------------------------------------------
// LLM advisory prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(skills: Skill[], mandatoryResults: MandatoryResults): string {
  return `You are a deterministic governance pipeline with LLM-assisted analysis.

The following mandatory checks have ALREADY RUN and CANNOT be overridden:

ASSERTION ANALYSIS:
  risk=${mandatoryResults.assertionResult.risk}
  reason=${mandatoryResults.assertionResult.reason}
  before=${mandatoryResults.assertionResult.beforeCount} assertions
  after=${mandatoryResults.assertionResult.afterCount} assertions
  strictnessDelta=${mandatoryResults.assertionResult.metrics.strictnessDelta.toFixed(2)}
  conditionalWrappingAdded=${mandatoryResults.assertionResult.metrics.conditionalWrappingAdded}

POLICY DECISION (mandatory, cannot be lowered):
  decision=${mandatoryResults.policyDecision}
  reason=${mandatoryResults.policyReason}

Your role: provide additional context, call supplementary skills, and produce
a final human-readable report. You MAY escalate the decision (pass→warn, warn→block)
but CANNOT lower it (block cannot become warn or pass).

AVAILABLE SUPPLEMENTARY SKILLS:
${JSON.stringify(skills.filter(s => !["enforce_policy"].includes(s.name)), null, 2)}

Respond ONLY with a JSON object:
{
  "thought": "<1-3 sentences>",
  "skill": "<skill_name or 'finish'>",
  "input": { ... }
}

To finish: skill="finish", input={"decision":"<pass|warn|block>","report":"<human report>"}`;
}

function buildUserMessage(
  context: AgentContext,
  history: AgentStep[],
  config: AgentConfig
): string {
  return JSON.stringify({
    context: {
      diff: sanitiseInput(context.diff, config.maxDiffBytes),
      failures: context.failures
        .slice(0, config.maxFailures)
        .map((f) => sanitiseInput(f, config.maxLogBytes)),
    },
    history,
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Core evaluateRun — framework-agnostic
// ---------------------------------------------------------------------------

export interface EvaluateRunOptions {
  context: AgentContext;
  skills: Skill[];
  config?: AgentConfig;
  runId?: string;
}

/**
 * Framework-agnostic governance evaluation.
 *
 * This is the core function. The Playwright reporter, CLI, and any other
 * adapter should call this — not reach into agent internals.
 *
 * Always resolves. Never throws.
 */
export async function evaluateRun(opts: EvaluateRunOptions): Promise<AgentResult> {
  const config = opts.config ?? CONFIG;
  const runId = opts.runId ?? crypto.randomUUID();
  const { context, skills } = opts;

  log.info("Governance evaluation started", {
    runId,
    noLLMMode: config.noLLMMode,
    failures: context.failures.length,
    hasDiff: context.diff.length > 0,
  });

  const invariantViolations: InvariantViolation[] = [];
  let terminatedEarly = false;
  let finalDecision: Decision = Decision.PASS;
  let finalReport = "Governance evaluation complete";
  let errorMsg: string | null = null;
  let allSteps: AgentStep[] = [];

  try {
    // -----------------------------------------------------------------------
    // LAYER 1: Invariant checks — non-overridable, pre-LLM
    // -----------------------------------------------------------------------
    const invariantResult = checkInvariants(context);
    invariantViolations.push(...invariantResult.violations);

    if (invariantResult.blocked) {
      const blocking = invariantResult.violations.filter(
        (v) =>
          v.id === "assertion_count_decreased" // only hard-block ids
      );
      finalDecision = Decision.BLOCK;
      finalReport = `Hard invariant violated: ${blocking.map((v) => v.reason).join("; ")}`;
      terminatedEarly = true;

      log.info("Governance blocked by invariant", { runId, violations: blocking.length });

      return buildResult({
        runId, finalDecision, finalReport, allSteps,
        terminatedEarly, invariantViolations, config,
        context, errorMsg,
      });
    }

    // Soft invariant violations escalate to at least WARN
    if (invariantViolations.length > 0) {
      finalDecision = worstDecision(finalDecision, Decision.WARN);
    }

    // -----------------------------------------------------------------------
    // LAYER 2: Mandatory skills — deterministic, always run
    // -----------------------------------------------------------------------
    const rules = flattenRules(skills);
    const policy = new PolicyEngine(rules);
    const executor = new SkillExecutor(policy);

    const mandatory = runMandatoryPipeline(context, executor);
    allSteps.push(...mandatory.steps);

    finalDecision = worstDecision(finalDecision, mandatory.policyDecision);
    finalReport = mandatory.policyReason;

    // Hard block from mandatory pipeline — skip LLM
    if (mandatory.policyDecision === Decision.BLOCK) {
      log.info("Mandatory pipeline blocked — skipping LLM", { runId });
      terminatedEarly = true;

      return buildResult({
        runId, finalDecision, finalReport, allSteps,
        terminatedEarly, invariantViolations, config,
        context, errorMsg,
      });
    }

    // -----------------------------------------------------------------------
    // LAYER 3: LLM advisory loop (skipped in no-LLM mode)
    // -----------------------------------------------------------------------
    if (config.noLLMMode) {
      log.info("No-LLM mode active — skipping LLM loop", { runId });
      finalReport = `[No-LLM mode] ${finalReport}`;
    } else {
      const systemPrompt = buildSystemPrompt(skills, mandatory);
      let stepCount = allSteps.length;

      for (let step = 1; step <= config.maxSteps; step++) {
        log.info("LLM advisory step", { runId, step });

        const userMessage = buildUserMessage(context, allSteps, config);
        const fullPrompt = systemPrompt + "\n\n" + userMessage;
        const action = await callLLMWithRetry(fullPrompt, config, runId);

        if (action === null) {
          // LLM permanently failed — keep mandatory decision, warn about LLM
          finalDecision = worstDecision(finalDecision, Decision.WARN);
          finalReport += " [LLM advisory unavailable — mandatory analysis only]";
          terminatedEarly = true;
          break;
        }

        const { thought, skill, input } = action;

        if (skill === "finish") {
          const llmDecision = toDecision(input.decision);
          const llmReport = typeof input.report === "string" ? input.report : "";

          // LLM can only escalate — never lower the mandatory decision
          finalDecision = worstDecision(finalDecision, llmDecision);
          if (llmReport) finalReport = llmReport;

          if (SEVERITY[llmDecision] < SEVERITY[mandatory.policyDecision]) {
            log.warn("LLM attempted to lower mandatory decision — ignored", {
              runId,
              llmDecision,
              mandatoryDecision: mandatory.policyDecision,
            });
          }
          break;
        }

        // Execute supplementary skill
        stepCount++;
        const result: SkillResult = executor.execute(skill, input, runId);
        allSteps.push({ step: stepCount, thought, skill, input, result });
      }
    }

  } catch (err) {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    errorMsg = stack;
    finalDecision = Decision.BLOCK;
    finalReport = `Unexpected governance error — blocking for safety: ${String(err)}`;
    log.critical("Unhandled governance exception", { runId, error: stack });
  }

  return buildResult({
    runId, finalDecision, finalReport, allSteps,
    terminatedEarly, invariantViolations, config,
    context, errorMsg,
  });
}

// ---------------------------------------------------------------------------
// Result builder + side effects (audit, report file)
// ---------------------------------------------------------------------------

interface BuildResultOpts {
  runId: string;
  finalDecision: Decision;
  finalReport: string;
  allSteps: AgentStep[];
  terminatedEarly: boolean;
  invariantViolations: InvariantViolation[];
  config: AgentConfig;
  context: AgentContext;
  errorMsg: string | null;
}

function buildResult(opts: BuildResultOpts): AgentResult {
  const {
    runId, finalDecision, finalReport, allSteps,
    terminatedEarly, invariantViolations, config, context, errorMsg,
  } = opts;

  log.info("Governance evaluation complete", {
    runId,
    decision: finalDecision,
    steps: allSteps.length,
    invariants: invariantViolations.length,
  });

  // Audit record
  if (config.auditLogPath) {
    const record = Audit.create({
      runId,
      goal: "Test governance evaluation",
      steps: allSteps,
      decision: finalDecision,
      report: finalReport,
      diff: context.diff,
      failures: context.failures,
      terminatedEarly,
      noLLMMode: config.noLLMMode,
      invariantViolations,
      error: errorMsg,
    });
    Audit.write(record, config.auditLogPath);
  }

  const result: AgentResult = {
    decision: finalDecision,
    report: finalReport,
    runId,
    steps: allSteps.length,
    terminatedEarly,
    noLLMMode: config.noLLMMode,
    invariantViolations,
  };

  // Machine-readable report
  if (config.reportPath) {
    try {
      fs.writeFileSync(config.reportPath, JSON.stringify(result, null, 2), "utf-8");
    } catch (err) {
      log.warn("Failed to write machine report", { path: config.reportPath, error: String(err) });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// runAgent — convenience wrapper (backward compatible)
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  skills: Skill[];
  goal?: string;
  context: AgentContext;
  config?: AgentConfig;
  runId?: string;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const evalOpts: EvaluateRunOptions = {
    context: opts.context,
    skills: opts.skills,
  };
  if (opts.config !== undefined) evalOpts.config = opts.config;
  if (opts.runId !== undefined) evalOpts.runId = opts.runId;
  return evaluateRun(evalOpts);
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------
export { loadSkills, flattenRules } from "./skills";
export { Decision, toDecision } from "./types";
export type {
  AgentConfig,
  AgentContext,
  AgentResult,
  Skill,
  SkillRule,
} from "./types";

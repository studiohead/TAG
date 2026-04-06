/**
 * reporter.ts — Playwright adapter for the governance pipeline.
 *
 * The reporter is a thin adapter. All governance logic lives in evaluateRun().
 * This file only handles Playwright lifecycle hooks and terminal output.
 *
 * Wire up in playwright.config.ts:
 *   reporter: [["list"], ["./src/reporter.ts"]]
 */

import { execSync } from "child_process";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { evaluateRun } from "./agent";
import { loadSkills } from "./skills";
import { CONFIG } from "./config";
import { Decision, AgentResult } from "./types";
import { log } from "./logger";

function getGitDiff(): string {
  for (const cmd of ["git diff HEAD~1", "git diff HEAD", "git diff"]) {
    try {
      const result = execSync(cmd, { encoding: "utf-8", timeout: 15_000 });
      if (result.trim()) return result;
    } catch { /* try next */ }
  }
  log.warn("git diff unavailable — diff will be empty");
  return "";
}

function formatReport(result: AgentResult): string {
  const icon = { pass: "✅", warn: "⚠️", block: "🚫" }[result.decision] ?? "❓";
  const mode = result.noLLMMode ? " [No-LLM mode]" : "";
  const lines = [
    "",
    "╔══════════════════════════════════════════════════════╗",
    "║   TEST GOVERNANCE PIPELINE — REPORT                  ║",
    "╚══════════════════════════════════════════════════════╝",
    `  Decision : ${icon}  ${result.decision.toUpperCase()}${mode}`,
    `  Run ID   : ${result.runId}`,
    `  Steps    : ${result.steps}`,
    ...(result.terminatedEarly ? ["  ⚠️  Pipeline terminated early"] : []),
    ...(result.invariantViolations.length > 0
      ? [`  ⚠️  Invariant violations: ${result.invariantViolations.length}`]
      : []),
    "",
    "  Report:",
    ...result.report.match(/.{1,58}/g)?.map((l) => `    ${l}`) ?? [`    ${result.report}`],
    "═".repeat(56),
  ];
  return lines.join("\n");
}

class GovernanceReporter implements Reporter {
  private failures: string[] = [];

  onBegin(_config: FullConfig, _suite: Suite): void {
    log.info("GovernanceReporter: test run started");
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    if (result.status === "failed" || result.status === "timedOut") {
      const repr = result.errors.map((e) => e.message ?? String(e)).join("\n---\n");
      this.failures.push(repr.slice(0, CONFIG.maxLogBytes));
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    log.info("GovernanceReporter: running governance pipeline", {
      failures: this.failures.length,
      noLLMMode: CONFIG.noLLMMode,
    });

    const skills = loadSkills();
    if (skills.length === 0) {
      process.stderr.write("\n⚠️  TGA: No skills loaded — governance skipped.\n");
      return;
    }

    let agentResult: AgentResult;
    try {
      agentResult = await evaluateRun({
        skills,
        context: { failures: this.failures, diff: getGitDiff() },
      });
    } catch (err) {
      process.stderr.write(`\n🚫 TGA: Internal error — blocking for safety: ${err}\n`);
      process.exitCode = 1;
      return;
    }

    process.stderr.write(formatReport(agentResult) + "\n");

    if (agentResult.decision === Decision.BLOCK) {
      process.exitCode = 1;
    } else if (agentResult.decision === Decision.WARN) {
      process.stderr.write("\n⚠️  TGA WARNING: Review recommended (build not blocked).\n");
    }
  }
}

export default GovernanceReporter;

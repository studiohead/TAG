/**
 * audit.ts — Append-only, structured audit trail.
 */

import crypto from "crypto";
import fs from "fs";
import { AuditRecord, AgentStep, Decision, InvariantViolation } from "./types";
import { log } from "./logger";

export class Audit {
  static fingerprint(diff: string, failures: string[]): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ diff, failures }))
      .digest("hex")
      .slice(0, 16);
  }

  static create(opts: {
    runId: string;
    goal: string;
    steps: AgentStep[];
    decision: Decision;
    report: string;
    diff: string;
    failures: string[];
    terminatedEarly: boolean;
    noLLMMode: boolean;
    invariantViolations: InvariantViolation[];
    error?: string | null;
  }): AuditRecord {
    return {
      runId: opts.runId,
      ts: new Date().toISOString(),
      goal: opts.goal,
      steps: opts.steps,
      decision: opts.decision,
      report: opts.report,
      contextHash: Audit.fingerprint(opts.diff, opts.failures),
      terminatedEarly: opts.terminatedEarly,
      noLLMMode: opts.noLLMMode,
      invariantViolations: opts.invariantViolations,
      error: opts.error ?? null,
    };
  }

  static write(record: AuditRecord, auditPath: string): void {
    const line = JSON.stringify(record, null, 0) + "\n";
    try {
      fs.appendFileSync(auditPath, line, { encoding: "utf-8" });
    } catch (err) {
      log.warn("Audit write failed", { auditPath, error: String(err) });
    }
  }
}

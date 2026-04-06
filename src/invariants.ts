/**
 * invariants.ts — Non-overridable hard-block rules.
 *
 * These run BEFORE the LLM loop, BEFORE the DSL policy engine,
 * BEFORE everything. They cannot be disabled by config, YAML rules,
 * or LLM output. If any invariant fires, the run is blocked immediately.
 *
 * Think of this as the root of trust for the governance system.
 *
 * Current invariants:
 *   1. assertion_count_decreased   — assertion count dropped in diff
 *   2. tests_and_code_both_modified — test files AND source files changed together
 *   3. no_tests_for_changed_code   — source files changed but zero test files changed
 *
 * Adding a new invariant:
 *   1. Add its id to InvariantId in types.ts
 *   2. Add a check function below
 *   3. Call it inside checkInvariants()
 */

import { AgentContext, InvariantResult, InvariantViolation } from "./types";
import { AssertionExtractor } from "./assertion";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// File classification helpers
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERN = /\.(spec|test)\.[jt]sx?$|__tests__\//i;
const SOURCE_FILE_PATTERN = /\.[jt]sx?$/;

interface ChangedFiles {
  testFiles: string[];
  sourceFiles: string[];
}

/**
 * Extract changed file paths from a unified diff header.
 * Lines like:  diff --git a/src/foo.ts b/src/foo.ts
 *              --- a/src/foo.ts
 */
function extractChangedFiles(diff: string): ChangedFiles {
  const testFiles: string[] = [];
  const sourceFiles: string[] = [];
  const seen = new Set<string>();

  for (const line of diff.split("\n")) {
    // Match both "diff --git a/..." and "+++ b/..." lines
    let filePath: string | null = null;

    const gitMatch = line.match(/^diff --git a\/(.+) b\/.+$/);
    if (gitMatch) filePath = gitMatch[1] ?? null;

    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch) filePath = plusMatch[1] ?? null;

    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);

    if (TEST_FILE_PATTERN.test(filePath)) {
      testFiles.push(filePath);
    } else if (SOURCE_FILE_PATTERN.test(filePath)) {
      sourceFiles.push(filePath);
    }
  }

  return { testFiles, sourceFiles };
}

// ---------------------------------------------------------------------------
// Individual invariant checks
// ---------------------------------------------------------------------------

/**
 * INV-1: Assertion count must not decrease.
 *
 * Any net removal of assertions — regardless of what the LLM or policy
 * engine says — is a hard block. The LLM cannot argue its way around this.
 */
function checkAssertionCountDecreased(diff: string): InvariantViolation | null {
  if (!diff.trim()) return null;

  const assertionDiff = AssertionExtractor.fromDiff(diff);

  // Parse errors are already flagged as high-risk elsewhere; skip here
  // to avoid double-blocking on the same diff.
  if (assertionDiff.parseError) return null;

  if (assertionDiff.countDelta < 0) {
    return {
      id: "assertion_count_decreased",
      reason: `Assertion count dropped by ${Math.abs(assertionDiff.countDelta)} — hard block`,
      evidence: `before=${assertionDiff.before.count} after=${assertionDiff.after.count}`,
    };
  }

  return null;
}

/**
 * INV-2: Test files and source files modified together.
 *
 * This pattern is a strong signal of test-editing to mask a code change.
 * Enterprise policy: any PR touching both test and source simultaneously
 * requires governance review (warn, not block — too blunt to block).
 *
 * Configured as WARN here because blocking all such PRs would be too
 * aggressive (many legitimate refactors touch both). Override in your
 * own subclass if your policy is stricter.
 */
function checkTestsAndCodeBothModified(
  diff: string,
  files: ChangedFiles
): InvariantViolation | null {
  if (files.testFiles.length > 0 && files.sourceFiles.length > 0) {
    return {
      id: "tests_and_code_both_modified",
      reason: "Test files and source files modified in the same change — review required",
      evidence: `tests=[${files.testFiles.join(", ")}] sources=[${files.sourceFiles.join(", ")}]`,
    };
  }
  return null;
}

/**
 * INV-3: Source files changed with no corresponding test changes.
 *
 * If source files changed but no test files were touched, the change
 * is not covered. This is a warn-level invariant by default.
 */
function checkNoTestsForChangedCode(
  diff: string,
  files: ChangedFiles
): InvariantViolation | null {
  if (files.sourceFiles.length > 0 && files.testFiles.length === 0) {
    return {
      id: "no_tests_for_changed_code",
      reason: "Source files modified with no test file changes — coverage gap",
      evidence: `sources=[${files.sourceFiles.join(", ")}]`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

/**
 * Which invariant ids are hard blocks (vs soft warnings).
 * Soft invariants still appear in the audit trail and report.
 */
const HARD_BLOCK_INVARIANTS = new Set<string>([
  "assertion_count_decreased",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all invariant checks against the agent context.
 *
 * This must be called before ANY LLM interaction or DSL policy evaluation.
 * If `blocked` is true, runAgent must exit immediately with decision=BLOCK.
 */
export function checkInvariants(context: AgentContext): InvariantResult {
  const { diff } = context;
  const files = extractChangedFiles(diff);
  const violations: InvariantViolation[] = [];

  const checks = [
    checkAssertionCountDecreased(diff),
    checkTestsAndCodeBothModified(diff, files),
    checkNoTestsForChangedCode(diff, files),
  ];

  for (const v of checks) {
    if (v !== null) {
      violations.push(v);
      const severity = HARD_BLOCK_INVARIANTS.has(v.id) ? "critical" : "warn";
      log[severity](`Invariant violated: ${v.id}`, {
        id: v.id,
        reason: v.reason,
        evidence: v.evidence,
      });
    }
  }

  const blocked = violations.some((v) => HARD_BLOCK_INVARIANTS.has(v.id));

  return { violations, blocked };
}

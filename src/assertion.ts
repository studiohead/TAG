/**
 * assertion.ts — Deterministic assertion analysis via AST.
 *
 * Extracts rich assertion metrics from JS/TS source diffs:
 *   - assertion count (before/after)
 *   - matcher strictness scoring (toBe > toStrictEqual > toEqual > toContain…)
 *   - conditional wrapping detection (if (true) expect(...))
 *   - parse error signalling
 *
 * No LLM involved. All results are fully deterministic.
 */

import * as acorn from "acorn";
import * as walk from "acorn-walk";
import {
  AssertionDiff,
  AssertionMetrics,
  MATCHER_STRICTNESS,
} from "./types";

// ---------------------------------------------------------------------------
// Matcher strictness scoring
// ---------------------------------------------------------------------------

function matcherStrictnessScore(name: string): number {
  const idx = MATCHER_STRICTNESS.indexOf(name);
  return idx; // -1 = unknown (not in table)
}

function avgScore(scores: number[]): number {
  const known = scores.filter((s) => s >= 0);
  if (known.length === 0) return -1;
  return known.reduce((a, b) => a + b, 0) / known.length;
}

// ---------------------------------------------------------------------------
// AST node type helpers
// ---------------------------------------------------------------------------

type AcornNode = acorn.Node;

interface CallExprNode extends AcornNode {
  type: "CallExpression";
  callee: AcornNode;
  arguments: AcornNode[];
}

interface MemberExprNode extends AcornNode {
  type: "MemberExpression";
  object: AcornNode;
  property: AcornNode & { name?: string };
}

interface IdentNode extends AcornNode {
  type: "Identifier";
  name: string;
}

interface IfStmtNode extends AcornNode {
  type: "IfStatement";
  consequent: AcornNode;
  alternate: AcornNode | null;
}

interface ConditionalExprNode extends AcornNode {
  type: "ConditionalExpression";
}

function isCallExpr(n: AcornNode): n is CallExprNode {
  return n.type === "CallExpression";
}
function isMemberExpr(n: AcornNode): n is MemberExprNode {
  return n.type === "MemberExpression";
}
function isIdent(n: AcornNode): n is IdentNode {
  return n.type === "Identifier";
}

// ---------------------------------------------------------------------------
// Assertion detection
// ---------------------------------------------------------------------------

/**
 * Extract the terminal matcher name from a chained call like
 *   expect(x).not.toBe(y)  →  "toBe"
 *   expect(x).toEqual(y)   →  "toEqual"
 *   assert(x)              →  "assert"
 */
function extractMatcherName(node: CallExprNode): string | null {
  const callee = node.callee;

  // Direct call: assert(...), assertEqual(...)
  if (isIdent(callee)) {
    if (callee.name.startsWith("assert") || callee.name === "expect") {
      return callee.name;
    }
  }

  // Member call: something.toBe(...), something.assertEqual(...)
  if (isMemberExpr(callee)) {
    const prop = callee.property.name;
    if (!prop) return null;

    // Jest/vitest/playwright chain: expect(x).<chain>.matcher(y)
    // Walk up the object chain to find if it's rooted in expect(...)
    if (isRootedInExpect(callee.object)) {
      return prop; // e.g. "toBe", "toEqual", "toContain", "not" (filtered below)
    }

    // Direct method assertion: this.assertEqual(...), assert.strictEqual(...)
    if (prop.startsWith("assert") || prop.startsWith("expect")) {
      return prop;
    }
  }

  return null;
}

/** Walk up a member chain to see if its root call is expect(...) */
function isRootedInExpect(node: AcornNode): boolean {
  if (isCallExpr(node)) {
    const callee = node.callee;
    if (isIdent(callee) && callee.name === "expect") return true;
    if (isMemberExpr(callee)) return isRootedInExpect(callee.object);
  }
  if (isMemberExpr(node)) return isRootedInExpect(node.object);
  return false;
}

/**
 * Names that are not terminal assertions — either chain modifiers or the
 * bare `expect` call itself (which is only the start of a chain, not an assertion).
 */
const NON_ASSERTION_MATCHERS = new Set([
  "expect",   // bare expect() — not an assertion by itself
  "not", "resolves", "rejects", "and", "soft", "poll",
]);

function isAssertionMatcher(name: string): boolean {
  return !NON_ASSERTION_MATCHERS.has(name);
}

// ---------------------------------------------------------------------------
// Conditional wrapping detection
// ---------------------------------------------------------------------------

/**
 * Count how many assertion calls in `ast` appear inside an IfStatement or
 * ConditionalExpression — i.e. are gated by a runtime condition.
 *
 * Example (evasion attempt):
 *   if (process.env.CI) expect(a).toBe(b);  // assertion only runs in CI
 *   true ? expect(x).toBe(1) : null;         // ternary gate
 */
function countConditionallyWrapped(ast: AcornNode): number {
  let count = 0;

  walk.ancestor(ast, {
    CallExpression(node: AcornNode, ancestors: AcornNode[]) {
      const call = node as unknown as CallExprNode;
      const name = extractMatcherName(call);
      if (name === null || !isAssertionMatcher(name)) return;

      // Check if any ancestor is an IfStatement or ConditionalExpression
      const wrapped = ancestors.some(
        (a) => a.type === "IfStatement" || a.type === "ConditionalExpression"
      );
      if (wrapped) count++;
    },
  });

  return count;
}

// ---------------------------------------------------------------------------
// Metrics extraction
// ---------------------------------------------------------------------------

export interface ParsedAssertions {
  matchers: string[];
  conditionallyWrapped: number;
  parseError: boolean;
}

function extractFromSource(code: string): ParsedAssertions {
  let ast: AcornNode;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return { matchers: [], conditionallyWrapped: 0, parseError: true };
  }

  const matchers: string[] = [];

  walk.simple(ast, {
    CallExpression(node: AcornNode) {
      const call = node as unknown as CallExprNode;
      const name = extractMatcherName(call);
      if (name !== null && isAssertionMatcher(name)) {
        matchers.push(name);
      }
    },
  });

  const conditionallyWrapped = countConditionallyWrapped(ast);

  return { matchers, conditionallyWrapped, parseError: false };
}

function toMetrics(parsed: ParsedAssertions): AssertionMetrics {
  const scores = parsed.matchers.map(matcherStrictnessScore);
  return {
    count: parsed.matchers.length,
    matchers: parsed.matchers,
    avgStrictness: avgScore(scores),
    conditionallyWrapped: parsed.conditionallyWrapped,
    parseError: parsed.parseError,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class AssertionExtractor {
  /**
   * Extract full assertion metrics from JS/TS source code.
   */
  static fromSource(code: string): AssertionMetrics {
    return toMetrics(extractFromSource(code));
  }

  /**
   * Compute the assertion diff between before/after sides of a unified diff.
   */
  static fromDiff(diff: string): AssertionDiff {
    const beforeLines: string[] = [];
    const afterLines: string[] = [];

    for (const line of diff.split("\n")) {
      if (line.startsWith("---") || line.startsWith("+++")) continue;
      if (line.startsWith("-")) beforeLines.push(line.slice(1));
      else if (line.startsWith("+")) afterLines.push(line.slice(1));
    }

    const beforeParsed = extractFromSource(beforeLines.join("\n"));
    const afterParsed = extractFromSource(afterLines.join("\n"));

    const before = toMetrics(beforeParsed);
    const after = toMetrics(afterParsed);

    const parseError = before.parseError || after.parseError;

    // Strictness delta: negative means weakened
    const strictnessDelta =
      before.avgStrictness >= 0 && after.avgStrictness >= 0
        ? after.avgStrictness - before.avgStrictness
        : 0;

    return {
      before,
      after,
      countDelta: after.count - before.count,
      strictnessDelta,
      conditionalWrappingAdded: Math.max(
        0,
        after.conditionallyWrapped - before.conditionallyWrapped
      ),
      parseError,
    };
  }
}

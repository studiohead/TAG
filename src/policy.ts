/**
 * policy.ts — Injection-safe, accumulate-then-decide policy engine.
 *
 * ARCHITECTURE CHANGE from "first match wins":
 *   All matching rules are collected. The worst decision wins:
 *     block > warn > pass
 *
 *   This eliminates:
 *     - rule shadowing (a low-priority pass can't hide a block)
 *     - accidental ordering bugs
 *     - brittle "place this rule before that one" maintenance
 *
 *   Rules can optionally declare a `priority` (higher = evaluated first,
 *   but ALL matching rules still contribute to the final decision).
 *
 * DSL syntax (injection-free recursive descent parser — no eval/new Function):
 *
 *   field == "literal"               equality
 *   field != "literal"               inequality
 *   contains(field, "substring")     substring check
 *   expr and expr                    boolean AND
 *   expr or expr                     boolean OR
 *   not expr                         boolean NOT
 *   (expr)                           grouping
 *   true | false                     literals
 */

import { Decision, SkillRule, toDecision } from "./types";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type TokKind =
  | "IDENT"
  | "STRING"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "EQ"
  | "NEQ"
  | "AND"
  | "OR"
  | "NOT"
  | "TRUE"
  | "FALSE"
  | "EOF";

interface Token {
  kind: TokKind;
  value: string;
}

function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i] ?? "";
    if (/\s/.test(ch)) { i++; continue; }

    if (input.slice(i, i + 2) === "!=") {
      tokens.push({ kind: "NEQ", value: "!=" }); i += 2; continue;
    }
    if (input.slice(i, i + 2) === "==") {
      tokens.push({ kind: "EQ", value: "==" }); i += 2; continue;
    }

    if (ch === "(") { tokens.push({ kind: "LPAREN", value: "(" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "RPAREN", value: ")" }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "COMMA", value: "," }); i++; continue; }

    if (ch === '"' || ch === "'") {
      const quote = ch; i++;
      let str = "";
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) { i++; }
        str += input[i++] ?? "";
      }
      i++;
      tokens.push({ kind: "STRING", value: str });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let ident = "";
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i] ?? "")) {
        ident += input[i++] ?? "";
      }
      const kw: Record<string, TokKind> = {
        and: "AND", or: "OR", not: "NOT", true: "TRUE", false: "FALSE",
      };
      tokens.push({ kind: kw[ident] ?? "IDENT", value: ident });
      continue;
    }

    throw new Error(`Unexpected character: "${ch}" at position ${i}`);
  }

  tokens.push({ kind: "EOF", value: "" });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — recursive descent, no short-circuit (must consume all tokens)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private inputs: Record<string, string>) {}

  private peek(): Token { return this.tokens[this.pos] ?? { kind: "EOF", value: "" }; }
  private consume(): Token { return this.tokens[this.pos++] ?? { kind: "EOF", value: "" }; }

  private expect(kind: TokKind): Token {
    const tok = this.consume();
    if (tok.kind !== kind) throw new Error(`Expected ${kind}, got ${tok.kind} "${tok.value}"`);
    return tok;
  }

  parseExpr(): boolean { return this.parseOr(); }

  /** orExpr := andExpr (OR andExpr)* — always evaluates both sides */
  private parseOr(): boolean {
    let left = this.parseAnd();
    while (this.peek().kind === "OR") {
      this.consume();
      const right = this.parseAnd(); // must always call to consume tokens
      left = left || right;
    }
    return left;
  }

  /** andExpr := notExpr (AND notExpr)* — always evaluates both sides */
  private parseAnd(): boolean {
    let left = this.parseNot();
    while (this.peek().kind === "AND") {
      this.consume();
      const right = this.parseNot(); // must always call to consume tokens
      left = left && right;
    }
    return left;
  }

  private parseNot(): boolean {
    if (this.peek().kind === "NOT") {
      this.consume();
      return !this.parseAtom();
    }
    return this.parseAtom();
  }

  private parseAtom(): boolean {
    const tok = this.peek();

    if (tok.kind === "LPAREN") {
      this.consume();
      const result = this.parseExpr();
      this.expect("RPAREN");
      return result;
    }

    if (tok.kind === "TRUE") { this.consume(); return true; }
    if (tok.kind === "FALSE") { this.consume(); return false; }

    if (tok.kind === "IDENT" && tok.value === "contains") {
      this.consume();
      this.expect("LPAREN");
      const field = this.expect("IDENT").value;
      this.expect("COMMA");
      const substring = this.expect("STRING").value;
      this.expect("RPAREN");
      return (this.inputs[field] ?? "").includes(substring);
    }

    if (tok.kind === "IDENT") {
      this.consume();
      const field = tok.value;
      const op = this.peek();
      if (op.kind === "EQ") {
        this.consume();
        const rhs = this.expect("STRING").value;
        return (this.inputs[field] ?? "") === rhs;
      }
      if (op.kind === "NEQ") {
        this.consume();
        const rhs = this.expect("STRING").value;
        return (this.inputs[field] ?? "") !== rhs;
      }
      // Bare identifier: truthy if non-empty and not "false"/"0"
      const v = this.inputs[field] ?? "";
      return v !== "" && v !== "false" && v !== "0";
    }

    throw new Error(`Unexpected token: ${tok.kind} "${tok.value}"`);
  }

  isExhausted(): boolean { return this.peek().kind === "EOF"; }
}

function evalCondition(condition: string, inputs: Record<string, string>): boolean {
  const tokens = tokenise(condition);
  const parser = new Parser(tokens, inputs);
  const result = parser.parseExpr();
  if (!parser.isExhausted()) {
    throw new Error("Unexpected tokens after expression end");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Decision severity ordering
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
// PolicyEngine — accumulate-then-decide
// ---------------------------------------------------------------------------

export interface PolicyEvalResult {
  decision: Decision;
  reason: string;
  matchedRules: Array<{ id: string; decision: Decision; reason: string }>;
}

export class PolicyEngine {
  private readonly rules: SkillRule[];

  constructor(rules: SkillRule[]) {
    // Sort by priority descending (higher priority evaluated first, but ALL fire)
    this.rules = [...rules].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );
  }

  evaluate(inputs: Record<string, string>): PolicyEvalResult {
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(inputs)) {
      safe[k] = String(v ?? "");
    }

    const matchedRules: Array<{ id: string; decision: Decision; reason: string }> = [];
    let accumulated: Decision = Decision.PASS;

    for (const rule of this.rules) {
      let matched = false;
      try {
        matched = evalCondition(rule.condition, safe);
      } catch (err) {
        log.warn("Policy rule eval failed — skipping", {
          ruleId: rule.id,
          condition: rule.condition,
          error: String(err),
        });
        continue;
      }

      if (matched) {
        const decision = toDecision(rule.decision);
        matchedRules.push({ id: rule.id, decision, reason: rule.reason });
        accumulated = worstDecision(accumulated, decision);
        log.debug("Rule matched", { ruleId: rule.id, decision, accumulated });
      }
    }

    if (matchedRules.length === 0) {
      log.warn("No policy rule matched — fail-closed");
      return {
        decision: Decision.BLOCK,
        reason: "No rule matched (fail-closed)",
        matchedRules: [],
      };
    }

    // Reason = the highest-severity matched rule's reason
    const worstRule = matchedRules.find((r) => r.decision === accumulated);
    const reason = worstRule?.reason ?? "Policy evaluation complete";

    return { decision: accumulated, reason, matchedRules };
  }
}

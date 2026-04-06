# Test Automation Governance

> A **deterministic governance layer with LLM-assisted analysis** for Playwright test suites.

After every test run, the pipeline analyses assertion changes, test failures, and git diffs across four ordered layers to decide whether to **pass**, **warn**, or **block** the CI pipeline.

---

## Execution Order (fixed — cannot be bypassed)

```
Playwright test run
    └── GovernanceReporter.onEnd() (src/reporter.ts)
            └── evaluateRun() (src/agent.ts)
                    │
                    ├── LAYER 1: Invariant checks (src/invariants.ts)
                    │     Non-overridable hard rules. Pre-LLM.
                    │     Fire before anything else. Cannot be configured away.
                    │     Hard block → exit immediately, LLM never consulted.
                    │
                    ├── LAYER 2: Mandatory skills (src/executor.ts)
                    │     Always run. LLM cannot skip or reorder these.
                    │     a. detect_assertion_change  — AST analysis (acorn)
                    │     b. summarize_failure        — if failures present
                    │     c. enforce_policy           — DSL accumulate-then-decide
                    │     Policy block → exit immediately, LLM skipped.
                    │
                    ├── LAYER 3: LLM advisory loop (src/agent.ts)
                    │     Optional. Skipped in no-LLM mode (TGA_NO_LLM=true).
                    │     LLM sees mandatory results and MAY escalate the decision.
                    │     LLM CANNOT lower a decision made in layers 1 or 2.
                    │
                    └── LAYER 4: Final decision
                          Worst signal across all layers wins (block > warn > pass).
```

---

## Design Principles

| Principle | Implementation |
|-----------|---------------|
| Fail-closed | Any error or no-rule-match → `block` |
| Mandatory pipeline | `detect_assertion_change` + `enforce_policy` always run — LLM cannot skip them |
| LLM only advises | LLM can escalate decisions, never lower them |
| No `eval()` anywhere | Policy conditions parsed by a hand-written recursive descent DSL |
| Accumulate-then-decide | All matching policy rules fire; worst signal wins — no shadowing bugs |
| Non-overridable invariants | Hard rules that predate the LLM and the DSL engine |
| No-LLM mode | `TGA_NO_LLM=true` runs layers 1+2 only — fully deterministic |
| Injection-safe | Diffs and logs sanitised before entering any LLM prompt |
| Auditable | Timestamped, SHA-256-fingerprinted JSONL audit trail |
| Typed | Strict TypeScript throughout — `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` |

---

## Non-Overridable Invariants

These run before the LLM, before the policy engine, before everything. They are not configurable.

| ID | Severity | Condition | Action |
|----|----------|-----------|--------|
| `assertion_count_decreased` | **Hard block** | Net assertion count dropped in diff | Block immediately |
| `tests_and_code_both_modified` | Soft warn | Test and source files changed together | Add to violations, continue |
| `no_tests_for_changed_code` | Soft warn | Source changed, no test files touched | Add to violations, continue |

To add a new invariant: add its id to `InvariantId` in `types.ts`, write a check function in `invariants.ts`, add it to `HARD_BLOCK_INVARIANTS` if it should be a hard block.

---

## Assertion Analysis — Rich Scoring

`detect_assertion_change` goes beyond a simple before/after count:

| Signal | Risk | Example |
|--------|------|---------|
| Assertion count drops | **High** | `expect(x).toBe(1)` removed |
| Matcher strictness weakened | **High** | `toBe` → `toContain` |
| Assertion moved into conditional | **High** | `if (x) { expect(x).toBe(1) }` |
| Assertion count increases | Medium | New `expect(...)` added |
| Count unchanged, matchers changed | High or medium | Depends on direction |

Matcher strictness order (highest to lowest): `toBe > toStrictEqual > toEqual > toMatchObject > toContainEqual > toContain`

---

## Policy Engine — Accumulate-Then-Decide

Rules in `skills/enforce_policy.yaml` no longer use first-match-wins semantics. Instead:

1. **All matching rules fire**
2. **Worst decision wins** (`block > warn > pass`)
3. Rule ordering no longer affects correctness (only readability)
4. `priority` controls evaluation order in logs — higher priority rules appear first

This eliminates rule shadowing, accidental overrides, and brittle ordering bugs.

### DSL Syntax

```
field == "literal"               equality
field != "literal"               inequality
contains(field, "substring")     substring check
expr and expr                    boolean AND (both sides always evaluated)
expr or expr                     boolean OR  (both sides always evaluated)
not expr                         boolean NOT
(expr)                           grouping
true | false                     literals
```

### Available Input Fields

| Field | Values | Source |
|-------|--------|--------|
| `assertion_risk` | `"low"` / `"medium"` / `"high"` | `detect_assertion_change` |
| `assertion_reason` | human-readable string | `detect_assertion_change` |
| `failure_summary` | empty string if no failures | `summarize_failure` |
| `parse_error` | `"true"` / `"false"` | `detect_assertion_change` |
| `conditional_wrapping_added` | `"true"` / `"false"` | `detect_assertion_change` |
| `strictness_delta` | `"negative"` / `"non_negative"` | `detect_assertion_change` |

---

## No-LLM Mode

Set `TGA_NO_LLM=true` to skip the LLM loop entirely. Only layers 1 + 2 run.

Use this for:
- LLM outages or rate limit periods
- Environments where outbound LLM calls are not permitted
- Local development where you want fast, deterministic feedback
- Debugging policy rules without LLM noise

The governance pipeline remains fully functional — the LLM was always advisory.

---

## LLM Retry Strategy

- **Exponential backoff**: `base × 2^(attempt-1)`, capped at 30 seconds
- **Full jitter**: `random(0, computed_delay)` — prevents thundering herd in CI
- **Error classification**: 401/403/context-length → fail immediately (non-retryable); 429/5xx/timeout → retry
- **Self-correction**: on JSON parse failure, retries with an explicit correction hint

---

## Quick Start

```bash
npm ci
npm run build

# Add to playwright.config.ts:
# reporter: [["list"], ["./src/reporter.ts"]]

# Run tests:
npx playwright test

# No-LLM mode (deterministic only):
TGA_NO_LLM=true npx playwright test
```

---

## Connecting an LLM

Edit `callLLMRaw()` in `src/llm.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();

export async function callLLMRaw(prompt: string): Promise<string> {
  const msg = await client.messages.create({
    model: "claude-opus-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  const block = msg.content[0];
  if (block.type !== "text") throw new Error("Unexpected content type");
  return block.text;
}
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TGA_NO_LLM` | `false` | Skip LLM entirely — deterministic mode |
| `TGA_MAX_STEPS` | `8` | Max LLM advisory iterations |
| `TGA_LLM_RETRIES` | `3` | LLM call retries on transient errors |
| `TGA_LLM_RETRY_DELAY` | `1.5` | Base retry delay in seconds (exponential, with jitter) |
| `TGA_DEFAULT_DECISION` | `block` | Decision when no rule matches (fail-closed) |
| `TGA_SKILLS_DIR` | `./skills` | YAML skill definitions directory |
| `TGA_AUDIT_LOG` | _(unset)_ | Append-only JSONL audit trail path |
| `TGA_REPORT_PATH` | _(unset)_ | Machine-readable JSON report output path |
| `TGA_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `critical` |
| `TGA_MAX_DIFF_BYTES` | `524288` | Max bytes of git diff forwarded to the LLM |
| `TGA_MAX_LOG_BYTES` | `65536` | Max bytes per failure log entry |
| `TGA_MAX_FAILURES` | `50` | Max failure entries forwarded to the LLM |

---

## Running Tests

```bash
npm test                  # run once (73 tests)
npm run test:watch        # watch mode
npm run test:coverage     # with v8 coverage report
npm run typecheck         # strict TS check without emitting
```

---

## Project Structure

```
.
├── src/
│   ├── types.ts          ← Single source of truth for all types
│   ├── config.ts         ← Validated env-var config (parsed once)
│   ├── logger.ts         ← Structured JSON logger to stderr
│   ├── assertion.ts      ← AST assertion extractor + strictness scorer (acorn)
│   ├── invariants.ts     ← Non-overridable hard-block rules (root of trust)
│   ├── policy.ts         ← Injection-safe DSL parser + accumulate-then-decide engine
│   ├── skills.ts         ← YAML skill loader with boolean condition coercion
│   ├── executor.ts       ← Deterministic skill executor (no LLM)
│   ├── llm.ts            ← LLM client: retry, jitter, error classification, sanitisation
│   ├── audit.ts          ← Append-only JSONL audit trail
│   ├── agent.ts          ← evaluateRun() core + runAgent() adapter
│   └── reporter.ts       ← Playwright adapter (thin — delegates to evaluateRun)
├── skills/
│   └── enforce_policy.yaml   ← Accumulate-then-decide policy rules with priority
├── tests/
│   └── agent.test.ts         ← 73 test cases (Vitest)
├── playwright.config.ts      ← Example Playwright configuration
├── vitest.config.ts
├── tsconfig.json             ← Strict: exactOptionalPropertyTypes, noUncheckedIndexedAccess
└── package.json
```

---

## Audit Trail

When `TGA_AUDIT_LOG` is set, every run appends one JSON line:

```json
{
  "runId": "3f7a...",
  "ts": "2026-01-15T09:23:11.000Z",
  "goal": "Test governance evaluation",
  "steps": [...],
  "decision": "block",
  "report": "Assertion count dropped by 1 — hard block",
  "contextHash": "a3f9b1c2",
  "terminatedEarly": true,
  "noLLMMode": false,
  "invariantViolations": [
    {
      "id": "assertion_count_decreased",
      "reason": "Assertion count dropped by 1 — hard block",
      "evidence": "before=3 after=2"
    }
  ],
  "error": null
}
```

---

## Security Notes

- **No `eval()` or `new Function()`** anywhere in the policy engine
- **Both sides of `and`/`or` always evaluated** — no short-circuit token consumption bug
- **Prompt injection sanitisation** — diffs and failure logs scanned and redacted before LLM
- **Fail-closed** — no default path produces `pass`; all error paths produce `block`
- **LLM is advisory only** — cannot lower a decision made by invariants or mandatory pipeline
- **YAML boolean coercion** — `condition: true` in YAML correctly parsed as string `"true"`

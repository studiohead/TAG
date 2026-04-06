/**
 * config.ts — Centralised, validated configuration.
 *
 * All tunables are driven by environment variables.
 * Reading process.env happens exactly once, here.
 */

import path from "path";
import { AgentConfig, Decision, toDecision } from "./types";

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for env var ${key}: "${raw}" — must be a positive integer`);
  }
  return parsed;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid value for env var ${key}: "${raw}" — must be a non-negative number`);
  }
  return parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

const _cfg: AgentConfig = {
  maxSteps: envInt("TGA_MAX_STEPS", 8),
  defaultDecision: toDecision(process.env.TGA_DEFAULT_DECISION ?? Decision.BLOCK),
  skillsDir: process.env.TGA_SKILLS_DIR ?? path.join(process.cwd(), "skills"),
  maxDiffBytes: envInt("TGA_MAX_DIFF_BYTES", 512 * 1024),
  maxLogBytes: envInt("TGA_MAX_LOG_BYTES", 64 * 1024),
  maxFailures: envInt("TGA_MAX_FAILURES", 50),
  llmRetries: envInt("TGA_LLM_RETRIES", 3),
  llmRetryDelaySec: envFloat("TGA_LLM_RETRY_DELAY", 1.5),
  noLLMMode: envBool("TGA_NO_LLM", false),
};
if (process.env.TGA_AUDIT_LOG) _cfg.auditLogPath = process.env.TGA_AUDIT_LOG;
if (process.env.TGA_REPORT_PATH) _cfg.reportPath = process.env.TGA_REPORT_PATH;

export const CONFIG: Readonly<AgentConfig> = Object.freeze(_cfg);

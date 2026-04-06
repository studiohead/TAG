/**
 * logger.ts — Structured JSON logger.
 *
 * Every line is a single JSON object. Never multi-line.
 * Configurable level via TGA_LOG_LEVEL env var.
 */

type LogLevel = "debug" | "info" | "warn" | "error" | "critical";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

function resolveLevel(): LogLevel {
  const raw = (process.env.TGA_LOG_LEVEL ?? "info").toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return "info";
}

const MIN_LEVEL = resolveLevel();

function emit(
  level: LogLevel,
  msg: string,
  meta: Record<string, unknown> = {}
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    logger: "tga",
    ...meta,
  };
  // All levels go to stderr so they don't pollute stdout pipelines
  process.stderr.write(JSON.stringify(payload) + "\n");
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  critical: (msg: string, meta?: Record<string, unknown>) => emit("critical", msg, meta),
};

/* eslint-disable no-console -- This module is the single sanctioned log sink. */
import { getRuntimeConfig } from "@/config/env";
import type { JsonObject } from "@/lib/json";
import { redact } from "@/lib/redact";

/**
 * Operational logging.
 *
 * This is for operators: what the process did, how long it took, what broke.
 * It is explicitly NOT the audit trail (`@/domain/audit-event`). Logs may be
 * sampled, rotated, dropped or reordered; audit events may not. A user-facing
 * "why did this happen" answer must never be reconstructed from these lines.
 *
 * Every entry is a single structured JSON object so it can be queried by
 * correlation id or transaction id. All metadata passes through redaction, so
 * secrets and model reasoning cannot be logged even by accident.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Coarse subsystem tag, so payment noise can be separated from agent noise. */
export const LOG_CATEGORIES = [
  "system",
  "http",
  "config",
  "agent",
  "catalog",
  "policy",
  "approval",
  "transaction",
  "payment",
  "webhook",
  "audit",
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

export interface LogContext {
  readonly category: LogCategory;
  /** Ties together every line produced while handling one request or event. */
  readonly correlationId?: string;
  readonly transactionId?: string;
}

export interface LogEntry extends LogContext {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly metadata: JsonObject;
}

export interface Logger {
  debug(message: string, metadata?: JsonObject): void;
  info(message: string, metadata?: JsonObject): void;
  warn(message: string, metadata?: JsonObject): void;
  error(message: string, metadata?: JsonObject): void;
  /** Narrows context, e.g. binding a transaction id for the rest of a flow. */
  child(context: Partial<LogContext>): Logger;
}

/** Swappable sink. Tests capture entries; production writes JSON to the console. */
export type LogSink = (entry: LogEntry) => void;

const consoleSink: LogSink = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
};

export function buildLogEntry(
  level: LogLevel,
  context: LogContext,
  message: string,
  metadata: JsonObject,
  now: Date = new Date(),
): LogEntry {
  return {
    timestamp: now.toISOString(),
    level,
    message,
    ...context,
    metadata: redact(metadata),
  };
}

export interface LoggerOptions {
  readonly sink?: LogSink;
  readonly minimumLevel?: LogLevel;
}

export function createLogger(context: LogContext, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? consoleSink;
  const minimumLevel = options.minimumLevel ?? getRuntimeConfig().LOG_LEVEL;

  const write = (level: LogLevel, message: string, metadata: JsonObject = {}): void => {
    if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[minimumLevel]) return;
    sink(buildLogEntry(level, context, message, metadata));
  };

  return {
    debug: (message, metadata) => write("debug", message, metadata),
    info: (message, metadata) => write("info", message, metadata),
    warn: (message, metadata) => write("warn", message, metadata),
    error: (message, metadata) => write("error", message, metadata),
    child: (extra) =>
      createLogger({ ...context, ...extra }, { ...options, minimumLevel }),
  };
}

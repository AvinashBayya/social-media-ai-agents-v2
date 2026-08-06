/**
 * Structured logging for server-side code.
 *
 * The app previously had no logger at all — 41 bare `console.*` calls, mostly
 * `console.error(err)` inside a catch. That is unworkable for a security audit
 * trail: there is no level, no timestamp, no request correlation, and no
 * guarantee a caller has not passed a password straight into the log.
 *
 * This emits one JSON object per line to stdout/stderr. No dependency, because
 * a container's log driver is already a line collector — pino would only add
 * a transport we do not use. `AuditLog` rows in the database remain the
 * authoritative record of *security* events; this is operational telemetry.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names whose values are replaced with `[redacted]` anywhere in a log
 * payload, at any nesting depth. This is a backstop, not a licence: callers
 * must still not pass secrets. Matching is case-insensitive and substring
 * based, so `newPassword` and `passwordHash` are both caught.
 */
const REDACTED_KEY_PATTERNS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "sessionid",
  "session_id",
  "passwordhash",
  "credential",
];

const REDACTED = "[redacted]";

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_]/g, "");
  return REDACTED_KEY_PATTERNS.some((pattern) => normalised.includes(pattern.replace(/[-_]/g, "")));
}

/**
 * Deep-copy a payload, replacing sensitive values and anything non-serialisable.
 * Exported for tests — the redaction guarantee is worth asserting directly.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;

  // A cycle would otherwise hang the logger, taking the request with it.
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(entry, seen);
  }
  return out;
}

export interface LogFields {
  [key: string]: unknown;
}

function minLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  if (configured && configured in LEVEL_RANK) return configured as LogLevel;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel()]) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields ? (redact(fields) as LogFields) : {}),
  };

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // Never let a log call take down the request that made it.
    line = JSON.stringify({
      ts: record.ts,
      level,
      msg: message,
      logError: "unserialisable fields",
    });
  }

  // stderr for warn/error so container log routing can split them.
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),

  /** Bind fields onto every subsequent call — used to attach a request id. */
  child(bound: LogFields) {
    return {
      debug: (message: string, fields?: LogFields) =>
        emit("debug", message, { ...bound, ...fields }),
      info: (message: string, fields?: LogFields) => emit("info", message, { ...bound, ...fields }),
      warn: (message: string, fields?: LogFields) => emit("warn", message, { ...bound, ...fields }),
      error: (message: string, fields?: LogFields) =>
        emit("error", message, { ...bound, ...fields }),
    };
  },
};

export type Logger = typeof logger;

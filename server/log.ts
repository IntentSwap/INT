// Structured logs. Operational events go to stdout. Access lines go to daily
// files that are pruned after 14 days. Neither ever carries a secret, a full
// IP address, a request body or a wallet address.
//
// An order is named in either by a short one-way hash of its ID (`hashId`), never by the ID. For an
// order made in Ghost mode that hash is the whole of it: no line carries anything else that could
// name the order, the provider's tracing ID included.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function emit(level: string, event: string, fields: Record<string, unknown> | undefined, sink: (line: string) => void): void {
  sink(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }));
}

export function createLogger(sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  return {
    info: (event, fields) => emit("info", event, fields, sink),
    warn: (event, fields) => emit("warn", event, fields, sink),
    error: (event, fields) => emit("error", event, fields, sink),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Short one-way hash of an order ID, for logs. */
export function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

/** Describes an error for a log line without leaking a message that may contain upstream data. */
export function errorKind(err: unknown): string {
  if (err instanceof Error) return err.name === "Error" ? err.constructor.name : err.name;
  return typeof err;
}

export interface AccessEntry {
  route: string;
  method: string;
  status: number;
  ms: number;
  ip: string | null;
  country: string | null;
  /** The order's hashed ID. */
  order?: string;
  screening?: string;
  /** The provider's tracing ID of the call made for this request. Never there for an order made in Ghost mode. */
  cid?: string;
}

export interface AccessLog {
  write(entry: AccessEntry): void;
  prune(): void;
}

export const ACCESS_LOG_DAYS = 14;
/** Most bytes written to one day's file. With 14 days kept, the logs can never fill the volume the orders live on. */
export const ACCESS_LOG_MAX_BYTES_PER_DAY = 50 * 1024 * 1024;

/**
 * Daily access-log files under `dir`. Files older than 14 days are deleted,
 * and each day's file stops growing at a fixed size: a flood of requests
 * costs log lines, never disk space for orders.
 */
export function createAccessLog(dir: string, now: () => number = Date.now, maxBytesPerDay: number = ACCESS_LOG_MAX_BYTES_PER_DAY): AccessLog {
  fs.mkdirSync(dir, { recursive: true });
  let day = "";
  let stream: fs.WriteStream | null = null;
  let written = 0;
  let capped = false;
  const open = (today: string) => {
    stream?.end();
    day = today;
    const file = path.join(dir, `access-${today}.log`);
    try {
      written = fs.statSync(file).size;
    } catch {
      written = 0;
    }
    capped = false;
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", () => {
      stream = null;
    });
  };
  const prune = () => {
    const cutoff = now() - ACCESS_LOG_DAYS * 86_400_000;
    for (const name of fs.readdirSync(dir)) {
      const match = /^access-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!match) continue;
      if (Date.parse(`${match[1]}T23:59:59Z`) < cutoff) fs.rmSync(path.join(dir, name), { force: true });
    }
  };
  return {
    write(entry) {
      const stamp = new Date(now()).toISOString();
      const today = stamp.slice(0, 10);
      if (today !== day || stream === null) open(today);
      const line = `${JSON.stringify({ t: stamp, ...entry })}\n`;
      if (written + line.length > maxBytesPerDay) {
        if (!capped) {
          capped = true;
          const note = `${JSON.stringify({ t: stamp, note: "daily size limit reached; further lines for today are dropped" })}\n`;
          written += note.length;
          stream?.write(note);
        }
        return;
      }
      written += line.length;
      stream?.write(line);
    },
    prune,
  };
}

export const nullAccessLog: AccessLog = { write() {}, prune() {} };

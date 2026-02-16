import { randomUUID } from "node:crypto";

export function ensureId(existing: string | undefined, prefix: string): string {
  if (existing && existing.trim().length > 0) {
    return existing;
  }
  return `${prefix}_${randomUUID()}`;
}

export function traceRef(): string {
  return `trace_${randomUUID()}`;
}

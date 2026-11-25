import type { Analysis } from "./engine.ts";

export type Outcome =
  | { ok: true; analysis: Analysis; source: "cache" | "database"; entry: string }
  | { ok: false; message: string; code: number };

export const successfulAnalysis = function (analysis: Analysis, source: "cache" | "database", entry: string): Extract<Outcome, { ok: true }> {
  // oxlint-disable-next-line eslint/sort-keys -- Keep the existing observable order of the successful session result.
  return { ok: true, analysis, source, entry };
};

export const failedAnalysis = function (message: string, code: number): Extract<Outcome, { ok: false }> {
  // oxlint-disable-next-line eslint/sort-keys -- Keep the existing observable order of the failed session result.
  return { ok: false, message, code };
};

export interface SchemaSnapshot {
  at: number;
  error?: string;
  fatal?: boolean;
  value: string | null;
}

export const liveSchema = function (value: string, at: number): SchemaSnapshot {
  // oxlint-disable-next-line eslint/sort-keys -- The session exposes these fields in fingerprint-first order.
  return { value, at };
};

export const offlineSchema = function (at: number, error: string, fatal = false): SchemaSnapshot {
  // oxlint-disable-next-line eslint/sort-keys, unicorn/no-null -- The schema result uses null for no catalog and keeps the existing diagnostic field order.
  return { value: null, at, error, ...(fatal ? { fatal: true } : {}) };
};

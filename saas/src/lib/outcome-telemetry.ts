// Milestone 5 OPS02: server-side outcome observation for inspection saves and exports. Server code only:
// imported solely by the "use server" actions file and route handlers (a unit test guards this; no
// server-only package is added). Nothing runs at import time.
//
// Per observation, exactly once:
// 1. A static, privacy-safe JSON line goes to stdout: server-generated event ID, op, outcome, ISO time. This
//    is the trusted server record. Nothing from the request (payload, notes, labels, URL, query, IDs, error
//    text) is ever included. A logging failure is swallowed.
// 2. Only when a signed-in caller's session is available, a best-effort counter update is scheduled with
//    Next's after(), so it runs after the response. It goes through the caller's own session (there is no
//    privileged client), is aborted and abandoned after 750 ms, and its failure only produces a static
//    telemetry_recording_failed line. Nothing here can change the save or export result.
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import type { AppOutcome, Op } from "@/lib/application-outcomes";

export const RECORD_TIMEOUT_MS = 750;

/** Counter update through the caller's session; must honour the abort signal. */
export type Recorder = (op: Op, outcome: AppOutcome, signal: AbortSignal) => PromiseLike<{ error: unknown }>;

export interface TelemetryDeps {
  log: (line: string) => void;
  schedule: (task: () => Promise<void>) => void;
  uuid: () => string;
  now: () => Date;
  timeoutMs: number;
}
export const defaultDeps = (): TelemetryDeps => ({
  log: (line) => console.log(line),
  schedule: (task) => after(task),
  uuid: randomUUID,
  now: () => new Date(),
  timeoutMs: RECORD_TIMEOUT_MS,
});

const safeLog = (deps: TelemetryDeps, line: Record<string, string>) => {
  try { deps.log(JSON.stringify(line)); } catch { /* logging must never affect the request */ }
};

/** Bounded, never-rejecting counter update. */
export async function recordBounded(record: Recorder, op: Op, outcome: AppOutcome, deps: TelemetryDeps): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, deps.timeoutMs);
  });
  let ok = false;
  try {
    const r = await Promise.race([Promise.resolve(record(op, outcome, controller.signal)), timedOut]);
    ok = r !== "timeout" && !r.error;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  if (!ok) {
    let at = "";
    try { at = deps.now().toISOString(); } catch { /* fall through with no time */ }
    safeLog(deps, { event: "telemetry_recording_failed", op, at });
  }
}

/** Log once, then (if a session recorder exists) schedule one bounded counter update. Never throws. */
export function observeOutcome(op: Op, outcome: AppOutcome, record: Recorder | null, deps: TelemetryDeps = defaultDeps()): void {
  try {
    safeLog(deps, { event: "application_outcome", id: deps.uuid(), op, outcome, at: deps.now().toISOString() });
  } catch { /* uuid/clock failure: skip the line, never the request */ }
  if (!record) return;
  try {
    deps.schedule(() => recordBounded(record, op, outcome, deps));
  } catch {
    safeLog(deps, { event: "telemetry_recording_failed", op, at: "" });
  }
}

export interface Observed<T> { outcome: AppOutcome; value: T }
export interface ObservationContext { record: Recorder | null }

/**
 * Run one instrumented operation. The body returns its unchanged result plus the outcome; a thrown error is
 * observed as failed and the original error is rethrown untouched. The body sets ctx.record once the
 * caller's session is confirmed.
 */
export async function observed<T>(op: Op, body: (ctx: ObservationContext) => Promise<Observed<T>>,
  deps?: TelemetryDeps): Promise<T> {
  const ctx: ObservationContext = { record: null };
  let r: Observed<T>;
  try {
    r = await body(ctx);
  } catch (e) {
    observeOutcome(op, "failed", ctx.record, deps);
    throw e;
  }
  observeOutcome(op, r.outcome, ctx.record, deps);
  return r.value;
}

interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): { abortSignal(signal: AbortSignal): PromiseLike<{ error: unknown }> };
}

/** Counter update through the caller's own Supabase session (public.record_application_outcome). */
export const sessionRecorder = (supabase: RpcClient): Recorder => (op, outcome, signal) =>
  supabase.rpc("record_application_outcome", { p_op: op, p_outcome: outcome }).abortSignal(signal);

// Database access for Edge Functions, through one scoped role per function (never the service-role key).
// Only allow-listed SECURITY DEFINER entry points can be called; arguments are always bound
// parameters. The Deno runtime implementation lives in deno/pg.ts; tests use an embedded Postgres.
export const ROLE_FUNCTIONS = {
  billing_intake: ["billing.ingest_event", "platform.get_webhook_secrets"],
  billing_worker: ["billing.start_run", "billing.finish_run", "billing.claim_events", "billing.complete_event", "billing.fail_event",
    "billing.absorb_checkout", "billing.absorb_payment", "billing.absorb_subscription", "billing.absorb_refund", "billing.absorb_dispute",
    "billing.reconcile_candidates", "billing.checkout_retry_context", "billing.record_checkout_result", "billing.housekeeping",
    "billing.worker_connections", "platform.get_credential", "billing.release_event", "billing.discovery_begin",
    "billing.discovery_record_page", "billing.discovery_claim", "billing.discovery_classify", "billing.discovery_finish"],
  billing_gateway: ["billing.gateway_checkout_context", "billing.gateway_bind_customer", "billing.gateway_customer_review",
    "billing.gateway_mark_requesting", "billing.gateway_record_checkout", "billing.gateway_portal_context", "billing.gateway_portal_refused",
    "billing.gateway_cancel_context", "billing.gateway_apply_subscription", "platform.get_credential", "platform.gateway_test_context",
    "platform.gateway_record_test"],
} as const;
export type ScopedRole = keyof typeof ROLE_FUNCTIONS;

/** Postgres type of each positional argument, so the runtime can cast bound text parameters. */
export type ArgType = "uuid" | "text" | "integer" | "bigint" | "boolean" | "jsonb" | "timestamptz" | "bytea_hex" | "text[]";

export interface ScopedDb {
  readonly role: ScopedRole;
  /** Calls a scalar function and returns its single value. */
  call<T>(fn: string, args: [ArgType, unknown][]): Promise<T>;
  /** Calls a set-returning function and returns its rows. */
  rows<T>(fn: string, args: [ArgType, unknown][]): Promise<T[]>;
}

export function assertAllowed(role: ScopedRole, fn: string): void {
  if (!(ROLE_FUNCTIONS[role] as readonly string[]).includes(fn)) throw new Error(`function not allowed for ${role}`);
}

const CAST: Record<ArgType, string> = {
  uuid: "::uuid", text: "::text", integer: "::integer", bigint: "::bigint", boolean: "::boolean", jsonb: "::jsonb",
  timestamptz: "::timestamptz", bytea_hex: "", "text[]": "::text[]",
};
/** SQL text for a call with bound parameters $1..$n (bytea is passed as hex and decoded in SQL). */
export function callSql(fn: string, args: [ArgType, unknown][], setReturning = false): string {
  if (!/^(billing|platform)\.[a-z_]{3,60}$/.test(fn)) throw new Error("invalid function name");
  const params = args.map(([t], i) => (t === "bytea_hex" ? `decode($${i + 1}::text, 'hex')` : `$${i + 1}${CAST[t]}`)).join(", ");
  return setReturning ? `select * from ${fn}(${params})` : `select ${fn}(${params}) as r`;
}

/** Database error codes raised by private.fail are the message; anything else becomes "db_error". */
export function dbErrorCode(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /^[a-z_]{3,60}$/.test(m) ? m : "db_error";
}

/** Bind pre-serialized jsonb as explicit PostgreSQL text, then let ::jsonb cast it server-side.
 * postgres.js otherwise infers jsonb and JSON.stringify() encodes the JSON text a second time.
 * Keep the original text so large integers, JSON null, arrays and scalar types remain exact.
 */
export function toDriverArgs(args: [ArgType, unknown][], asText: (value: string) => unknown): unknown[] {
  return args.map(([type, value]) => {
    if (value === null || value === undefined) return null;
    if (type !== "jsonb") return value;
    if (typeof value !== "string") throw new Error("invalid_json_argument");
    try { JSON.parse(value); } catch { throw new Error("invalid_json_argument"); }
    return asText(value);
  });
}

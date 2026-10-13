// M5 development-only automatic owner email: the operations-mailer core (gates, fixed request, outcome mapping,
// lease-bound finish, static responses), its source and the operator cron scripts, the read validator, the switch
// actions and the alerts page section. Database and fetch are always stubs: no network, no real key or token.
import { createHash, X509Certificate } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEV_PROJECT_URL, handle, MAIL_ENV, MAIL_FROM, MAIL_TO, MAX_RESPONSE_BYTES, RESEND_URL, validateClaim, type MailerDb,
} from "../../supabase/functions/operations-mailer/core.ts";
import { SUPABASE_ROOT_2021_CA } from "../../supabase/functions/operations-mailer/supabase-ca.ts";
import {
  LEDGER_LABELS, MAILER_MESSAGES, MAILER_STATE_LABELS, mailerState, SCHEDULE_NOTE, validateMailer, type MailerView,
} from "@/lib/operations-mailer";

const root = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const TOKEN = "T".repeat(40);
const KEY = "re_TESTONLY_FAKEKEY_000000000000";
const DBURL = "postgres://operations_mail.x:FAKEPASSWORD@pooler.example:6543/postgres";
const LEASE = "eeeeeeee-5b00-4000-8000-000000000001";
const LEASE2 = "eeeeeeee-5b00-4000-8000-000000000002";
const LEDGER_ID = "eeeeeeee-5b00-4000-8000-0000000000aa";
const MSG = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const item = (o: Record<string, unknown> = {}) => ({ lease_token: LEASE, idempotency_key: `savour-alert-${LEDGER_ID}`, from: MAIL_FROM, to: MAIL_TO,
  subject: "SAVOUR development warning: Billing events waiting too long", text: "SAVOUR development warning. Fixed text.", ...o });

const consoles = ["log", "info", "warn", "error", "debug"] as const;
let envRead: string[];
let env: Record<string, string | undefined>;
let db: { heartbeat: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> };
let opened: number;
let fetchStub: ReturnType<typeof vi.fn>;
const deps = () => ({
  env: (n: string) => { envRead.push(n); return env[n]; },
  db: () => { opened++; return db as unknown as MailerDb; },
  fetch: fetchStub as unknown as typeof fetch,
});
const post = (o: { auth?: string | null; method?: string; body?: string; url?: string } = {}) => new Request(o.url ?? "https://fn.example/operations-mailer", {
  method: o.method ?? "POST", headers: o.auth === null ? {} : { authorization: o.auth ?? `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: (o.method ?? "POST") === "GET" ? undefined : o.body,
});
const run = async (req = post()) => { const res = await handle(req, deps()); return { status: res.status, body: await res.json() as Record<string, unknown> }; };
const claims = (...items: unknown[]) => db.claim.mockResolvedValue({ status: "ok", items });
const reply = (body: string | null, status: number) => fetchStub.mockResolvedValue(new Response(body, { status }));

beforeEach(() => {
  envRead = []; opened = 0;
  env = { [MAIL_ENV.projectUrl]: DEV_PROJECT_URL, [MAIL_ENV.triggerToken]: TOKEN, [MAIL_ENV.resendKey]: KEY, [MAIL_ENV.databaseUrl]: DBURL,
    SUPABASE_SERVICE_ROLE_KEY: "MARKER_SERVICE", SUPABASE_DB_URL: "MARKER_DBURL", SAVOUR_BILLING_WORKER_TOKEN: "MARKER_BILLING" };
  db = { heartbeat: vi.fn().mockResolvedValue("ok"), claim: vi.fn().mockResolvedValue({ status: "ok", items: [] }), finish: vi.fn().mockResolvedValue("recorded") };
  fetchStub = vi.fn();
  for (const c of consoles) vi.spyOn(console, c);
});
afterEach(() => {
  for (const c of consoles) expect(console[c]).not.toHaveBeenCalled();
  // Only the four mailer variables are ever read; never the injected broad secrets or billing ones.
  expect(new Set(envRead).size <= 4 && envRead.every((n) => (Object.values(MAIL_ENV) as string[]).includes(n) && n !== MAIL_ENV.databaseUrl)).toBe(true);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe("gates: nothing is opened, claimed or sent before them", () => {
  const untouched = () => { expect(opened).toBe(0); expect(db.claim).not.toHaveBeenCalled(); expect(db.heartbeat).not.toHaveBeenCalled(); expect(fetchStub).not.toHaveBeenCalled(); };

  it("POST only", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) expect((await run(post({ method }))).status, method).toBe(405);
    untouched();
  });

  it("unauthorized: missing, malformed, wrong or near-miss token, or a configured token shorter than 32", async () => {
    for (const auth of [null, "", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `bearer ${TOKEN}`, `Bearer  ${TOKEN}`, "Bearer MARKER_SERVICE"]) {
      expect(await run(post({ auth }))).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    env[MAIL_ENV.triggerToken] = "short-token-1234567890";
    expect((await run(post({ auth: "Bearer short-token-1234567890" }))).status).toBe(401);
    env[MAIL_ENV.triggerToken] = undefined;
    expect((await run()).status).toBe(401);
    untouched();
  });

  it("fails closed outside the exact development project", async () => {
    for (const url of [undefined, "", `${DEV_PROJECT_URL}/`, "https://otherprojectref00.supabase.co", DEV_PROJECT_URL.toUpperCase(), "http://ilhutasrxnbtssswmgam.supabase.co"]) {
      env[MAIL_ENV.projectUrl] = url;
      expect(await run()).toEqual({ status: 503, body: { error: "wrong_project" } });
    }
    untouched();
  });

  it("missing provider key: records not_configured, never claims or sends", async () => {
    for (const k of [undefined, ""]) {
      env[MAIL_ENV.resendKey] = k;
      expect(await run()).toEqual({ status: 200, body: { status: "not_configured", claimed: 0, accepted: 0, rejected: 0, unknown: 0, unrecorded: 0 } });
    }
    expect(db.heartbeat.mock.calls).toEqual([["not_configured"], ["not_configured"]]);
    expect(db.claim).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("with the key: heartbeat ready strictly before the claim", async () => {
    const order: string[] = [];
    db.heartbeat.mockImplementation(async (s: string) => { order.push(`heartbeat:${s}`); return "ok"; });
    db.claim.mockImplementation(async () => { order.push("claim"); return { status: "disabled", items: [] }; });
    expect(await run()).toEqual({ status: 200, body: { status: "disabled", claimed: 0, accepted: 0, rejected: 0, unknown: 0, unrecorded: 0 } });
    expect(order).toEqual(["heartbeat:ready", "claim"]);
  });
});

// ---------------------------------------------------------------------------
describe("the request to Resend comes only from the claim", () => {
  it("is fixed: literal URL, POST, bearer key, JSON, the claim's idempotency key, no redirects, no cache, 10 s abort", async () => {
    claims(item());
    reply(JSON.stringify({ id: MSG }), 200);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await run();
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(RESEND_URL).toBe(url);
    expect(Object.keys(init).sort()).toEqual(["body", "cache", "headers", "method", "redirect", "signal"]);
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Idempotency-Key": `savour-alert-${LEDGER_ID}` });
    expect(JSON.parse(init.body as string)).toEqual({ from: MAIL_FROM, to: [MAIL_TO], subject: item().subject, text: item().text });
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("ignores the request body, query and every other header", async () => {
    claims(item());
    reply(JSON.stringify({ id: MSG }), 200);
    const req = post({ url: "https://fn.example/operations-mailer?to=attacker@example.com&text=MARKER",
      body: JSON.stringify({ to: "attacker@example.com", from: "x@example.com", subject: "MARKER", text: "MARKER", lease_token: LEASE2, key: "MARKER" }) });
    await handle(req, deps());
    expect(req.bodyUsed).toBe(false);
    const init = fetchStub.mock.calls[0][1] as RequestInit;
    expect(JSON.stringify(init)).not.toMatch(/MARKER|attacker|x@example/);
    expect(db.finish.mock.calls).toEqual([[LEASE, "accepted", MSG]]);
  });

  it("an unexpected claim (other recipient or sender, extra field, bad lease or key, too many items) sends nothing and finishes nothing", async () => {
    const bad = [
      { status: "ok", items: [item({ to: "attacker@example.com" })] }, { status: "ok", items: [item({ from: "x@example.com" })] },
      { status: "ok", items: [item({ url: "https://evil.example" })] }, { status: "ok", items: [item({ lease_token: "nope" })] },
      { status: "ok", items: [item({ idempotency_key: "savour-verify-" + LEDGER_ID })] }, { status: "ok", items: [item({ text: "" })] },
      { status: "ok", items: [item(), item(), item(), item()] }, { status: "disabled", items: [item()] }, { status: "ok" }, null, "ok",
    ];
    for (const b of bad) {
      db.claim.mockResolvedValueOnce(b);
      expect(await run(), JSON.stringify(b)).toEqual({ status: 502, body: { error: "invalid_claim" } });
    }
    expect(fetchStub).not.toHaveBeenCalled();
    expect(db.finish).not.toHaveBeenCalled();
    expect(validateClaim({ status: "ok", items: [item(), item({ lease_token: LEASE2 })] })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("outcome mapping and lease-bound finish (accepted is not delivered)", () => {
  const outcomeFor = async (setup: () => void) => {
    db.finish.mockClear(); fetchStub.mockReset();
    claims(item());
    setup();
    const r = await run();
    return { finish: db.finish.mock.calls[0], body: r.body };
  };

  it("2xx with a uuid id: accepted with the lowercased id", async () => {
    const r = await outcomeFor(() => reply(JSON.stringify({ id: MSG.toUpperCase() }), 200));
    expect(r.finish).toEqual([LEASE, "accepted", MSG]);
    expect(r.body).toEqual({ status: "ok", claimed: 1, accepted: 1, rejected: 0, unknown: 0, unrecorded: 0 });
  });

  it("2xx without a usable id, 409, 5xx, 3xx, timeout and network errors: unknown", async () => {
    const cases: (() => void)[] = [
      ...[JSON.stringify({}), JSON.stringify({ id: "msg_1" }), "not json", "", null, JSON.stringify({ id: MSG, pad: "x".repeat(MAX_RESPONSE_BYTES) })].map((b) => () => reply(b, 200)),
      () => reply(JSON.stringify({ id: MSG }), 409), () => reply(null, 500), () => reply(null, 503), () => reply(null, 302),
      () => fetchStub.mockRejectedValue(new DOMException("MARKER", "TimeoutError")), () => fetchStub.mockRejectedValue(new TypeError("fetch failed MARKER")),
    ];
    for (const c of cases) expect((await outcomeFor(c)).finish).toEqual([LEASE, "unknown", null]);
  });

  it("a request that only ends when its signal aborts is unknown", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(5));
    const r = await outcomeFor(() => fetchStub.mockImplementation((_: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })));
    expect(r.finish).toEqual([LEASE, "unknown", null]);
  });

  it("other 4xx: rejected", async () => {
    for (const s of [400, 401, 403, 404, 422, 429]) expect((await outcomeFor(() => reply(JSON.stringify({ id: MSG }), s))).finish, String(s)).toEqual([LEASE, "rejected", null]);
  });

  it("each item finishes only its own lease; a stale or failing finish is counted unrecorded, never hidden", async () => {
    claims(item(), item({ lease_token: LEASE2 }));
    reply(JSON.stringify({ id: MSG }), 200);
    fetchStub.mockImplementation(async () => new Response(JSON.stringify({ id: MSG }), { status: 200 }));
    db.finish.mockResolvedValueOnce("stale").mockRejectedValueOnce(new Error("MARKER_DB connection string postgres://x"));
    const r = await run();
    expect(db.finish.mock.calls.map((c) => c[0])).toEqual([LEASE, LEASE2]);
    expect(r).toEqual({ status: 200, body: { status: "ok", claimed: 2, accepted: 2, rejected: 0, unknown: 0, unrecorded: 2 } });
  });

  it("database failures return a static error with counts only; key, URL and errors never appear", async () => {
    db.claim.mockRejectedValue(new Error(`MARKER ${DBURL} ${KEY}`));
    const r = await run();
    expect(r).toEqual({ status: 500, body: { error: "failed", claimed: 0, accepted: 0, rejected: 0, unknown: 0, unrecorded: 0 } });
    db.heartbeat.mockRejectedValue(new Error("MARKER"));
    expect((await run()).status).toBe(500);
    claims(item());
    db.heartbeat.mockResolvedValue("ok");
    reply(JSON.stringify({ id: MSG, message: `MARKER ${KEY}` }), 422);
    const out = JSON.stringify(await run());
    expect(out).not.toMatch(/MARKER|re_TESTONLY|postgres:|FAKEPASSWORD|api\.resend/);
  });
});

// ---------------------------------------------------------------------------
describe("worker source", () => {
  const core = read("supabase", "functions", "operations-mailer", "core.ts");
  const entry = read("supabase", "functions", "operations-mailer", "index.ts");
  const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("never names the injected broad secrets or other credentials, and never logs", () => {
    for (const src of [core, entry]) {
      expect(src).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DB_URL|SUPABASE_ANON_KEY|service_role|SAVOUR_BILLING|SAVOUR_ALERT_RESEND|vault|net\.http/i);
      expect(code(src)).not.toMatch(/console\.|\blog\(/);
    }
  });

  it("the entry has its own adapter: pinned postgres import, the three fixed functions, the operations_mail login only", () => {
    expect([...entry.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual(["postgres", "./core.ts", "./supabase-ca.ts"]);
    expect(JSON.parse(read("supabase", "functions", "deno.json")).imports.postgres).toBe("npm:postgres@3.4.5");
    expect(entry).not.toContain("_shared");
    expect([...entry.matchAll(/select (operations\.[a-z_]+)\(/g)].map((m) => m[1])).toEqual(["operations.mailer_heartbeat", "operations.mailer_claim", "operations.mailer_finish"]);
    expect(entry).toContain('user !== "operations_mail" && !user.startsWith("operations_mail.")');
    // Strict TLS: explicit trust in the bundled CA with certificate verification on; host name checking left to the
    // driver (servername) and Node's default identity check. No bypass of any kind.
    const c = code(entry);
    expect(c).toContain("ssl: { rejectUnauthorized: true, ca: SUPABASE_ROOT_2021_CA }");
    expect(c.match(/ssl:/g)).toHaveLength(1);
    expect(c.match(/rejectUnauthorized/g)).toHaveLength(1);
    expect(c).not.toMatch(/rejectUnauthorized:\s*(false|0|!|undefined|null)|checkServerIdentity|servername|NODE_TLS_REJECT_UNAUTHORIZED|unsafely|insecure/i);
    expect(c).not.toMatch(/ssl:\s*("(require|allow|prefer|verify-ca|disable)"|false)/);
    expect(c).not.toMatch(/Deno\.read|readFile|\.crt/); // the CA is bundled, never read from disk at runtime
    for (const src of [core, read("supabase", "functions", "operations-mailer", "supabase-ca.ts")]) {
      expect(src).not.toMatch(/checkServerIdentity|rejectUnauthorized/);
    }
  });

  it("the bundled CA is exactly the published Supabase Root 2021 CA (SHA-256 certificate fingerprint) and a self-signed CA", () => {
    const x = new X509Certificate(SUPABASE_ROOT_2021_CA);
    // The published SHA-256 is the certificate fingerprint: SHA-256 over the DER encoding.
    expect(createHash("sha256").update(x.raw).digest("hex").toUpperCase()).toBe("807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA");
    expect(x.fingerprint256).toBe("80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
    expect(SUPABASE_ROOT_2021_CA.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(1);
    expect(SUPABASE_ROOT_2021_CA).not.toMatch(/PRIVATE KEY/);
    expect(x.ca).toBe(true);
    expect(x.subject).toContain("CN=Supabase Root 2021 CA");
    expect(x.issuer).toBe(x.subject);
    expect(x.checkIssued(x)).toBe(true);
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2031);
    // Only the bundled module is deployed; no redundant certificate file or other assets.
    const dir = join(root, "supabase", "functions", "operations-mailer");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["core.ts", "index.ts", "supabase-ca.ts"]);
    expect([...entry.matchAll(/Deno\.env\.get\(([^)]+)\)/g)].map((m) => m[1])).toEqual(["MAIL_ENV.databaseUrl", "name"]);
    expect(core).not.toMatch(/Deno\./);
    expect(read("tsconfig.json")).toContain('"supabase/functions/*/index.ts"');
  });
});

// ---------------------------------------------------------------------------
describe("operator cron source (not a migration)", () => {
  const sched = read("supabase", "cron", "operations_mailer_schedule.sql");
  const unsched = read("supabase", "cron", "operations_mailer_unschedule.sql");
  const exec = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("checks pg_cron, pg_net, the job functions and the migration before anything is created or scheduled", () => {
    const first = Math.min(sched.indexOf("create or replace function"), sched.indexOf("cron.schedule('savour"));
    for (const c of ["pg_cron is not enabled", "pg_net is not enabled", "cron.schedule is missing", "net.http_post is missing", "operations mailer migration is not applied"]) {
      expect(sched.indexOf(c), c).toBeGreaterThan(-1);
      expect(sched.indexOf(c), c).toBeLessThan(first);
    }
  });

  it("reads the URL and trigger from Vault by fixed names, validates the exact function URL and the token, then schedules the sixth job", () => {
    expect(sched).toContain("vault.decrypted_secrets s where s.name = 'savour_operations_mailer_url'");
    expect(sched).toContain("vault.decrypted_secrets s where s.name = 'savour_operations_mailer_trigger'");
    expect(sched.match(/v_url is distinct from 'https:\/\/ilhutasrxnbtssswmgam\.supabase\.co\/functions\/v1\/operations-mailer'/g)).toHaveLength(2);
    expect(sched.match(/length\(v_trigger\) < 32/g)).toHaveLength(2);
    expect(sched.lastIndexOf("length(v_trigger) < 32")).toBeLessThan(sched.indexOf("select cron.schedule("));
    expect([...exec(sched).matchAll(/cron\.schedule\('([^']+)', '([^']+)', '([^']+)'\)/g)].map((m) => m.slice(1)))
      .toEqual([["savour-operations-mailer", "*/5 * * * *", "select private.operations_mailer_invoke()"]]);
  });

  it("posts an empty body with only the bearer trigger and content type, a 10 second timeout, and an owner-only helper", () => {
    expect(sched).toContain("body := '{}'::jsonb");
    expect(sched).toContain("params := '{}'::jsonb");
    expect(sched).toContain("headers := jsonb_build_object('Authorization', 'Bearer ' || v_trigger, 'Content-Type', 'application/json')");
    expect(sched).toContain("timeout_milliseconds := 10000");
    expect(sched).toMatch(/revoke all on function private\.operations_mailer_invoke\(\)\s+from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker, operations_mail;/);
    expect(exec(sched)).not.toMatch(/\bgrant\b/i);
  });

  it("holds no provider key, password, database URL or literal token, and touches no other job", () => {
    for (const s of [exec(sched), exec(unsched)]) {
      expect(s).not.toMatch(/resend|RESEND|re_[A-Za-z0-9]|password|postgres:\/\/|SAVOUR_MAIL_|Bearer [A-Za-z0-9]{16,}|[A-Fa-f0-9]{32,}/);
      expect(s).not.toMatch(/savour-billing|alter extension|grant .* on .* net\.|cron\.alter_job/i);
    }
    expect(exec(unsched).trim().split("\n")).toEqual(["begin;",
      "select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'savour-operations-mailer';",
      "drop function if exists private.operations_mailer_invoke();", "commit;"]);
  });

  it("the schedule script is one transaction: begin before every statement, commit after the schedule", () => {
    const lines = exec(sched).split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines[0]).toBe("begin;");
    expect(lines.at(-1)).toBe("commit;");
    expect(exec(sched).match(/^\s*(begin|commit);/gm)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
const OBS = "2026-10-13T12:00:00+00:00";
const at = (min: number) => new Date(Date.parse(OBS) - min * 60_000).toISOString().replace(".000Z", "+00:00");
const view = (o: Partial<MailerView> = {}, w: Partial<MailerView["worker"]> = {}): MailerView => ({
  observed_at: OBS, enabled: false, enabled_changed_at: null,
  worker: { status: "ready", key_present: true, last_checked_at: at(2), last_ready_at: at(2), freshness: "fresh", ...w },
  scheduler: { job: "active", last_scheduled_start_at: at(3), last_scheduled_status: "succeeded" },
  ready_to_enable: true, today: { utc_day: "2026-10-13", automatic_limit: 5, manual_limit: 1, automatic_attempts: 2 },
  queue: { pending: 1, leased: 0, unknown: 1, review: 0 }, last_accepted_at: at(30), recent: [], ...o,
});
const recent = (o: Record<string, unknown> = {}) => ({ code: "APP_FAILURES_REPORTED", status: "accepted", attempts: 1, created_at: at(40),
  first_dispatched_at: at(40), finished_at: at(39), ...o });

describe("read validation (fail closed) and headline state", () => {
  it("accepts consistent data and rejects extra keys, unknown enums, inconsistent worker facts, over-limit counts and future times", () => {
    expect(validateMailer(view())).not.toBeNull();
    expect(validateMailer(view({ recent: [recent()] as never }))).not.toBeNull();
    const never = view({ ready_to_enable: false }, { status: null, key_present: null, last_checked_at: null, last_ready_at: null, freshness: "never" });
    expect(validateMailer(never)).not.toBeNull();
    const bad: unknown[] = [
      null, { ...view(), key: "x" }, view({ recent: [recent({ status: "delivered" })] as never }), view({ recent: [recent({ body: "x" })] as never }),
      view({}, { key_present: false }), view({}, { freshness: "stale" }), view({ ready_to_enable: false }),
      view({}, { last_checked_at: at(11), last_ready_at: at(11) }), view({ today: { utc_day: "2026-10-13", automatic_limit: 6, manual_limit: 1, automatic_attempts: 2 } }),
      view({ today: { utc_day: "2026-10-13", automatic_limit: 5, manual_limit: 1, automatic_attempts: 6 } }), view({ last_accepted_at: at(-5) }),
      view({ recent: Array.from({ length: 15 }, () => recent()) as never }), view({ recent: [recent({ status: "pending", attempts: 1 })] as never }),
      view({ recent: [recent({ attempts: 0 })] as never }),
      // scheduler: unknown enums, a start without status, a run listed for an absent or unmeasured job, a future start,
      // and ready_to_enable claimed without an active job
      view({ scheduler: { job: "healthy", last_scheduled_start_at: null, last_scheduled_status: null } as never }),
      view({ scheduler: { job: "active", last_scheduled_start_at: at(3), last_scheduled_status: "delivered" } as never }),
      view({ scheduler: { job: "active", last_scheduled_start_at: at(3), last_scheduled_status: null } }),
      view({ scheduler: { job: "absent", last_scheduled_start_at: at(3), last_scheduled_status: "succeeded" } }),
      view({ scheduler: { job: "not_measured", last_scheduled_start_at: at(3), last_scheduled_status: "succeeded" } }),
      view({ scheduler: { job: "active", last_scheduled_start_at: at(-1), last_scheduled_status: "succeeded" } }),
      view({ scheduler: { job: "inactive", last_scheduled_start_at: null, last_scheduled_status: null } }),
      { ...view(), scheduler: undefined },
      view({}, { last_checked_at: at(-1), last_ready_at: at(-1) }), // future worker check
    ];
    for (const b of bad) expect(validateMailer(b), JSON.stringify(b).slice(0, 200)).toBeNull();
  });

  it("leased counts have no fixed cap: 10 leases spanning a UTC midnight are valid; negatives are not", () => {
    expect(validateMailer(view({ queue: { pending: 0, leased: 10, unknown: 0, review: 0 } }))?.queue.leased).toBe(10);
    expect(validateMailer(view({ queue: { pending: 0, leased: -1, unknown: 0, review: 0 } }))).toBeNull();
    expect(validateMailer(view({ queue: { pending: 0, leased: 1.5, unknown: 0, review: 0 } }))).toBeNull();
  });

  it("scheduler facts are separate from the worker: not measured or no runs are valid, and never make it ready", () => {
    const nm = view({ ready_to_enable: false, scheduler: { job: "not_measured", last_scheduled_start_at: null, last_scheduled_status: null } });
    expect(validateMailer(nm)).not.toBeNull();
    expect(mailerState(nm)).toBe("not_scheduled");
    expect(validateMailer(view({ scheduler: { job: "active", last_scheduled_start_at: null, last_scheduled_status: null } }))).not.toBeNull();
    const paused = view({ ready_to_enable: false, scheduler: { job: "inactive", last_scheduled_start_at: at(90), last_scheduled_status: "failed" } });
    expect(validateMailer(paused)).not.toBeNull();
  });

  it("states: unavailable, pending, worker stale, not scheduled, ready, enabled, enabled but unconfirmed", () => {
    const off = { ready_to_enable: false };
    expect(mailerState(null)).toBe("unavailable");
    expect(mailerState(view(off, { status: "not_configured", key_present: false, last_ready_at: null }))).toBe("pending");
    expect(mailerState(view(off, { last_checked_at: at(12), last_ready_at: at(12), freshness: "stale" }))).toBe("worker_stale");
    expect(mailerState(view({ ...off, scheduler: { job: "absent", last_scheduled_start_at: null, last_scheduled_status: null } }))).toBe("not_scheduled");
    expect(mailerState(view())).toBe("ready");
    expect(mailerState(view({ enabled: true }))).toBe("enabled");
    expect(mailerState(view({ enabled: true, ...off }, { last_checked_at: at(12), last_ready_at: at(12), freshness: "stale" }))).toBe("enabled_unconfirmed");
    expect(mailerState(view({ enabled: true, ...off, scheduler: { job: "inactive", last_scheduled_start_at: null, last_scheduled_status: null } }))).toBe("enabled_unconfirmed");
  });
});

// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({ rpc: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ supabase: { rpc: state.rpc } }) }));
const actions = await import("@/app/platform/alerts/mailer-actions");
const { AutomaticEmail } = await import("@/app/platform/alerts/automatic-email");
const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f; };

describe("switch actions", () => {
  beforeEach(() => { state.rpc.mockReset(); state.revalidate.mockReset(); });

  it("need the confirmation tick and call only the fixed RPC with no arguments, ignoring every other field", async () => {
    expect(await actions.enableAutomaticEmail(null, form({}))).toEqual({ error: MAILER_MESSAGES.confirmEnable });
    expect(await actions.disableAutomaticEmail(null, form({ confirm: "yes" }))).toEqual({ error: MAILER_MESSAGES.confirmDisable });
    expect(state.rpc).not.toHaveBeenCalled();
    state.rpc.mockResolvedValue({ data: "enabled", error: null });
    expect(await actions.enableAutomaticEmail(null, form({ confirm: "on", to: "attacker@example.com", limit: "100" }))).toEqual({ ok: MAILER_MESSAGES.enabled });
    state.rpc.mockResolvedValue({ data: "disabled", error: null });
    expect(await actions.disableAutomaticEmail(null, form({ confirm: "on" }))).toEqual({ ok: MAILER_MESSAGES.disabled });
    expect(state.rpc.mock.calls).toEqual([["platform_enable_operations_mailer"], ["platform_disable_operations_mailer"]]);
    expect(state.revalidate).toHaveBeenCalledWith("/platform/alerts");
  });

  it("maps aal1, not ready, forbidden and anything else to static messages", async () => {
    for (const [message, expected] of [["mfa_required", { error: MAILER_MESSAGES.mfa, data: { mfa: true } }], ["mailer_not_ready", { error: MAILER_MESSAGES.notReady }],
      ["mailer_not_scheduled", { error: MAILER_MESSAGES.notScheduled }],
      ["forbidden", { error: MAILER_MESSAGES.forbidden }], ["MARKER db text", { error: MAILER_MESSAGES.failed }]] as const) {
      state.rpc.mockResolvedValue({ data: null, error: { message, details: "MARKER" } });
      expect(await actions.enableAutomaticEmail(null, form({ confirm: "on" }))).toEqual(expected);
    }
  });
});

describe("automatic email section", () => {
  const html = (v: MailerView | null) => renderToStaticMarkup(AutomaticEmail({ view: v }));
  const esc = (t: string) => t.replace(/'/g, "&#x27;");

  it("ready: shows the terms, the worker's own key report, counters and one enable form with only the tick", () => {
    const h = html(view({ recent: [recent(), recent({ status: "unknown", attempts: 2 })] as never }));
    expect(h).toContain(esc(MAILER_STATE_LABELS.ready));
    expect(h).toContain("Development only: every email goes to the owner test address nonsou@gmail.com from onboarding@resend.dev");
    expect(h).toContain("Two fixed, separate budgets: at most 5 automatic attempts per UTC day plus the 1 manual verification per day, so at most 6 a day");
    expect(h).toContain("warnings that are already active are emailed too");
    // Worker heartbeat and scheduled run are separate lines; a scheduler success is explicitly not delivery or health.
    expect(h).toContain("Last worker check (scheduled or by hand): 2026-10-13 11:58:00 UTC");
    expect(h).toContain("Scheduled job: found and active. Latest scheduled run: 2026-10-13 11:57:00 UTC, the scheduler queued the request.");
    expect(h).toContain("A worker call by hand never counts as a scheduled run.");
    expect(h).toContain(SCHEDULE_NOTE);
    expect(h).toContain("It is not confirmation of delivery");
    expect(h).toContain("No response time is promised");
    expect(h).toContain("Worker key: present (as reported by the worker)");
    expect(h).toContain("2 of 5 automatic attempts used");
    expect(h).toContain("Accepted is not delivered");
    expect(h.match(/<form/g)).toHaveLength(1);
    expect([...h.matchAll(/<input[^>]*>/g)].map((m) => m[0])).toEqual(['<input type="checkbox" required="" name="confirm"/>']);
    expect(h).toContain("Switch automatic email on");
    expect(h).toContain(esc(LEDGER_LABELS.accepted));
    expect(h).not.toMatch(/>\s*Delivered|re_|Bearer/);
    expect(h).toContain('style="overflow-wrap:anywhere"');
  });

  it("pending, stale or unscheduled: no switch; enabled: only the off switch; unreadable: error and no form", () => {
    const pending = html(view({ ready_to_enable: false }, { status: "not_configured", key_present: false, last_ready_at: null }));
    expect(pending).toContain("Worker key: missing (as reported by the worker)");
    expect(pending).not.toMatch(/<form/);
    expect(html(view({ ready_to_enable: false }, { last_checked_at: at(12), last_ready_at: at(12), freshness: "stale" }))).not.toMatch(/<form/);
    const unscheduled = html(view({ ready_to_enable: false, scheduler: { job: "not_measured", last_scheduled_start_at: null, last_scheduled_status: null } }));
    expect(unscheduled).toContain(esc(MAILER_STATE_LABELS.not_scheduled));
    expect(unscheduled).toContain("Scheduled job: not measured");
    expect(unscheduled).toContain("Latest scheduled run: none recorded");
    expect(unscheduled).not.toMatch(/<form/);
    const on = html(view({ enabled: true, enabled_changed_at: at(60) }));
    expect(on).toContain("Switch automatic email off");
    expect(on).not.toContain("Switch automatic email on");
    const none = html(null);
    expect(none).toContain(MAILER_STATE_LABELS.unavailable);
    expect(none).not.toMatch(/<form|<button/);
  });
});

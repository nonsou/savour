// M5 Stage 1 owner email verification: the server action (order of gates, fixed request, outcome mapping, honest
// failure reporting), the read validator and the UI section. fetch is always a stub: no network, no real key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RESPONSE_BYTES, MESSAGES, RESEND_URL, sendingConfigured, STATUS_LABELS, validateReservation, validateVerifications,
  VERIFICATION_FROM, VERIFICATION_SUBJECT, VERIFICATION_TEXT, VERIFICATION_TO, type VerificationsView,
} from "@/lib/alert-email";

const KEY = "re_TESTONLY_FAKEKEY_000000000000";
const ID = "eeeeeeee-5900-4000-8000-000000000001";
const MSG_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const RESERVATION = { id: ID, from: VERIFICATION_FROM, to: VERIFICATION_TO, subject: VERIFICATION_SUBJECT, text: VERIFICATION_TEXT };

const state = vi.hoisted(() => ({ rpc: vi.fn(), fetch: vi.fn(), revalidate: vi.fn(), signedIn: true }));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!state.signedIn) throw new Error("REDIRECT /login?next=%2Fplatform%2Falerts");
    return { supabase: { rpc: state.rpc } };
  },
}));
const { sendVerificationEmail } = await import("@/app/platform/alerts/actions");
const { EmailVerification } = await import("@/app/platform/alerts/email-verification");

const form = (fields: Record<string, string> = { confirm: "on" }) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
/** rpc stub: reserve returns `reserve`, finish returns `finish`. */
const db = (reserve: { data: unknown; error: unknown } = { data: RESERVATION, error: null },
  finish: { data: unknown; error: unknown } = { data: "recorded", error: null }) => {
  state.rpc.mockImplementation(async (fn: string) => {
    if (fn === "platform_reserve_alert_email_verification") return reserve;
    if (fn === "platform_finish_alert_email_verification") return finish;
    throw new Error(`unexpected rpc ${fn}`);
  });
};
const reply = (body: string | null, status: number) => state.fetch.mockResolvedValue(new Response(body, { status }));
const finishArgs = () => state.rpc.mock.calls.find((c) => c[0] === "platform_finish_alert_email_verification")?.[1];
const run = (f = form()) => sendVerificationEmail(null, f);
const consoles = ["log", "info", "warn", "error", "debug"] as const;

beforeEach(() => {
  state.rpc.mockReset(); state.fetch.mockReset(); state.revalidate.mockReset(); state.signedIn = true;
  vi.stubGlobal("fetch", state.fetch);
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("SAVOUR_ALERT_RESEND_API_KEY", KEY);
  for (const c of consoles) vi.spyOn(console, c);
});
afterEach(() => {
  // Nothing is ever logged: not the key, the response, nor an error.
  for (const c of consoles) expect(console[c]).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe("gates before any call", () => {
  it("signed out: redirected before the database or Resend is touched", async () => {
    state.signedIn = false;
    await expect(run()).rejects.toThrow("REDIRECT");
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it("no confirmation tick (or any other value): nothing reserved or sent", async () => {
    db();
    for (const f of [form({}), form({ confirm: "true" }), form({ confirm: "yes" })]) expect(await run(f)).toEqual({ error: MESSAGES.confirm });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it("fails closed outside Preview or without a key: production, development, unset, empty key", async () => {
    db();
    for (const [env, key] of [["production", KEY], ["development", KEY], ["", KEY], ["preview", ""]] as const) {
      vi.stubEnv("VERCEL_ENV", env);
      vi.stubEnv("SAVOUR_ALERT_RESEND_API_KEY", key);
      expect(await run()).toEqual({ error: MESSAGES.notConfigured });
    }
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("SAVOUR_ALERT_RESEND_API_KEY", undefined);
    expect(await run()).toEqual({ error: MESSAGES.notConfigured });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it("reservation refused (aal1, daily cap, not an admin, anything else): static message, no Resend call, no finish", async () => {
    const cases: [string, { error: string; data?: Record<string, unknown> }][] = [
      ["mfa_required", { error: MESSAGES.mfa, data: { mfa: true } }],
      ["verification_daily_limit", { error: MESSAGES.dailyLimit }],
      ["forbidden", { error: MESSAGES.forbidden }],
      ["canceling statement MARKER_DB", { error: MESSAGES.reserveFailed }],
    ];
    for (const [message, expected] of cases) {
      state.rpc.mockReset();
      db({ data: null, error: { message, details: "MARKER_DETAIL" } });
      const out = await run();
      expect(out).toEqual(expected);
      expect(JSON.stringify(out)).not.toContain("MARKER");
      expect(state.rpc.mock.calls).toEqual([["platform_reserve_alert_email_verification"]]);
    }
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it("an unexpected reservation (other recipient, sender, text, extra field, bad id) is never sent", async () => {
    for (const bad of [{ ...RESERVATION, to: "attacker@example.com" }, { ...RESERVATION, from: "x@example.com" },
      { ...RESERVATION, text: "MARKER" }, { ...RESERVATION, subject: "Alert" }, { ...RESERVATION, url: "https://example.com" },
      { ...RESERVATION, id: "not-a-uuid" }, null, "x"]) {
      state.rpc.mockReset();
      db({ data: bad, error: null });
      expect(await run()).toEqual({ error: MESSAGES.reserveFailed });
      expect(finishArgs()).toBeUndefined();
    }
    expect(state.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("the one Resend request", () => {
  it("is fixed: literal URL, POST, bearer key, JSON, idempotency key from the ledger id, no redirects, no cache, 10 s abort", async () => {
    db();
    reply(JSON.stringify({ id: MSG_ID }), 200);
    await run();
    expect(state.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = state.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(RESEND_URL).toBe(url);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Idempotency-Key": `savour-verify-${ID}` });
    expect(JSON.parse(init.body as string)).toEqual({ from: VERIFICATION_FROM, to: [VERIFICATION_TO], subject: VERIFICATION_SUBJECT, text: VERIFICATION_TEXT });
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
    expect(Object.keys(init).sort()).toEqual(["body", "cache", "headers", "method", "redirect", "signal"]);
    expect(state.rpc.mock.calls[0]).toEqual(["platform_reserve_alert_email_verification"]); // no arguments
  });

  it("ignores every caller field except the confirmation tick", async () => {
    db();
    reply(JSON.stringify({ id: MSG_ID }), 200);
    await run(form({ confirm: "on", to: "attacker@example.com", from: "x@example.com", subject: "MARKER", text: "MARKER", html: "<b>MARKER</b>",
      url: "https://evil.example", id: "eeeeeeee-5900-4000-8000-0000000000ff", key: "re_MARKER", "Idempotency-Key": "MARKER" }));
    const [url, init] = state.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_URL);
    expect(JSON.stringify(init)).not.toMatch(/MARKER|attacker|evil|0000000000ff/);
    expect(finishArgs()).toEqual({ p_id: ID, p_outcome: "accepted", p_provider_message_id: MSG_ID });
  });

  it("only the server action reads the key; the shared lib and UI never read process.env for it", () => {
    const lib = readFileSync(join(import.meta.dirname, "..", "..", "src", "lib", "alert-email.ts"), "utf8");
    expect(lib).not.toMatch(/process\.env/);
    const ui = ["email-verification.tsx", "verification-form.tsx"].map((f) => readFileSync(join(import.meta.dirname, "..", "..", "src", "app", "platform", "alerts", f), "utf8")).join("\n");
    expect(ui).not.toMatch(/SAVOUR_ALERT_RESEND_API_KEY|process\.env/);
    expect(sendingConfigured({ VERCEL_ENV: "preview", SAVOUR_ALERT_RESEND_API_KEY: "x" })).toBe(true);
    expect(sendingConfigured({ VERCEL_ENV: "production", SAVOUR_ALERT_RESEND_API_KEY: "x" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("outcome mapping (self-reported; accepted is never delivered)", () => {
  const outcome = async () => (finishArgs() as { p_outcome: string; p_provider_message_id: string | null });

  it("2xx with a valid uuid id: accepted, recorded with the id; the message says it does not confirm delivery", async () => {
    db();
    reply(JSON.stringify({ id: MSG_ID.toUpperCase() }), 200);
    const out = await run();
    expect(await outcome()).toEqual({ p_id: ID, p_outcome: "accepted", p_provider_message_id: MSG_ID });
    expect(out).toEqual({ ok: MESSAGES.accepted });
    expect(out!.ok).toContain("does not confirm delivery");
    expect(out!.ok).not.toMatch(/\bdelivered\b/i);
    expect(state.revalidate).toHaveBeenCalledWith("/platform/alerts");
  });

  it("2xx without a usable id (missing, not a uuid, not JSON, empty, oversized): unknown", async () => {
    const bodies = [JSON.stringify({}), JSON.stringify({ id: "msg_123" }), JSON.stringify({ id: 5 }), "not json", "", null, JSON.stringify([MSG_ID]),
      JSON.stringify({ id: MSG_ID, pad: "x".repeat(MAX_RESPONSE_BYTES) })];
    for (const b of bodies) {
      state.rpc.mockReset(); db();
      reply(b, 200);
      expect(await run()).toEqual({ error: MESSAGES.unknown });
      expect(await outcome()).toMatchObject({ p_outcome: "unknown", p_provider_message_id: null });
    }
  });

  it("4xx: rejected; 5xx and other statuses: unknown; the body is never read into the result", async () => {
    for (const [status, o] of [[409, "unknown"], [400, "rejected"], [401, "rejected"], [403, "rejected"], [422, "rejected"], [429, "rejected"],
      [500, "unknown"], [502, "unknown"], [503, "unknown"]] as const) {
      state.rpc.mockReset(); db();
      reply(JSON.stringify({ id: MSG_ID, message: "MARKER_PROVIDER" }), status);
      const out = await run();
      expect(await outcome(), String(status)).toMatchObject({ p_outcome: o, p_provider_message_id: null });
      expect(out).toEqual({ error: MESSAGES[o] });
    }
  });

  it("timeout, network error and a refused redirect: unknown, never leaking the error", async () => {
    for (const err of [new DOMException("MARKER timeout", "TimeoutError"), new TypeError("fetch failed MARKER"),
      new TypeError("unexpected redirect MARKER")]) {
      state.rpc.mockReset(); db();
      state.fetch.mockRejectedValue(err);
      const out = await run();
      expect(await outcome()).toMatchObject({ p_outcome: "unknown", p_provider_message_id: null });
      expect(out).toEqual({ error: MESSAGES.unknown });
    }
  });

  it("a request that only ends when its signal aborts is reported unknown", async () => {
    db();
    state.fetch.mockImplementation((_: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    const real = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(5)); // the real timer, shortened
    expect(await run()).toEqual({ error: MESSAGES.unknown });
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("finish failure or any result other than recorded is reported as uncertain, never success", async () => {
    for (const finish of [{ data: null, error: { message: "mfa_required" } }, { data: null, error: { message: "MARKER" } },
      { data: "expired", error: null }, { data: "already_recorded", error: null }]) {
      state.rpc.mockReset(); state.fetch.mockReset();
      db(undefined, finish);
      reply(JSON.stringify({ id: MSG_ID }), 200);
      const out = await run();
      expect(out).toEqual({ error: MESSAGES.finishFailed });
      expect(out).not.toHaveProperty("ok");
    }
  });

  it("the key and response content never appear in what the action returns", async () => {
    for (const status of [200, 422, 500]) {
      state.rpc.mockReset(); db();
      reply(JSON.stringify({ id: MSG_ID, name: "MARKER_PROVIDER", key: KEY }), status);
      const out = JSON.stringify(await run());
      expect(out).not.toContain(KEY);
      expect(out).not.toContain("MARKER");
      expect(out).not.toContain(MSG_ID);
    }
  });
});

// ---------------------------------------------------------------------------
const OBS = "2026-10-13 12:00:00+00:00".replace(" ", "T");
const view = (o: Partial<VerificationsView> = {}): VerificationsView => ({
  observed_at: OBS, utc_day: "2026-10-13", daily_limit: 1, used_today: false, history: [], ...o });
const row = (o: Record<string, unknown> = {}) => ({ utc_day: "2026-10-12", status: "accepted", reported: true,
  requested_at: "2026-10-12T09:00:00+00:00", finished_at: "2026-10-12T09:00:01.5+00:00", provider_message_id: MSG_ID, ...o });

describe("read validation (fail closed)", () => {
  it("accepts well-formed history and rejects anything extra, inconsistent or out of order", () => {
    expect(validateVerifications(view())).not.toBeNull();
    expect(validateVerifications(view({ history: [row() as never] }))).not.toBeNull();
    expect(validateVerifications(view({ used_today: true, history: [row({ utc_day: "2026-10-13", status: "in_progress", reported: false, finished_at: null, provider_message_id: null }) as never] }))).not.toBeNull();
    const bad: unknown[] = [
      null, [], { ...view(), extra: 1 }, view({ daily_limit: 2 }), view({ used_today: true }),
      view({ history: [row({ status: "delivered" }) as never] }), view({ history: [row({ id: ID }) as never] }),
      view({ history: [row({ provider_message_id: null }) as never] }), view({ history: [row({ status: "rejected" }) as never] }),
      view({ history: [row({ reported: false }) as never] }), view({ history: [row({ utc_day: "2026-10-14" }) as never] }),
      view({ history: [row({ utc_day: "2026-10-10" }), row({ utc_day: "2026-10-11" })] as never }),
      view({ history: [row(), row()] as never }), view({ history: Array.from({ length: 15 }, (_, i) => row({ utc_day: `2026-09-${String(28 - i).padStart(2, "0")}` })) as never }),
      view({ observed_at: "2026-10-13T12:00:00Z" }),
    ];
    for (const b of bad) expect(validateVerifications(b), JSON.stringify(b)).toBeNull();
    expect(validateReservation(RESERVATION)).toEqual({ id: ID });
  });
});

describe("email verification section", () => {
  const html = (v: VerificationsView | null, configured = true) => renderToStaticMarkup(EmailVerification({ view: v, configured }));

  it("one form with only the confirmation tick and one button; fixed destination, sender and daily cap are visible", () => {
    const h = html(view());
    expect(h.match(/<form/g)).toHaveLength(1);
    expect(h.match(/<button/g)).toHaveLength(1);
    expect([...h.matchAll(/<input[^>]*>/g)].map((m) => m[0])).toEqual(['<input type="checkbox" required="" name="confirm"/>']);
    expect(h).not.toMatch(/<textarea|<select|type="email"|type="hidden"/);
    expect(h).toContain(VERIFICATION_TO);
    expect(h).toContain(VERIFICATION_FROM);
    expect(h).toContain("1 attempt per UTC day, no retries");
    expect(h).toContain("Send verification email");
    expect(h).toContain("Email key: present on this server");
    expect(h).toContain('class="check"'); // 44px label target from the global stylesheet
    expect(h).toContain("It is <strong>not</strong> alert delivery");
  });

  it("without a key there is no form and it says nothing can be sent; the key value is never rendered", () => {
    const h = html(view(), false);
    expect(h).toContain("Email key: not available on this deployment");
    expect(h).not.toMatch(/<form|<button|<input/);
    expect(h).not.toContain(KEY);
    expect(html(view(), true)).not.toContain(KEY);
  });

  it("when today is used there is no form; history labels are self-reported and never say delivered", () => {
    const h = html(view({ used_today: true, history: [
      row({ utc_day: "2026-10-13", status: "unknown", reported: false, finished_at: null, provider_message_id: null }), row(),
      row({ utc_day: "2026-10-11", status: "rejected", provider_message_id: null })] as never }));
    expect(h).not.toMatch(/<form|<button/);
    expect(h).toContain("has been used");
    for (const s of ["unknown", "accepted", "rejected"] as const) expect(h).toContain(STATUS_LABELS[s].replace(/'/g, "&#x27;"));
    expect(h).toContain("as reported by the admin session");
    expect(h).not.toMatch(/>\s*Delivered|status: delivered/i);
    expect(h).toContain(MSG_ID);
    expect(h).toContain('style="overflow-wrap:anywhere"');
  });

  it("an unreadable history offers no send at all", () => {
    const h = html(null);
    expect(h).toContain("Verification history could not be read");
    expect(h).not.toMatch(/<form|<button/);
  });

  it("the MFA hint links to the existing verification section on the platform page", () => {
    const src = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "..", "src", ...p), "utf8");
    expect(src("app", "platform", "alerts", "verification-form.tsx")).toContain('href="/platform#mfa"');
    expect(src("app", "platform", "page.tsx")).toMatch(/<section className="card stack" id="mfa">\s*<h2>Two-step verification required/);
    expect(src("app", "globals.css")).toMatch(/\.btn \{[^}]*min-height: 44px/);
    expect(src("app", "globals.css")).toMatch(/font-size: 16px/);
  });
});

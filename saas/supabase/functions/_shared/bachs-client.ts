// Sandbox-only Bachs adapter over an injected transport. Construction refuses any key that is not a
// sandbox key and any base URL other than the registry's sandbox URL. Path segments are validated and
// encoded. Results never carry response bodies into errors or logs: only status and error_code.
import {
  parseCheckout, parseCreateCheckoutResponse, parseCustomer, parseCustomerList, parseDispute, parseDisputeList, parseErrorCode,
  parseOrganization, parsePayment, parsePaymentList, parsePortalSession, parseProduct, parseRefund, parseSubscription, parseSubscriptionList,
} from "./bachs-dto.ts";

export const BACHS_SANDBOX_BASE_URL = "https://sandbox-api.bachs.io";
const SANDBOX_KEY = /^sk_sandbox_[A-Za-z0-9_-]{16,200}$/;

export interface TransportRequest { method: "GET" | "POST" | "DELETE"; url: string; headers: Record<string, string>; body?: string; timeoutMs: number }
export interface TransportResponse { status: number; bodyText: string }
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** ok: a 2xx body parsed by the official DTO parser. refused: definite 4xx (not retried blindly).
 *  uncertain: timeout, network failure, 5xx, 408, 409 IDEMPOTENCY_IN_PROGRESS -- a write may have happened. */
export type ProviderResult<T> =
  | { kind: "ok"; status: number; data: T }
  | { kind: "refused"; status: number; errorCode: string | null }
  | { kind: "uncertain"; reason: "timeout" | "network" | "server" | "in_progress" | "rate_limited"; status?: number };

export class ConfigError extends Error {}

const seg = (id: string, re = /^[A-Za-z0-9_]{1,128}$/) => {
  if (!re.test(id)) throw new ConfigError("invalid provider identifier");
  return encodeURIComponent(id);
};

export class BachsClient {
  private readonly key: string;
  private readonly base: string;
  constructor(cfg: { apiKey: string; baseUrl: string; keyPattern?: string | null }, private readonly transport: Transport,
    private readonly timeoutMs = 8000) {
    if (cfg.baseUrl !== BACHS_SANDBOX_BASE_URL) throw new ConfigError("only the Bachs sandbox base URL is allowed in this milestone");
    if (/^sk_live_/i.test(cfg.apiKey) || !SANDBOX_KEY.test(cfg.apiKey)) throw new ConfigError("only a Bachs sandbox key is allowed");
    if (cfg.keyPattern && !new RegExp(cfg.keyPattern).test(cfg.apiKey)) throw new ConfigError("key does not match the registry pattern");
    this.key = cfg.apiKey;
    this.base = cfg.baseUrl;
  }

  private async call<T>(method: TransportRequest["method"], path: string, parse: (x: unknown) => T,
    opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<ProviderResult<T>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}`, Accept: "application/json" };
    let body: string | undefined;
    if (opts.body !== undefined) { headers["Content-Type"] = "application/json"; body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body); }
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    let res: TransportResponse;
    try {
      res = await this.transport({ method, url: `${this.base}${path}`, headers, body, timeoutMs: this.timeoutMs });
    } catch (e) {
      return { kind: "uncertain", reason: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network" };
    }
    let json: unknown = null;
    try { json = res.bodyText ? JSON.parse(res.bodyText) : null; } catch { json = null; }
    if (res.status >= 200 && res.status < 300) return { kind: "ok", status: res.status, data: parse(json) };
    const code = parseErrorCode(json);
    if (res.status >= 500 || res.status === 408) return { kind: "uncertain", reason: "server", status: res.status };
    if (res.status === 409 && code === "IDEMPOTENCY_IN_PROGRESS") return { kind: "uncertain", reason: "in_progress", status: 409 };
    if (res.status === 429) return { kind: "uncertain", reason: "rate_limited", status: 429 };
    return { kind: "refused", status: res.status, errorCode: code };
  }

  getAccount() { return this.call("GET", "/v1/accounts/me", parseOrganization); }
  getProduct(id: string) { return this.call("GET", `/v1/products/${seg(id)}`, parseProduct); }
  getCheckout(id: string) { return this.call("GET", `/v1/checkout-sessions/${seg(id)}`, parseCheckout); }
  createCheckout(rawBody: string, idempotencyKey: string) {
    return this.call("POST", "/v1/checkout-sessions", parseCreateCheckoutResponse, { body: rawBody, idempotencyKey });
  }
  getPayment(id: string) { return this.call("GET", `/v1/payments/${seg(id)}`, parsePayment); }
  /** Newest first; the documented filters are limit, offset and status_filter only (no date filter). */
  listPayments(offset: number, limit = 100) {
    return this.call("GET", `/v1/payments?limit=${Math.min(100, Math.max(1, Math.trunc(limit)))}&offset=${Math.max(0, Math.trunc(offset))}`, parsePaymentList);
  }
  getSubscription(id: string) { return this.call("GET", `/v1/subscriptions/${seg(id)}`, parseSubscription); }
  listSubscriptions(customerId: string, offset: number) {
    return this.call("GET", `/v1/subscriptions?customer_id=${seg(customerId)}&limit=100&offset=${Math.max(0, Math.trunc(offset))}`, parseSubscriptionList);
  }
  /** Cancel at period end (DELETE is not covered by provider idempotency; reconcile on uncertainty). */
  cancelAtPeriodEnd(id: string) {
    return this.call("DELETE", `/v1/subscriptions/${seg(id)}`, parseSubscription, { body: { cancel_at_period_end: true, reason: "Owner requested in SAVOUR" } });
  }
  searchCustomers(email: string) {
    return this.call("GET", `/v1/customers?search=${encodeURIComponent(email)}&limit=100`, parseCustomerList);
  }
  createCustomer(body: { email: string; metadata: Record<string, string> }, idempotencyKey: string) {
    return this.call("POST", "/v1/customers", parseCustomer, { body, idempotencyKey });
  }
  createPortalSession(customerId: string) {
    return this.call("POST", `/v1/customers/${seg(customerId, /^cust_[A-Za-z0-9_]{1,120}$/)}/portal-sessions`, parsePortalSession);
  }
  getRefund(id: string) { return this.call("GET", `/v1/refunds/${seg(id)}`, parseRefund); }
  getDispute(id: string) { return this.call("GET", `/v1/disputes/${seg(id)}`, parseDispute); }
  listDisputes(fromIso: string, offset: number) {
    return this.call("GET", `/v1/disputes?from_date=${encodeURIComponent(fromIso)}&limit=100&offset=${Math.max(0, Math.trunc(offset))}`, parseDisputeList);
  }
}

/** Fetch-based transport with a hard timeout (Deno Edge and tests both provide fetch). */
export function fetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return async (req) => {
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "manual",
      signal: AbortSignal.timeout(req.timeoutMs) });
    return { status: res.status, bodyText: await res.text() };
  };
}

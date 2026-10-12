// Exact money for provider decimal strings. Bachs sends amounts as decimal strings at currency
// precision ("29.00"); SAVOUR stores integer minor units. No floats, no FX, never mixed currencies.
export const CURRENCY_EXPONENT = { NGN: 2, USD: 2 } as const;
export type Currency = keyof typeof CURRENCY_EXPONENT;

export class MoneyError extends Error {
  constructor(public readonly code: "invalid_amount" | "invalid_currency", detail: string) {
    super(`${code}: ${detail}`);
  }
}

export const isCurrency = (x: unknown): x is Currency => typeof x === "string" && Object.hasOwn(CURRENCY_EXPONENT, x);

const DECIMAL = /^(0|[1-9][0-9]{0,14})(?:\.([0-9]+))?$/;
const MAX_MINOR = 900_000_000_000_000n;

/** "29.00" USD -> 2900n. Rejects malformed, negative, exponent, leading-zero, out-of-scale and overflow. */
export function toMinor(amount: unknown, currency: unknown): bigint {
  if (!isCurrency(currency)) throw new MoneyError("invalid_currency", String(currency));
  if (typeof amount !== "string") throw new MoneyError("invalid_amount", "not a string");
  const m = DECIMAL.exec(amount);
  if (!m) throw new MoneyError("invalid_amount", "malformed decimal");
  const exp: number = CURRENCY_EXPONENT[currency];
  const frac = m[2] ?? "";
  if (frac.length > exp) throw new MoneyError("invalid_amount", "out of scale");
  const minor = BigInt(m[1]) * 10n ** BigInt(exp) + BigInt((frac + "0".repeat(exp)).slice(0, exp) || "0");
  if (minor > MAX_MINOR) throw new MoneyError("invalid_amount", "out of range");
  return minor;
}

/** 2900n USD -> "29.00" (the provider's decimal form). */
export function fromMinor(minor: bigint, currency: Currency): string {
  if (minor < 0n) throw new MoneyError("invalid_amount", "negative");
  const exp: number = CURRENCY_EXPONENT[currency];
  const s = minor.toString().padStart(exp + 1, "0");
  return exp === 0 ? s : `${s.slice(0, -exp)}.${s.slice(-exp)}`;
}

const SYMBOL: Record<Currency, string> = { NGN: "₦", USD: "US$" };

/** Display form with thousands separators, e.g. "₦25,000.00". Never converts between currencies. */
export function displayMoney(minor: bigint | number | string, currency: Currency): string {
  const v = typeof minor === "bigint" ? minor : BigInt(minor);
  const [whole, frac] = fromMinor(v, currency).split(".");
  return `${SYMBOL[currency]}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

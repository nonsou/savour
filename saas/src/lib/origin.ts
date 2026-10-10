// Pure origin resolution for copied invitation links. Precedence: configured SITE_URL, then the
// request host. Loopback hosts are always http (a local dev server has no TLS even if a proxy
// header is missing or wrong); other hosts use the forwarded protocol or https.
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

export function resolveOrigin(opts: { siteUrl?: string | null; host?: string | null; proto?: string | null }): string {
  if (opts.siteUrl) return opts.siteUrl.replace(/\/+$/, "");
  const host = (opts.host ?? "localhost:3000").split(",")[0].trim();
  const fwd = opts.proto?.split(",")[0].trim().toLowerCase();
  const proto = LOOPBACK.test(host) ? "http" : fwd === "http" || fwd === "https" ? fwd : "https";
  return `${proto}://${host}`;
}

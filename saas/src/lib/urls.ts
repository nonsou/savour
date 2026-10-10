import { headers } from "next/headers";
import { resolveOrigin } from "./origin";

export { safeNext } from "./safe-next";

// Origin used in copied invitation links. Set SITE_URL in deployed environments so links never
// depend on request headers; locally the request host is used.
export async function siteOrigin(): Promise<string> {
  const h = await headers();
  return resolveOrigin({
    siteUrl: process.env.SITE_URL, host: h.get("x-forwarded-host") ?? h.get("host"), proto: h.get("x-forwarded-proto"),
  });
}

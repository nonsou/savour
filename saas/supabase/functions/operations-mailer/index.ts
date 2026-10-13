// operations-mailer Edge Function (Deno runtime wiring only; excluded from the Node typecheck like the other entries).
// Deploy without JWT verification: the opaque trigger bearer checked in core.ts is the sole gate.
// Its own small database adapter connects as operations_mail and can call only the three fixed worker functions with
// bound parameters. It never reads the platform's auto-injected broad secrets; see core.ts for the request rules.
import postgres from "postgres";
import { handle, MAIL_ENV, type MailerDb, type Outcome } from "./core.ts";
import { SUPABASE_ROOT_2021_CA } from "./supabase-ca.ts";

let pool: ReturnType<typeof postgres> | null = null;

function mailDb(): MailerDb {
  const url = Deno.env.get(MAIL_ENV.databaseUrl) ?? "";
  const user = url ? new URL(url).username : "";
  if (user !== "operations_mail" && !user.startsWith("operations_mail.")) throw new Error("mail database not configured");
  // Strict TLS against the pooler: the chain must end at the bundled public Supabase Root 2021 CA (the pooler's chain is
  // not publicly rooted, so "verify-full" with system roots fails with SELF_SIGNED_CERT_IN_CHAIN), and the host name is
  // still checked: postgres@3.4.5 passes servername = the URL host to tls.connect, and the default identity check runs.
  // Never "require" (encrypt only), never rejectUnauthorized false, never a custom identity check.
  pool ??= postgres(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 5,
    ssl: { rejectUnauthorized: true, ca: SUPABASE_ROOT_2021_CA } });
  const sql = pool;
  return {
    async heartbeat(status: "ready" | "not_configured") {
      return (await sql`select operations.mailer_heartbeat(${status}::text) as r`)[0]?.r;
    },
    async claim() {
      return (await sql`select operations.mailer_claim() as r`)[0]?.r;
    },
    async finish(lease: string, outcome: Outcome, providerMessageId: string | null) {
      return (await sql`select operations.mailer_finish(${lease}::uuid, ${outcome}::text, ${providerMessageId}::uuid) as r`)[0]?.r;
    },
  };
}

Deno.serve((req) => handle(req, { env: (name) => Deno.env.get(name), db: mailDb, fetch: globalThis.fetch.bind(globalThis) }));

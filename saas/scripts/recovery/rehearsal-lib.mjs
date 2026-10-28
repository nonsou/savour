// LOCAL_NATIVE_LOGICAL_REHEARSAL_ONLY helpers. Pure functions (no processes, no files) so the guards are unit
// testable. Nothing here accepts a connection URL, host, database name, credential or backup path.
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

export const LABEL = "LOCAL_NATIVE_LOGICAL_REHEARSAL_ONLY";
export const REQUIRED_BINARIES = ["initdb", "pg_ctl", "postgres", "psql", "pg_dump", "pg_restore"];
export const SUPERUSER = "savour_rehearsal";
export const PORT = "5432"; // only names the socket file inside the private socket dir; no TCP listener
export const WORKDIR_PREFIX = "savour-rr-";
export const DATABASES = Object.freeze({ source: "rr_source", restore: "rr_restore", recovered: "rr_recovered", negative: "rr_negative" });
export const NEGATIVE_MARKER = "LOCAL_NEGATIVE_CONTROL_LATE_RESTORE_ERROR";
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;

/** Accepts exactly `--pg-bin <absolute dir>` and optional `--keep-artifacts`. Everything else is refused. */
export function parseArgs(argv) {
  let pgBin = null;
  let keepArtifacts = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pg-bin" && pgBin === null && i + 1 < argv.length) pgBin = argv[++i];
    else if (a === "--keep-artifacts" && !keepArtifacts) keepArtifacts = true;
    else throw new Error(`refused argument: only --pg-bin <dir> and --keep-artifacts are accepted`);
  }
  if (pgBin === null) throw new Error("--pg-bin <absolute PostgreSQL 17 bin dir> is required");
  assertSafePath(pgBin, "--pg-bin");
  return { pgBin: normalize(pgBin), keepArtifacts };
}

export function assertSafePath(p, what) {
  if (typeof p !== "string" || !isAbsolute(p) || !SAFE_PATH.test(p) || p.split("/").includes("..")) {
    throw new Error(`${what} must be an absolute path of [A-Za-z0-9_./-] without '..'`);
  }
  if (/:\/\/|@|=/.test(p)) throw new Error(`${what} looks like a connection string`);
}

/** Copies the environment without any PG*, DATABASE_URL or SUPABASE* variable and pins a C locale. */
export function scrubEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^PG/i.test(k) || /^DATABASE_URL$/i.test(k) || /^SUPABASE/i.test(k)) continue;
    out[k] = v;
  }
  return { ...out, LC_ALL: "C", LANG: "C", TZ: "UTC" };
}

/** `<tool> (PostgreSQL) 17.x` for every binary, all on one identical minor version. */
export function checkVersions(outputs) {
  const versions = {};
  for (const b of REQUIRED_BINARIES) {
    const m = /\(PostgreSQL\) (\d+)\.(\d+)\b/.exec(outputs[b] ?? "");
    if (!m) throw new Error(`${b}: no PostgreSQL version reported`);
    if (m[1] !== "17") throw new Error(`${b}: PostgreSQL ${m[1]}.${m[2]} is not 17.x`);
    versions[b] = `${m[1]}.${m[2]}`;
  }
  if (new Set(Object.values(versions)).size !== 1) throw new Error(`mixed PostgreSQL versions: ${JSON.stringify(versions)}`);
  return versions;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function archiveFacts(buf) { return { sha256: sha256(buf), bytes: buf.length }; }

/** The pre-restore gate: an archive whose bytes differ from the manifest is never handed to pg_restore. */
export function verifyArchive(buf, facts) {
  const got = archiveFacts(buf);
  if (got.bytes !== facts.bytes || got.sha256 !== facts.sha256) {
    throw new Error(`archive rejected before restore: expected ${facts.bytes} bytes/${facts.sha256}, got ${got.bytes}/${got.sha256}`);
  }
  return true;
}

export function byteFlipped(buf) { const c = Buffer.from(buf); c[Math.floor(c.length / 2)] ^= 0xff; return c; }
export function truncated(buf) { return Buffer.from(buf.subarray(0, Math.floor(buf.length / 2))); }

// Session settings so every row/catalog text rendering is deterministic across databases.
export const SESSION_PREAMBLE = "set client_min_messages = warning; set search_path = ''; set timezone = 'UTC'; " +
  "set datestyle = 'ISO, YMD'; set intervalstyle = 'postgres'; set extra_float_digits = 1; set bytea_output = 'hex';\n";
const APP_NS = "n.nspname <> 'information_schema' and n.nspname !~ '^pg_'";
const h = (expr) => `encode(sha256(convert_to(coalesce(string_agg(${expr}, E'\\n' order by ${expr} collate "C"), ''), 'UTF8')), 'hex')`;

export const TABLE_LIST_SQL = `${SESSION_PREAMBLE}select coalesce(json_agg(format('%I.%I', n.nspname, c.relname) order by 1), '[]')
from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and ${APP_NS};`;

const QUALIFIED = /^("[^"\0]+"|[a-z_][a-z0-9_$]*)\.("[^"\0]+"|[a-z_][a-z0-9_$]*)$/;
/** Per-table row count and SHA-256 over rows ordered by their text form. Names come server-quoted from our own catalog. */
export function tableHashSql(tables) {
  if (!tables.length) return `${SESSION_PREAMBLE}select '{}'::json;`;
  const parts = tables.map((t) => {
    if (!QUALIFIED.test(t)) throw new Error(`unexpected table identifier ${JSON.stringify(t)}`);
    return `select ${pgLiteral(t)} as t, count(*) as n, ${h("x::text")} as h from ${t} x`;
  });
  return `${SESSION_PREAMBLE}select json_object_agg(t, json_build_object('rows', n, 'sha256', h)) from (\n${parts.join("\nunion all\n")}\n) s;`;
}
const pgLiteral = (s) => `'${s.replace(/'/g, "''")}'`;

// Catalog coverage inventory (each section -> count + sha256). Replaces textual pg_dump comparison, whose
// \restrict nonces and comments are not deterministic.
export const CATALOG_SECTIONS = {
  schemas: `select n.nspname || ':' || pg_get_userbyid(n.nspowner) || ':' || (select array_agg(a::text order by a::text)::text from unnest(coalesce(n.nspacl, acldefault('n', n.nspowner))) a) as x from pg_namespace n where ${APP_NS}`,
  relations: `select n.nspname || '.' || c.relname || ':' || c.relkind::text ||':' || pg_get_userbyid(c.relowner) || ':rls=' || c.relrowsecurity || ':force=' || c.relforcerowsecurity || ':' || (select array_agg(a::text order by a::text)::text from unnest(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::\"char\" else 'r'::\"char\" end, c.relowner))) a) as x
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') and ${APP_NS}`,
  views: `select c.oid::regclass::text || ':' || pg_get_viewdef(c.oid, true) as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('v', 'm') and ${APP_NS}`,
  columns: `select c.oid::regclass::text || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || coalesce((select array_agg(v::text order by v::text)::text from unnest(a.attacl) v), '') as x
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm') and ${APP_NS}`,
  constraints: `select n.nspname || ':' || coalesce(t.oid::regclass::text, '') || ':' || o.conname || ':' || pg_get_constraintdef(o.oid, true) as x
    from pg_constraint o join pg_namespace n on n.oid = o.connamespace left join pg_class t on t.oid = o.conrelid where ${APP_NS}`,
  indexes: `select pg_get_indexdef(i.indexrelid) as x from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace where ${APP_NS}`,
  policies: `select p.schemaname || '.' || p.tablename || ':' || p.policyname || ':' || p.permissive || ':' || (select array_agg(v order by v)::text from unnest(p.roles) v) || ':' || p.cmd || ':' || coalesce(p.qual, '') || ':' || coalesce(p.with_check, '') as x from pg_policies p`,
  triggers: `select t.tgrelid::regclass::text || ':' || t.tgname || ':' || t.tgenabled::text ||':' || pg_get_triggerdef(t.oid) as x from pg_trigger t where not t.tgisinternal`,
  functions: `select p.oid::regprocedure::text || ':' || pg_get_userbyid(p.proowner) || ':secdef=' || p.prosecdef || ':' || coalesce(p.proconfig::text, '') || ':' || (select array_agg(v::text order by v::text)::text from unnest(coalesce(p.proacl, acldefault('f', p.proowner))) v) || ':' || md5(coalesce(p.prosrc, '')) as x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${APP_NS}`,
  types: `select t.oid::regtype::text || ':' || t.typtype::text ||':' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '') as x
    from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype in ('e', 'd', 'c') and ${APP_NS} and (t.typrelid = 0 or (select relkind from pg_class where oid = t.typrelid) = 'c')`,
  default_acls: `select pg_get_userbyid(d.defaclrole) || ':' || coalesce(d.defaclnamespace::regnamespace::text, '') || ':' || d.defaclobjtype::text ||':' || coalesce((select array_agg(v::text order by v::text)::text from unnest(d.defaclacl) v), '') as x from pg_default_acl d`,
  event_triggers: `select e.evtname || ':' || e.evtevent || ':' || e.evtenabled::text as x from pg_event_trigger e`,
};
export const CATALOG_SQL = `${SESSION_PREAMBLE}select json_build_object(${Object.entries(CATALOG_SECTIONS)
  .map(([k, q]) => `'${k}', (select json_build_object('count', count(*), 'sha256', ${h("s.x")}) from (${q}) s)`).join(",\n  ")});`;

export const SEQUENCE_SQL = `${SESSION_PREAMBLE}select coalesce(json_object_agg(format('%I.%I', schemaname, sequencename), json_build_object('last_value', last_value)), '{}')
from pg_sequences where schemaname <> 'information_schema' and schemaname !~ '^pg_';`;

export const SEQUENCE_LIST_SQL = `${SESSION_PREAMBLE}select coalesce(json_agg(format('%I.%I', schemaname, sequencename) order by schemaname, sequencename), '[]') from pg_sequences where schemaname <> 'information_schema' and schemaname !~ '^pg_';`;
export function sequenceStateSql(names) {
  if (!names.length) return `${SESSION_PREAMBLE}select '{}'::json;`;
  const parts = names.map((n) => {
    if (!QUALIFIED.test(n)) throw new Error("unexpected sequence identifier");
    return `select ${pgLiteral(n)} as name, last_value, is_called from ${n}`;
  });
  return `${SESSION_PREAMBLE}select json_object_agg(name, json_build_object('last_value', last_value, 'is_called', is_called)) from (${parts.join(" union all ")}) s;`;
}

/** Returns the dotted paths at which two manifests differ (empty = equal). */
export function diffManifest(a, b, path = "") {
  if (a === b) return [];
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return [path || "<root>"];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((k) => diffManifest(a[k], b[k], path ? `${path}.${k}` : k));
}

/** pg_restore --list order: every TRIGGER entry comes after the last TABLE DATA entry (proves the negative error is late). */
export function triggersAfterData(list) {
  const lines = list.split("\n").filter((l) => /^\d+;/.test(l));
  const lastData = lines.findLastIndex((l) => / TABLE DATA /.test(l));
  const firstTrigger = lines.findIndex((l) => / TRIGGER /.test(l));
  return lastData >= 0 && firstTrigger > lastData;
}

const FORBIDDEN_IN_REPORT = [/postgres(ql)?:\/\//i, /password/i, /\bhost=/i, /PGPASSWORD/, /sk_(live|sandbox)_/, /whsec_/, /\.s\.PGSQL/];
/** Replaces private paths and refuses to emit anything that looks like a connection credential or secret. */
export function sanitizeReport(report, privatePaths) {
  let text = JSON.stringify(report, null, 2);
  for (const p of privatePaths.filter(Boolean).sort((x, y) => y.length - x.length)) text = text.split(p).join("<private>");
  text = text.replace(/\.s\.PGSQL\.\d+/g, "<socket>");
  for (const re of FORBIDDEN_IN_REPORT) if (re.test(text)) throw new Error(`report refused: matches ${re}`);
  return text;
}

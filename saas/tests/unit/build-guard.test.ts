import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { afterEach, describe, expect, it, vi } from "vitest";

// Runs a command with ONLY the given Vercel variables (inherited ones are stripped), so the
// result does not depend on the machine running the tests.
function run(cmd: string, args: string[], vars: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("VERCEL")) env[k] = v;
  }
  return spawnSync(cmd, args, { env: { ...env, ...vars } as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
}
const guard = (vars: Record<string, string>) => run(process.execPath, ["scripts/build-guard.mjs"], vars);

describe("build guard process (fail closed)", () => {
  it.each([
    ["local, no Vercel variables", {}],
    ["Vercel Preview", { VERCEL: "1", VERCEL_ENV: "preview" }],
    ["Vercel Preview with preview target", { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" }],
    ["local vercel dev", { VERCEL_ENV: "development" }],
  ])("allows %s", (_name, vars) => {
    const r = guard(vars);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("[build-guard] OK");
  });

  it.each([
    ["Vercel Production", { VERCEL: "1", VERCEL_ENV: "production" }],
    ["local `vercel build --prod`", { VERCEL_ENV: "production" }],
    ["production with odd casing/space", { VERCEL: "1", VERCEL_ENV: " Production " }],
    ["production custom target", { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "production" }],
    ["Vercel with missing environment", { VERCEL: "1" }],
    ["Vercel development", { VERCEL: "1", VERCEL_ENV: "development" }],
    ["unrecognised environment", { VERCEL_ENV: "staging" }],
    ["unrecognised custom target", { VERCEL_TARGET_ENV: "staging" }],
  ])("refuses %s with a non-zero exit", (_name, vars) => {
    const r = guard(vars);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[build-guard\] Refusing/);
  });

  it("`npm run build` stops at the guard for production before Next.js starts", () => {
    const r = run("npm", ["run", "build"], { VERCEL: "1", VERCEL_ENV: "production" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Refusing to build SAVOUR SaaS for Vercel Production");
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Creating an optimized production build|Compiled/);
  });

  it("the npm build script runs the guard before next build", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.build).toBe("node scripts/build-guard.mjs && next build");
  });
});

describe("next.config second layer", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws during a production build phase for Vercel Production", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    const { default: config } = await import("../../next.config");
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow(/build-guard.*Production/);
    expect(() => config(PHASE_DEVELOPMENT_SERVER)).not.toThrow();
  });

  it("returns the config for a Preview build", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { default: config } = await import("../../next.config");
    expect(config(PHASE_PRODUCTION_BUILD).poweredByHeader).toBe(false);
  });
});

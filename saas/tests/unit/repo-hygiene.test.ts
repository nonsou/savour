import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ignored = (path: string) => {
  try { execFileSync("git", ["check-ignore", "-q", path]); return true; } catch { return false; }
};

describe("repository hygiene", () => {
  it.each([".env", ".env.local", ".env.production", ".env.development.local", ".env.vercel",
    "node_modules/pkg/index.js", ".next/server/app.js", ".vercel/project.json", "supabase/.temp/project-ref"])(
    "git ignores %s", (p) => expect(ignored(p)).toBe(true));

  it("tracks only the placeholder env example, which holds no real keys", () => {
    expect(ignored(".env.example")).toBe(false);
    const example = readFileSync(".env.example", "utf8");
    expect(example).not.toMatch(/sb_secret|service_role|eyJ[A-Za-z0-9_-]{20,}/);
  });

  it("app code never references a service-role or secret key", () => {
    const files = execFileSync("git", ["ls-files", "--others", "--cached", "--exclude-standard", "src"]).toString().trim().split("\n");
    for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/SERVICE_ROLE|service_role|SECRET_KEY|sb_secret/);
    }
  });
});

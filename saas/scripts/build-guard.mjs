#!/usr/bin/env node
// Fail-closed build guard: the SaaS must not be built for Vercel Production until the owner
// separately approves a production release. Allowed: local builds (no Vercel variables) and
// Vercel Preview. Refused: VERCEL_ENV/VERCEL_TARGET_ENV "production", and any Vercel build whose
// environment is missing or unrecognised (fail closed rather than guess).
// Used by `npm run build` (before next build) and by next.config.ts during the build phase.
import { fileURLToPath } from "node:url";

const LOCAL_OK = new Set(["", "development", "preview"]);

export function buildTargetError(env = process.env) {
  const target = (env.VERCEL_ENV ?? "").trim().toLowerCase();
  const custom = (env.VERCEL_TARGET_ENV ?? "").trim().toLowerCase();
  const onVercel = (env.VERCEL ?? "").trim() !== "";
  if (target === "production" || custom === "production") {
    return "Refusing to build SAVOUR SaaS for Vercel Production: production release is not approved.";
  }
  if (onVercel && target !== "preview") {
    return `Refusing to build on Vercel with VERCEL_ENV="${target || "(missing)"}": only Preview builds are allowed.`;
  }
  if (custom && custom !== "preview") {
    return `Refusing to build for VERCEL_TARGET_ENV="${custom}": only Preview builds are allowed.`;
  }
  if (!LOCAL_OK.has(target)) {
    return `Refusing to build with unrecognised VERCEL_ENV="${target}".`;
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const error = buildTargetError();
  if (error) {
    console.error(`[build-guard] ${error}`);
    process.exit(1);
  }
  console.log(`[build-guard] OK: ${process.env.VERCEL_ENV ? `Vercel ${process.env.VERCEL_ENV}` : "local"} build allowed.`);
}

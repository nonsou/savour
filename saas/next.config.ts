import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { buildTargetError } from "./scripts/build-guard.mjs";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Lets a verification build run beside a dev server without sharing .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The PDF export reads the embedded Unicode font from disk at runtime.
  outputFileTracingIncludes: {
    "/w/[ws]/sessions/[id]/report/export": ["./src/assets/fonts/**"],
    "/w/[ws]/analytics/export": ["./src/assets/fonts/**"],
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

// Second layer of the production guard: also refuses a direct `next build` (e.g. an overridden
// Vercel Build Command) that skips `npm run build`.
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const error = buildTargetError(process.env);
    if (error) throw new Error(`[build-guard] ${error}`);
  }
  return nextConfig;
}

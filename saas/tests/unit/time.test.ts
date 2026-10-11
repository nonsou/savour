import { describe, expect, it } from "vitest";
import { formatDateTime, formatLocalDate } from "@/lib/report";

// Collection windows are UTC instants plus whole hours (computed by the database from now()),
// never wall-clock local times, so daylight-saving gaps and repeats cannot create invalid or
// ambiguous windows. Display converts each instant with the workspace's IANA timezone.
describe("window display across daylight-saving changes", () => {
  it("spring-forward gap: a 2-hour window shows the shifted wall clock, not a nonexistent time", () => {
    const opens = "2026-03-29T00:30:00Z";
    const closes = new Date(Date.parse(opens) + 2 * 3600_000).toISOString();
    expect(formatDateTime(opens, "Europe/London")).toBe("29 Mar 2026, 00:30 (Europe/London)");
    expect(formatDateTime(closes, "Europe/London")).toBe("29 Mar 2026, 03:30 (Europe/London)");
  });

  it("fall-back repeat: two different instants with the same wall clock stay distinct in UTC", () => {
    const first = "2026-10-25T00:30:00Z";
    const second = "2026-10-25T01:30:00Z";
    expect(formatDateTime(first, "Europe/London")).toBe("25 Oct 2026, 01:30 (Europe/London)");
    expect(formatDateTime(second, "Europe/London")).toBe("25 Oct 2026, 01:30 (Europe/London)");
    expect(Date.parse(second) - Date.parse(first)).toBe(3600_000);
  });

  it("calendar session dates never shift with the timezone", () => {
    expect(formatLocalDate("2026-03-29")).toBe("29 Mar 2026");
  });
});

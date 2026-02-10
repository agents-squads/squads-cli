/**
 * Tests for cron evaluator utilities
 */

import {
  cronMatches,
  getNextCronRun,
  parseCooldown,
  fieldMatches,
} from "../src/lib/cron.js";

describe("cronMatches", () => {
  it("should match simple hourly pattern", () => {
    const date = new Date("2026-02-10T08:00:00");
    expect(cronMatches("0 8 * * *", date)).toBe(true);
  });

  it("should not match wrong hour", () => {
    const date = new Date("2026-02-10T09:00:00");
    expect(cronMatches("0 8 * * *", date)).toBe(false);
  });

  it("should match every 5 minutes pattern", () => {
    expect(cronMatches("*/5 * * * *", new Date("2026-02-10T08:00:00"))).toBe(
      true
    );
    expect(cronMatches("*/5 * * * *", new Date("2026-02-10T08:05:00"))).toBe(
      true
    );
    expect(cronMatches("*/5 * * * *", new Date("2026-02-10T08:10:00"))).toBe(
      true
    );
    expect(cronMatches("*/5 * * * *", new Date("2026-02-10T08:15:00"))).toBe(
      true
    );
  });

  it("should not match non-step minutes", () => {
    expect(cronMatches("*/5 * * * *", new Date("2026-02-10T08:03:00"))).toBe(
      false
    );
    expect(cronMatches("*/5 * * * *", new Date("2026-02-10T08:07:00"))).toBe(
      false
    );
  });

  it("should match weekday pattern (Monday)", () => {
    const monday = new Date("2026-02-09T09:00:00"); // Monday is day 1
    expect(cronMatches("0 9 * * 1-5", monday)).toBe(true);
  });

  it("should not match weekend for weekday pattern", () => {
    const saturday = new Date("2026-02-14T09:00:00"); // Saturday is day 6
    const sunday = new Date("2026-02-15T09:00:00"); // Sunday is day 0
    expect(cronMatches("0 9 * * 1-5", saturday)).toBe(false);
    expect(cronMatches("0 9 * * 1-5", sunday)).toBe(false);
  });

  it("should match every 2 hours at :30", () => {
    expect(cronMatches("30 */2 * * *", new Date("2026-02-10T08:30:00"))).toBe(
      true
    );
    expect(cronMatches("30 */2 * * *", new Date("2026-02-10T10:30:00"))).toBe(
      true
    );
    expect(cronMatches("30 */2 * * *", new Date("2026-02-10T12:30:00"))).toBe(
      true
    );
  });

  it("should not match odd hours for every 2 hours", () => {
    expect(cronMatches("30 */2 * * *", new Date("2026-02-10T09:30:00"))).toBe(
      false
    );
    expect(cronMatches("30 */2 * * *", new Date("2026-02-10T11:30:00"))).toBe(
      false
    );
  });

  it("should match specific hours (list)", () => {
    expect(cronMatches("0 8,12,18 * * *", new Date("2026-02-10T08:00:00"))).toBe(
      true
    );
    expect(cronMatches("0 8,12,18 * * *", new Date("2026-02-10T12:00:00"))).toBe(
      true
    );
    expect(cronMatches("0 8,12,18 * * *", new Date("2026-02-10T18:00:00"))).toBe(
      true
    );
  });

  it("should not match hours not in list", () => {
    expect(cronMatches("0 8,12,18 * * *", new Date("2026-02-10T09:00:00"))).toBe(
      false
    );
    expect(cronMatches("0 8,12,18 * * *", new Date("2026-02-10T15:00:00"))).toBe(
      false
    );
  });

  it("should match first of month", () => {
    const date = new Date("2026-02-01T00:00:00");
    expect(cronMatches("0 0 1 * *", date)).toBe(true);
  });

  it("should not match second of month for first-only pattern", () => {
    const date = new Date("2026-02-02T00:00:00");
    expect(cronMatches("0 0 1 * *", date)).toBe(false);
  });

  it("should match edge case Dec 31 23:59", () => {
    const date = new Date("2026-12-31T23:59:00");
    expect(cronMatches("59 23 31 12 *", date)).toBe(true);
  });

  it("should return false for invalid cron", () => {
    const date = new Date("2026-02-10T08:00:00");
    expect(cronMatches("invalid", date)).toBe(false);
    expect(cronMatches("0 8", date)).toBe(false); // Too few parts
  });

  it("should return false for empty cron", () => {
    const date = new Date("2026-02-10T08:00:00");
    expect(cronMatches("", date)).toBe(false);
  });
});

describe("getNextCronRun", () => {
  it("should return next minute match, not current", () => {
    const current = new Date("2026-02-10T08:00:00");
    const next = getNextCronRun("0 8 * * *", current);

    // Should return tomorrow's 8:00, not today's (since we're AT 8:00)
    expect(next.getHours()).toBe(8);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(11); // Tomorrow
  });

  it("should return same day if before scheduled time", () => {
    const before = new Date("2026-02-10T07:59:00");
    const next = getNextCronRun("0 8 * * *", before);

    expect(next.getHours()).toBe(8);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(10); // Same day
  });

  it("should return next day if after scheduled time", () => {
    const after = new Date("2026-02-10T08:01:00");
    const next = getNextCronRun("0 8 * * *", after);

    expect(next.getHours()).toBe(8);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(11); // Next day
  });

  it("should return next interval for frequent pattern", () => {
    const after = new Date("2026-02-10T08:03:00");
    const next = getNextCronRun("*/5 * * * *", after);

    expect(next.getHours()).toBe(8);
    expect(next.getMinutes()).toBe(5); // Next 5-minute mark
  });

  it("should handle end of day rollover", () => {
    const late = new Date("2026-02-10T23:59:00");
    const next = getNextCronRun("0 0 * * *", late);

    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(11); // Next day
  });
});

describe("parseCooldown", () => {
  it("should parse minutes", () => {
    expect(parseCooldown("30m")).toBe(30 * 60 * 1000);
    expect(parseCooldown("5min")).toBe(5 * 60 * 1000);
    expect(parseCooldown("15 minutes")).toBe(15 * 60 * 1000);
  });

  it("should parse hours", () => {
    expect(parseCooldown("6 hours")).toBe(6 * 60 * 60 * 1000);
    expect(parseCooldown("2h")).toBe(2 * 60 * 60 * 1000);
    expect(parseCooldown("1 hour")).toBe(1 * 60 * 60 * 1000);
  });

  it("should parse days", () => {
    expect(parseCooldown("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseCooldown("1 day")).toBe(1 * 24 * 60 * 60 * 1000);
    expect(parseCooldown("3 days")).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("should return 0 for invalid input", () => {
    expect(parseCooldown("invalid")).toBe(0);
    expect(parseCooldown("")).toBe(0);
    expect(parseCooldown("abc123")).toBe(0);
  });

  it("should be case insensitive", () => {
    expect(parseCooldown("30M")).toBe(30 * 60 * 1000);
    expect(parseCooldown("2H")).toBe(2 * 60 * 60 * 1000);
    expect(parseCooldown("1D")).toBe(1 * 24 * 60 * 60 * 1000);
  });
});

describe("fieldMatches", () => {
  it("should match wildcard", () => {
    expect(fieldMatches("*", 5, 0, 59)).toBe(true);
    expect(fieldMatches("*", 0, 0, 59)).toBe(true);
    expect(fieldMatches("*", 59, 0, 59)).toBe(true);
  });

  it("should match exact value", () => {
    expect(fieldMatches("5", 5, 0, 59)).toBe(true);
    expect(fieldMatches("0", 0, 0, 59)).toBe(true);
  });

  it("should not match different value", () => {
    expect(fieldMatches("5", 6, 0, 59)).toBe(false);
    expect(fieldMatches("10", 5, 0, 59)).toBe(false);
  });

  it("should match range", () => {
    expect(fieldMatches("1-5", 1, 0, 59)).toBe(true);
    expect(fieldMatches("1-5", 3, 0, 59)).toBe(true);
    expect(fieldMatches("1-5", 5, 0, 59)).toBe(true);
  });

  it("should not match outside range", () => {
    expect(fieldMatches("1-5", 0, 0, 59)).toBe(false);
    expect(fieldMatches("1-5", 6, 0, 59)).toBe(false);
  });

  it("should match step values from min", () => {
    expect(fieldMatches("*/15", 0, 0, 59)).toBe(true);
    expect(fieldMatches("*/15", 15, 0, 59)).toBe(true);
    expect(fieldMatches("*/15", 30, 0, 59)).toBe(true);
    expect(fieldMatches("*/15", 45, 0, 59)).toBe(true);
  });

  it("should not match non-step values", () => {
    expect(fieldMatches("*/15", 7, 0, 59)).toBe(false);
    expect(fieldMatches("*/15", 20, 0, 59)).toBe(false);
  });

  it("should match list values", () => {
    expect(fieldMatches("1,3,5", 1, 0, 59)).toBe(true);
    expect(fieldMatches("1,3,5", 3, 0, 59)).toBe(true);
    expect(fieldMatches("1,3,5", 5, 0, 59)).toBe(true);
  });

  it("should not match values not in list", () => {
    expect(fieldMatches("1,3,5", 2, 0, 59)).toBe(false);
    expect(fieldMatches("1,3,5", 4, 0, 59)).toBe(false);
  });

  it("should handle range with step", () => {
    expect(fieldMatches("10-20/2", 10, 0, 59)).toBe(true);
    expect(fieldMatches("10-20/2", 12, 0, 59)).toBe(true);
    expect(fieldMatches("10-20/2", 14, 0, 59)).toBe(true);
    expect(fieldMatches("10-20/2", 16, 0, 59)).toBe(true);
    expect(fieldMatches("10-20/2", 18, 0, 59)).toBe(true);
    expect(fieldMatches("10-20/2", 20, 0, 59)).toBe(true);
  });

  it("should not match odd values in even step", () => {
    expect(fieldMatches("10-20/2", 11, 0, 59)).toBe(false);
    expect(fieldMatches("10-20/2", 13, 0, 59)).toBe(false);
  });
});

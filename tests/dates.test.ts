import { describe, expect, it } from "vitest";
import { parseDate } from "../src/lib/dates.js";

// Wednesday 2026-08-19 keeps weekday math honest.
const NOW = new Date(2026, 7, 19, 12, 0, 0);

describe("parseDate", () => {
  it("passes ISO dates and unknown input through", () => {
    expect(parseDate("2026-12-31", NOW)).toBe("2026-12-31");
    expect(parseDate("someday", NOW)).toBe("someday");
  });

  it("relative words", () => {
    expect(parseDate("today", NOW)).toBe("2026-08-19");
    expect(parseDate("Tomorrow", NOW)).toBe("2026-08-20");
    expect(parseDate("yesterday", NOW)).toBe("2026-08-18");
    expect(parseDate("next week", NOW)).toBe("2026-08-26");
    expect(parseDate("next month", NOW)).toBe("2026-09-19");
    expect(parseDate("eow", NOW)).toBe("2026-08-21");
    expect(parseDate("eom", NOW)).toBe("2026-08-31");
  });

  it("offsets", () => {
    expect(parseDate("+3", NOW)).toBe("2026-08-22");
    expect(parseDate("in 10 days", NOW)).toBe("2026-08-29");
    expect(parseDate("in 2 weeks", NOW)).toBe("2026-09-02");
  });

  it("weekdays: nearest future, and next = the one after", () => {
    expect(parseDate("friday", NOW)).toBe("2026-08-21");
    expect(parseDate("wednesday", NOW)).toBe("2026-08-26"); // never today
    expect(parseDate("mon", NOW)).toBe("2026-08-24");
    expect(parseDate("next friday", NOW)).toBe("2026-08-28");
  });
});

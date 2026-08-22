// Natural-language dates for --due/--start/--from/--to, matching
// common CLI date-parsing behavior: pure function, output always
// YYYY-MM-DD, unrecognized input passed through unchanged (the API
// validates). "monday" is the nearest future Monday; "next monday" is the
// one after that.

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function parseDate(input: string, now: Date = new Date()): string {
  const raw = input.trim().toLowerCase();
  if (!raw) return input;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (raw === "today") return ymd(now);
  if (raw === "tomorrow") return ymd(addDays(now, 1));
  if (raw === "yesterday") return ymd(addDays(now, -1));
  if (raw === "eow") {
    // End of week: the coming Friday (today if Friday).
    const delta = (5 - now.getDay() + 7) % 7;
    return ymd(addDays(now, delta));
  }
  if (raw === "eom") {
    return ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  }
  if (raw === "next week") return ymd(addDays(now, 7));
  if (raw === "next month") {
    return ymd(new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()));
  }
  const plus = raw.match(/^\+(\d{1,3})$/);
  if (plus) return ymd(addDays(now, Number(plus[1])));
  const inDays = raw.match(/^in (\d{1,3}) days?$/);
  if (inDays) return ymd(addDays(now, Number(inDays[1])));
  const inWeeks = raw.match(/^in (\d{1,2}) weeks?$/);
  if (inWeeks) return ymd(addDays(now, Number(inWeeks[1]) * 7));

  const nextDay = raw.match(/^next ([a-z]+)$/);
  if (nextDay && WEEKDAYS[nextDay[1]] !== undefined) {
    // "next monday" = the Monday after the nearest future one.
    const target = WEEKDAYS[nextDay[1]];
    const delta = ((target - now.getDay() + 7) % 7) || 7;
    return ymd(addDays(now, delta + 7));
  }
  if (WEEKDAYS[raw] !== undefined) {
    const delta = ((WEEKDAYS[raw] - now.getDay() + 7) % 7) || 7;
    return ymd(addDays(now, delta));
  }
  return input;
}

const DAY = 86_400_000;

const weekdayFmt = new Map<string, Intl.DateTimeFormat>();
const dateFmt = new Map<string, Intl.DateTimeFormat>();

function weekday(d: Date, tz: string): number {
  let f = weekdayFmt.get(tz);
  if (!f) weekdayFmt.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(f.format(d));
}

/** Calendar date in tz as YYYY-MM-DD. */
export function localDate(d: Date, tz: string): string {
  let f = dateFmt.get(tz);
  if (!f) dateFmt.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(d);
}

const isWeekend = (d: Date, tz: string) => {
  const w = weekday(d, tz);
  return w === 0 || w === 6;
};

/** Adds n weekdays (Mon–Fri in tz), keeping the time of day. */
export function addBusinessDays(from: Date, n: number, tz: string): Date {
  let d = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    d = new Date(d.getTime() + DAY);
    if (!isWeekend(d, tz)) left--;
  }
  return d;
}

/** Weekday dates after `from`'s date, up to and including `now`'s date (in tz). Fri → Mon = 1. */
export function businessDaysSince(from: Date, now: Date, tz: string): number {
  const end = localDate(now, tz);
  let d = new Date(from.getTime());
  let count = 0;
  for (let i = 0; i < 366 && localDate(d, tz) < end; i++) {
    d = new Date(d.getTime() + DAY);
    if (localDate(d, tz) > end) break;
    if (!isWeekend(d, tz)) count++;
  }
  return count;
}

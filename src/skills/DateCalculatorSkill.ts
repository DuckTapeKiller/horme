import { Skill, SkillParameter } from "./types";
import { errorToMessage, getStringProp } from "../utils/TypeGuards";

export class DateCalculatorSkill implements Skill {
  id = "date_calc";
  name = "Date & Time Calculator";
  description =
    "Computes time differences between dates, verifies day-of-week for historical dates, checks chronological consistency, and shows the current time in any timezone or city. Pure computation — no internet required.";
  terminal = true;

  parameters: SkillParameter[] = [
    {
      name: "operation",
      type: "string",
      description:
        "One of: 'timezone' (current time in a city/timezone), 'difference' (time between two dates), 'day_of_week' (what day was a date), 'add' (add days/months/years to a date).",
      required: true,
    },
    {
      name: "date1",
      type: "string",
      description: "First date in YYYY-MM-DD format (e.g. '1969-07-20').",
      required: true,
    },
    {
      name: "date2",
      type: "string",
      description: "Second date in YYYY-MM-DD format. Required for 'difference' operation.",
      required: false,
    },
    {
      name: "amount",
      type: "string",
      description: "Amount to add, e.g. '30 days', '6 months', '2 years'. Required for 'add' operation.",
      required: false,
    },
    {
      name: "timezone",
      type: "string",
      description:
        "IANA timezone (e.g. 'Asia/Shanghai', 'America/New_York', 'Europe/London') or city name. Required for 'timezone' operation.",
      required: false,
    },
  ];

  instructions = `To use this skill, output exactly: <call:date_calc>{"operation": "difference", "date1": "1914-07-28", "date2": "1918-11-11"}</call>. Operations: "timezone" (current time in a city, e.g. {"operation": "timezone", "timezone": "Asia/Shanghai"}), "difference" (time between two dates), "day_of_week" (what day a date fell on), "add" (add time to a date, e.g. {"operation": "add", "date1": "2024-01-01", "amount": "90 days"}). Use "timezone" whenever the user asks what time it is somewhere. Use the others to verify historical claims about durations, dates, or chronological facts.`;

  async execute(params: unknown): Promise<string> {
    try {
      const operation = getStringProp(params, "operation");
      const date1 = getStringProp(params, "date1");
      const date2 = getStringProp(params, "date2");
      const amount = getStringProp(params, "amount");
      const timezone = getStringProp(params, "timezone");

      if (!operation) return `Invalid parameters for ${this.name}: expected {"operation": string, ...}.`;

      if (operation.toLowerCase() === "timezone") {
        return this.computeTimezone(timezone);
      }

      if (!date1) return `Invalid parameters for ${this.name}: "date1" is required for "${operation}".`;

      const d1 = this.parseDate(date1);
      if (!d1) return `Invalid date format: "${date1}". Use YYYY-MM-DD.`;

      switch (operation.toLowerCase()) {
        case "difference":
          return this.computeDifference(d1, date1, date2);
        case "day_of_week":
          return this.computeDayOfWeek(d1, date1);
        case "add":
          return this.computeAdd(d1, date1, amount);
        default:
          return `Unknown operation: "${operation}". Use "timezone", "difference", "day_of_week", or "add".`;
      }
    } catch (e: unknown) {
      console.error("Horme Date Calculator Error:", e);
      throw new Error(errorToMessage(e));
    }
  }

  private parseDate(dateStr: string): Date | null {
    // Support YYYY-MM-DD format
    const match = dateStr.match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return null;

    const year = parseInt(match[1]);
    const month = parseInt(match[2]) - 1; // JS months are 0-indexed
    const day = parseInt(match[3]);

    const date = new Date(year, month, day);
    // Handle years < 100 (Date constructor treats them as 1900+)
    if (year < 100) date.setFullYear(year);

    // Validate the date is real
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
      return null;
    }

    return date;
  }

  private computeDifference(d1: Date, date1Str: string, date2Str?: string): string {
    if (!date2Str) return `"date2" is required for the "difference" operation.`;

    const d2 = this.parseDate(date2Str);
    if (!d2) return `Invalid date format: "${date2Str}". Use YYYY-MM-DD.`;

    // Ensure d1 is earlier
    const [earlier, later, earlierStr, laterStr] =
      d1 <= d2 ? [d1, d2, date1Str, date2Str] : [d2, d1, date2Str, date1Str];

    // Whole days by calendar date (UTC), so daylight-saving changes and old
    // local time offsets cannot drop a day.
    const totalDays = Math.round(utcDayNumber(later) - utcDayNumber(earlier));

    // Whole months first (clamped to month ends: 31 Jan + 1 month = 28 Feb),
    // then the days left over. Borrowing the previous month's length instead
    // gave negative days, e.g. 31 Jan → 1 Mar.
    let totalMonths =
      (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
    if (utcDayNumber(addMonthsClamped(earlier, totalMonths)) > utcDayNumber(later)) totalMonths--;
    const anchor = addMonthsClamped(earlier, totalMonths);
    const days = Math.round(utcDayNumber(later) - utcDayNumber(anchor));
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;

    const dayName1 = this.getDayName(earlier);
    const dayName2 = this.getDayName(later);

    return (
      `## Date Difference\n\n` +
      `**From:** ${earlierStr} (${dayName1})\n` +
      `**To:** ${laterStr} (${dayName2})\n\n` +
      `**Exact duration:** ${years} year${years !== 1 ? "s" : ""}, ${months} month${months !== 1 ? "s" : ""}, ${days} day${days !== 1 ? "s" : ""}\n` +
      `**Total days:** ${totalDays.toLocaleString()}\n` +
      `**Approximate years:** ${(totalDays / 365.25).toFixed(2)}`
    );
  }

  private computeDayOfWeek(d1: Date, date1Str: string): string {
    const dayName = this.getDayName(d1);
    return `## Day of Week\n\n**${date1Str}** was a **${dayName}**.`;
  }

  private computeAdd(d1: Date, date1Str: string, amount?: string): string {
    if (!amount)
      return `"amount" is required for the "add" operation (e.g. "30 days", "6 months", "2 years").`;

    const match = amount.match(/^(\d+)\s*(day|days|month|months|year|years)$/i);
    if (!match) return `Invalid amount format: "${amount}". Use e.g. "30 days", "6 months", "2 years".`;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    let result = new Date(d1);
    if (unit.startsWith("day")) {
      result.setDate(result.getDate() + value);
    } else if (unit.startsWith("month")) {
      // 31 Jan + 1 month is 28 (or 29) Feb, not 3 Mar.
      result = addMonthsClamped(d1, value);
    } else if (unit.startsWith("year")) {
      result = addMonthsClamped(d1, value * 12);
    }

    if (Number.isNaN(result.getTime()))
      return `"${date1Str}" + "${amount}" is outside the range of dates that can be calculated.`;

    const resultStr = `${String(result.getFullYear()).padStart(4, "0")}-${String(result.getMonth() + 1).padStart(2, "0")}-${String(result.getDate()).padStart(2, "0")}`;
    const dayName = this.getDayName(result);

    return `## Date Addition\n\n**${date1Str}** + **${amount}** = **${resultStr}** (${dayName})`;
  }

  private static readonly CITY_TO_TZ: Record<string, string> = {
    shanghai: "Asia/Shanghai",
    beijing: "Asia/Shanghai",
    tokyo: "Asia/Tokyo",
    seoul: "Asia/Seoul",
    sydney: "Australia/Sydney",
    melbourne: "Australia/Melbourne",
    london: "Europe/London",
    paris: "Europe/Paris",
    berlin: "Europe/Berlin",
    madrid: "Europe/Madrid",
    rome: "Europe/Rome",
    amsterdam: "Europe/Amsterdam",
    moscow: "Europe/Moscow",
    dubai: "Asia/Dubai",
    mumbai: "Asia/Kolkata",
    delhi: "Asia/Kolkata",
    kolkata: "Asia/Kolkata",
    singapore: "Asia/Singapore",
    "hong kong": "Asia/Hong_Kong",
    hongkong: "Asia/Hong_Kong",
    bangkok: "Asia/Bangkok",
    jakarta: "Asia/Jakarta",
    cairo: "Africa/Cairo",
    istanbul: "Europe/Istanbul",
    "new york": "America/New_York",
    nyc: "America/New_York",
    "los angeles": "America/Los_Angeles",
    la: "America/Los_Angeles",
    chicago: "America/Chicago",
    denver: "America/Denver",
    phoenix: "America/Phoenix",
    toronto: "America/Toronto",
    vancouver: "America/Vancouver",
    "mexico city": "America/Mexico_City",
    "sao paulo": "America/Sao_Paulo",
    "buenos aires": "America/Argentina/Buenos_Aires",
    lima: "America/Lima",
    bogota: "America/Bogota",
    santiago: "America/Santiago",
    honolulu: "Pacific/Honolulu",
    anchorage: "America/Anchorage",
    auckland: "Pacific/Auckland",
    taipei: "Asia/Taipei",
    manila: "Asia/Manila",
    hanoi: "Asia/Ho_Chi_Minh",
    "ho chi minh": "Asia/Ho_Chi_Minh",
    nairobi: "Africa/Nairobi",
    lagos: "Africa/Lagos",
    johannesburg: "Africa/Johannesburg",
    lisbon: "Europe/Lisbon",
    dublin: "Europe/Dublin",
    zurich: "Europe/Zurich",
    vienna: "Europe/Vienna",
    warsaw: "Europe/Warsaw",
    prague: "Europe/Prague",
    athens: "Europe/Athens",
    helsinki: "Europe/Helsinki",
    stockholm: "Europe/Stockholm",
    oslo: "Europe/Oslo",
    copenhagen: "Europe/Copenhagen",
  };

  private resolveTimezone(input: string): string | null {
    const lower = input.trim().toLowerCase();
    // Own keys only: "constructor" or "toString" must not read Object's methods.
    if (Object.prototype.hasOwnProperty.call(DateCalculatorSkill.CITY_TO_TZ, lower))
      return DateCalculatorSkill.CITY_TO_TZ[lower];
    const asIana = input.trim();
    try {
      Intl.DateTimeFormat(undefined, { timeZone: asIana });
      return asIana;
    } catch {
      return null;
    }
  }

  private computeTimezone(timezone?: string): string {
    if (!timezone)
      return `"timezone" is required for the "timezone" operation (e.g. "Asia/Shanghai" or "Tokyo").`;

    const tz = this.resolveTimezone(timezone);
    if (!tz)
      return `Unknown timezone or city: "${timezone}". Use an IANA timezone (e.g. "Asia/Shanghai") or a major city name.`;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "longOffset",
    });

    const parts = formatter.formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";

    const time = `${get("hour")}:${get("minute")}:${get("second")} ${get("dayPeriod")}`;
    const date = `${get("weekday")}, ${get("month")} ${get("day")}, ${get("year")}`;

    return (
      `## Current Time\n\n` +
      `**${timezone}** (${tz})\n` +
      `**Time:** ${time}\n` +
      `**Date:** ${date}\n` +
      `**Offset:** ${get("timeZoneName")}`
    );
  }

  private getDayName(date: Date): string {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return days[date.getDay()];
  }
}

/** Days since the epoch for a date's calendar day, ignoring time zones. */
function utcDayNumber(d: Date): number {
  const t = new Date(0);
  t.setUTCFullYear(d.getFullYear(), d.getMonth(), d.getDate());
  return t.getTime() / 86_400_000;
}

/** Adds whole months, keeping the day within the target month. */
function addMonthsClamped(d: Date, months: number): Date {
  const target = new Date(d.getTime());
  target.setDate(1);
  target.setMonth(d.getMonth() + months);
  // setMonth(next, 0) lands on the last day of the target month; new Date(y, m, 0)
  // would read years below 100 as 19xx.
  const end = new Date(target.getTime());
  end.setMonth(end.getMonth() + 1, 0);
  const lastDay = end.getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return target;
}

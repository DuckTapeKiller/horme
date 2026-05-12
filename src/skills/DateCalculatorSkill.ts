import { Skill, SkillParameter } from "./types";

export class DateCalculatorSkill implements Skill {
  id = "date_calc";
  name = "Date & Time Calculator";
  description = "Computes time differences between dates, verifies day-of-week for historical dates, and checks chronological consistency. Pure computation — no internet required.";
  terminal = true;
  
  parameters: SkillParameter[] = [
    {
      name: "operation",
      type: "string",
      description: "One of: 'difference' (time between two dates), 'day_of_week' (what day was a date), 'add' (add days/months/years to a date).",
      required: true
    },
    {
      name: "date1",
      type: "string",
      description: "First date in YYYY-MM-DD format (e.g. '1969-07-20').",
      required: true
    },
    {
      name: "date2",
      type: "string",
      description: "Second date in YYYY-MM-DD format. Required for 'difference' operation.",
      required: false
    },
    {
      name: "amount",
      type: "string",
      description: "Amount to add, e.g. '30 days', '6 months', '2 years'. Required for 'add' operation.",
      required: false
    }
  ];

  instructions = `To use this skill, output exactly: <call:date_calc>{"operation": "difference", "date1": "1914-07-28", "date2": "1918-11-11"}</call>. Operations: "difference" (time between two dates), "day_of_week" (what day a date fell on), "add" (add time to a date, e.g. {"operation": "add", "date1": "2024-01-01", "amount": "90 days"}). Use this to verify historical claims about durations, dates, or chronological facts.`;

  async execute(params: { operation: string; date1: string; date2?: string; amount?: string }): Promise<string> {
    try {
      const { operation, date1, date2, amount } = params;
      
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
          return `Unknown operation: "${operation}". Use "difference", "day_of_week", or "add".`;
      }
    } catch (e) {

      console.error("Horme Date Calculator Error:", e);
      throw e;
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
    const [earlier, later, earlierStr, laterStr] = d1 <= d2 
      ? [d1, d2, date1Str, date2Str] 
      : [d2, d1, date2Str, date1Str];

    // Compute exact difference
    const totalMs = later.getTime() - earlier.getTime();
    const totalDays = Math.floor(totalMs / (1000 * 60 * 60 * 24));

    // Compute years, months, days
    let years = later.getFullYear() - earlier.getFullYear();
    let months = later.getMonth() - earlier.getMonth();
    let days = later.getDate() - earlier.getDate();

    if (days < 0) {
      months--;
      // Get days in the previous month
      const prevMonth = new Date(later.getFullYear(), later.getMonth(), 0);
      days += prevMonth.getDate();
    }
    if (months < 0) {
      years--;
      months += 12;
    }

    const dayName1 = this.getDayName(earlier);
    const dayName2 = this.getDayName(later);

    return `## Date Difference\n\n`
      + `**From:** ${earlierStr} (${dayName1})\n`
      + `**To:** ${laterStr} (${dayName2})\n\n`
      + `**Exact duration:** ${years} year${years !== 1 ? 's' : ''}, ${months} month${months !== 1 ? 's' : ''}, ${days} day${days !== 1 ? 's' : ''}\n`
      + `**Total days:** ${totalDays.toLocaleString()}\n`
      + `**Approximate years:** ${(totalDays / 365.25).toFixed(2)}`;
  }

  private computeDayOfWeek(d1: Date, date1Str: string): string {
    const dayName = this.getDayName(d1);
    return `## Day of Week\n\n**${date1Str}** was a **${dayName}**.`;
  }

  private computeAdd(d1: Date, date1Str: string, amount?: string): string {
    if (!amount) return `"amount" is required for the "add" operation (e.g. "30 days", "6 months", "2 years").`;

    const match = amount.match(/^(\d+)\s*(day|days|month|months|year|years)$/i);
    if (!match) return `Invalid amount format: "${amount}". Use e.g. "30 days", "6 months", "2 years".`;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    const result = new Date(d1);
    if (unit.startsWith("day")) {
      result.setDate(result.getDate() + value);
    } else if (unit.startsWith("month")) {
      result.setMonth(result.getMonth() + value);
    } else if (unit.startsWith("year")) {
      result.setFullYear(result.getFullYear() + value);
    }

    const resultStr = `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, '0')}-${String(result.getDate()).padStart(2, '0')}`;
    const dayName = this.getDayName(result);

    return `## Date Addition\n\n**${date1Str}** + **${amount}** = **${resultStr}** (${dayName})`;
  }

  private getDayName(date: Date): string {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return days[date.getDay()];
  }
}

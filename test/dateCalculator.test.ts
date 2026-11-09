import { test } from "node:test";
import assert from "node:assert/strict";
import { DateCalculatorSkill } from "../src/skills/DateCalculatorSkill";

const skill = new DateCalculatorSkill();
const run = (params: Record<string, string>) => skill.execute(params);

void test("difference borrows months without negative days", async () => {
  const out = await run({ operation: "difference", date1: "2023-01-31", date2: "2023-03-01" });
  assert.match(out, /0 years, 1 month, 1 day\b/);
  assert.match(out, /\*\*Total days:\*\* 29/);
});

void test("difference across a daylight-saving change counts whole days", async () => {
  const out = await run({ operation: "difference", date1: "2024-03-30", date2: "2024-04-01" });
  assert.match(out, /\*\*Total days:\*\* 2\b/);
});

void test("difference of the First World War", async () => {
  const out = await run({ operation: "difference", date1: "1914-07-28", date2: "1918-11-11" });
  assert.match(out, /4 years, 3 months, 14 days/);
  assert.match(out, /\*\*Total days:\*\* 1,567/);
});

void test("add months clamps to the end of the month", async () => {
  const out = await run({ operation: "add", date1: "2023-01-31", amount: "1 month" });
  assert.match(out, /= \*\*2023-02-28\*\*/);
  const leap = await run({ operation: "add", date1: "2024-02-29", amount: "1 year" });
  assert.match(leap, /= \*\*2025-02-28\*\*/);
});

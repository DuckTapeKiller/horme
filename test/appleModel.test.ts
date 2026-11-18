import { test } from "node:test";
import assert from "node:assert";
import { fmTermsAccepted } from "../src/services/AppleModelServer";

void test("Apple's terms: accepted and not accepted, as fm itself words them", () => {
  // Both texts as fm printed them on this Mac, before and after `sudo fm license`.
  assert.strictEqual(fmTermsAccepted("Agreed to license FM1 version 1.1 on 18 nov 2026, 11:00."), true);
  assert.strictEqual(
    fmTermsAccepted(
      "YOU HAVE NOT AGREED TO THE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS.\nAgreeing to the Foundation Models CLI Legal Notice & Terms applies to every user on the machine, so it must be run as a privileged user (e.g. 'sudo fm license').",
    ),
    false,
  );
  assert.strictEqual(fmTermsAccepted(""), false);
});

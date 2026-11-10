import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicHttpUrl } from "../src/utils/urlSafety";

void test("public web addresses are allowed", () => {
  assert.equal(isPublicHttpUrl("https://en.wikipedia.org/wiki/Horme"), true);
  assert.equal(isPublicHttpUrl("http://93.184.216.34/page"), true);
});

void test("local and private addresses are refused", () => {
  for (const u of [
    "http://localhost:27123/vault/",
    "http://127.0.0.1:8130/v1/models",
    "http://192.168.1.1/",
    "http://10.0.0.5/",
    "http://172.20.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]:8080/",
    "http://router/",
    "http://printer.local/",
    "file:///etc/passwd",
    "http://localhost./",
    "http://LOCALHOST.:8130/health",
    "http://printer.local./",
    "http://[::ffff:127.0.0.1]/",
    "http://[::127.0.0.1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    "http://198.18.0.1/",
  ]) {
    assert.equal(isPublicHttpUrl(u), false, u);
  }
});

void test("public addresses written inside IPv6 are allowed", () => {
  assert.equal(isPublicHttpUrl("http://[::ffff:93.184.216.34]/"), true);
  assert.equal(isPublicHttpUrl("https://example.com./"), true);
});

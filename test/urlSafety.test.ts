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
  ]) {
    assert.equal(isPublicHttpUrl(u), false, u);
  }
});

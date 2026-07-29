import assert from "node:assert/strict";
import test from "node:test";
import { kasDecimalToSompi, outpointMatches } from "../lib/vault-values.js";
import { parseVaultPayload } from "../lib/vault-index.js";
import { enforceSameOrigin, readJsonBody } from "../lib/api-security.js";

test("KAS decimal conversion is exact at eight decimals and above Number.MAX_SAFE_INTEGER", () => {
  assert.equal(kasDecimalToSompi("1.00000001"), 100_000_001n);
  assert.equal(kasDecimalToSompi("90071992.54740993"), 9_007_199_254_740_993n);
  assert.equal(kasDecimalToSompi("0.000000001"), 0n);
  assert.equal(kasDecimalToSompi("1e3"), 0n);
});

test("outpoint matching requires both the exact transaction id and index", () => {
  const outpoint = { transactionId: "abc", index: 2 };
  assert.equal(outpointMatches(outpoint, "abc", 2), true);
  assert.equal(outpointMatches(outpoint, "abc", 1), false);
  assert.equal(outpointMatches(outpoint, "def", 2), false);
  assert.equal(outpointMatches(outpoint, "", 2), false);
});

test("vault index parser rejects oversized or malformed metadata", () => {
  const valid = {
    p: "kaslab-time-lock-vault-v1",
    v: 2,
    action: "create",
    vaultAddress: "kaspa:vault",
    ownerAddress: "kaspa:owner",
    redeemScript: "aa",
  };
  assert.deepEqual(parseVaultPayload(valid), valid);
  assert.equal(parseVaultPayload({ ...valid, action: "unrelated" }), null);
  assert.equal(parseVaultPayload({ ...valid, redeemScript: "a".repeat(20_001) }), null);
});

test("relay origin guard rejects cross-site requests", () => {
  const request = new Request("https://vaults.kaslab.space/api/covenant-broadcast", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(enforceSameOrigin(request)?.status, 403);
});

test("JSON reader rejects bodies above the configured limit", async () => {
  const request = new Request("https://vaults.kaslab.space/api/test", {
    method: "POST",
    headers: { "content-length": "101" },
    body: "{}",
  });
  await assert.rejects(() => readJsonBody(request, 100), /too large/i);
});

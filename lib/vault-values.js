export const SOMPI_PER_KAS = 100_000_000n;

export function kasDecimalToSompi(value, fallback = 0n) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const match = raw.match(/^(\d+)(?:\.(\d{0,8}))?$/);
  if (!match) return 0n;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(8, "0"));
  return whole * SOMPI_PER_KAS + fraction;
}

export function outpointMatches(outpoint, transactionId, index) {
  if (!outpoint || !transactionId || index === null || index === undefined) return false;
  const actualTransactionId = outpoint.transactionId || outpoint.transaction_id || outpoint.txId;
  return String(actualTransactionId) === String(transactionId) && String(outpoint.index) === String(index);
}

import fs from "node:fs/promises";
import path from "node:path";

const VAULT_PROTOCOL = "kaslab-time-lock-vault-v1";
const VAULT_PAYLOAD_VERSION = 2;
const DEFAULT_INDEX_PATH = "/var/lib/kascoven-vaults/vault-index.json";
const MAX_INDEX_RECORDS = 100_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

let writeQueue = Promise.resolve();

function indexPath() {
  return process.env.VAULT_INDEX_PATH || DEFAULT_INDEX_PATH;
}

function recordKey(record) {
  return record?.deployTxId || `${record?.payload?.vaultAddress || ""}:${record?.payload?.action || ""}`;
}

function isVaultPayload(payload) {
  let payloadBytes = Infinity;
  try {
    payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {}
  return Boolean(
    payload &&
    payload.p === VAULT_PROTOCOL &&
    payload.v === VAULT_PAYLOAD_VERSION &&
    (payload.action === "create" || payload.action === "dms-create" || payload.action === "wizard-create") &&
    payload.vaultAddress?.startsWith("kaspa:") &&
    payload.ownerAddress?.startsWith("kaspa:") &&
    typeof payload.redeemScript === "string" &&
    payload.redeemScript.length <= 20_000 &&
    payloadBytes <= MAX_PAYLOAD_BYTES,
  );
}

export function parseVaultPayload(value) {
  try {
    let decoded = value;
    if (value instanceof Uint8Array) decoded = Buffer.from(value).toString("utf8");
    if (typeof decoded === "string" && /^[0-9a-f]+$/i.test(decoded) && decoded.length % 2 === 0) {
      decoded = Buffer.from(decoded, "hex").toString("utf8");
    }
    const payload = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
    return isVaultPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function readIndex() {
  try {
    const parsed = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ indexPath(), "utf8"));
    return parsed?.version === 1 && Array.isArray(parsed.records)
      ? parsed
      : { version: 1, records: [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, records: [] };
    throw error;
  }
}

async function writeIndex(index) {
  const target = indexPath();
  await fs.mkdir(path.dirname(/* turbopackIgnore: true */ target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o640 });
  await fs.rename(/* turbopackIgnore: true */ temporary, target);
}

export async function indexVaultCreation({ deployTxId, payload, acceptingBlockTime = null, source = "unknown" }) {
  const parsedPayload = parseVaultPayload(payload);
  if (!parsedPayload || !deployTxId) return false;

  const record = {
    deployTxId: String(deployTxId),
    payload: parsedPayload,
    acceptingBlockTime,
    indexedAtIso: new Date().toISOString(),
    source,
  };

  writeQueue = writeQueue.catch(() => null).then(async () => {
    const index = await readIndex();
    const key = recordKey(record);
    const existingPosition = index.records.findIndex((item) => recordKey(item) === key);
    if (existingPosition >= 0) {
      const existing = index.records[existingPosition];
      const payloadUnchanged = JSON.stringify(existing.payload) === JSON.stringify(record.payload);
      const hasNewBlockTime = !existing.acceptingBlockTime && record.acceptingBlockTime;
      if (payloadUnchanged && !hasNewBlockTime) return;
      index.records[existingPosition] = {
        ...existing,
        payload: record.payload,
        acceptingBlockTime: record.acceptingBlockTime || existing.acceptingBlockTime || null,
        indexedAtIso: record.indexedAtIso,
        source: record.source,
      };
    } else {
      if (index.records.length >= MAX_INDEX_RECORDS) {
        throw new Error("Vault index capacity reached; archive or compact the index before adding records.");
      }
      index.records.push(record);
    }
    await writeIndex(index);
  });

  await writeQueue;
  return true;
}

export async function findIndexedVaults({ ownerAddress, beneficiaryAddress }) {
  const index = await readIndex();
  return index.records.filter((record) => {
    const payload = parseVaultPayload(record.payload);
    if (!payload) return false;
    if (ownerAddress && payload.ownerAddress !== ownerAddress) return false;
    if (beneficiaryAddress && payload.beneficiaryAddress !== beneficiaryAddress) return false;
    return true;
  });
}

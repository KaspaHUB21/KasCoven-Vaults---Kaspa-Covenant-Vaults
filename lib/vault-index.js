import fs from "node:fs/promises";
import path from "node:path";

const VAULT_PROTOCOL = "kaslab-time-lock-vault-v1";
const VAULT_PAYLOAD_VERSION = 2;
const DEFAULT_INDEX_PATH = "/var/lib/kascoven-vaults/vault-index.json";

let writeQueue = Promise.resolve();

function indexPath() {
  return process.env.VAULT_INDEX_PATH || DEFAULT_INDEX_PATH;
}

function recordKey(record) {
  return record?.deployTxId || `${record?.payload?.vaultAddress || ""}:${record?.payload?.action || ""}`;
}

function isVaultPayload(payload) {
  return Boolean(
    payload &&
    payload.p === VAULT_PROTOCOL &&
    payload.v === VAULT_PAYLOAD_VERSION &&
    (payload.action === "create" || payload.action === "dms-create") &&
    payload.vaultAddress?.startsWith("kaspa:") &&
    payload.ownerAddress?.startsWith("kaspa:") &&
    payload.redeemScript,
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
    const parsed = JSON.parse(await fs.readFile(indexPath(), "utf8"));
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
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o640 });
  await fs.rename(temporary, target);
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

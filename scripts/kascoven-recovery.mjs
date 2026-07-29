#!/usr/bin/env node

const VAULT_PROTOCOL = "kaslab-time-lock-vault-v1";
const VAULT_PAYLOAD_VERSION = 2;
const RECOVERY_PROTOCOL = "kascoven-vault-recovery-v1";
const KASPA_API = process.env.KASPA_API || "https://api.kaspa.org";
const DEFAULT_VAULT_API = process.env.KASCOVEN_API || "http://127.0.0.1:3000/api/timelock-vault";
const MAX_SCAN_PAGES = Number(process.env.KASCOVEN_SCAN_PAGES || 1000);
const SCAN_PAGE_SIZE = 50;

function usage() {
  console.log(`KasCoven recovery CLI

Usage:
  node scripts/kascoven-recovery.mjs scan --address kaspa:... [--mode owner|beneficiary|all] [--out recovery.json]
  node scripts/kascoven-recovery.mjs export --address kaspa:... [--mode owner|beneficiary|all] --out recovery.json
  node scripts/kascoven-recovery.mjs claim-draft --file recovery.json [--vault 0] [--api http://127.0.0.1:3000/api/timelock-vault]

Notes:
  scan/export use public Kaspa transaction history and do not need vaults.kaslab.space.
  claim-draft needs any compatible KasCoven API, for example a locally restored copy of this repo.
  Export files may contain multiple vaults; claim-draft uses --vault INDEX (default: 0).
  Recovery files never contain private keys.`);
}

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${response.status} from ${url}`);
  }

  return data;
}

function parsePayload(payloadHex) {
  if (!payloadHex || typeof payloadHex !== "string") return null;

  try {
    const json = Buffer.from(payloadHex, "hex").toString("utf8");
    if (!json.trim().startsWith("{")) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function txTime(transaction) {
  return Number(transaction?.accepting_block_time || transaction?.block_time || 0);
}

function recoveryTime(recovery) {
  const parsed = Date.parse(recovery?.createdAtIso || recovery?.exportedAtIso || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function outpointId(outpoint) {
  if (!outpoint) return "";
  return `${outpoint.transactionId || outpoint.transaction_id || outpoint.txId || ""}:${outpoint.index ?? ""}`;
}

async function getUtxos(address) {
  const utxos = await fetchJson(`${KASPA_API}/addresses/${address}/utxos`);
  if (!Array.isArray(utxos)) {
    throw new Error(`Kaspa UTXO API returned an invalid response for ${address}. Recovery scan aborted.`);
  }
  return utxos;
}

function spendableUtxos(utxos) {
  return utxos
    .filter((item) => BigInt(String(item?.utxoEntry?.amount || "0")) > 1000000n && !item?.utxoEntry?.isCoinbase)
    .sort((a, b) => Number(BigInt(String(b.utxoEntry.amount)) - BigInt(String(a.utxoEntry.amount))));
}

function makeRecovery(type, payload, transaction, activeUtxo = null) {
  const recovery = payload.recovery && payload.recovery.protocol === RECOVERY_PROTOCOL ? payload.recovery : {};
  const amountSompi = activeUtxo?.utxoEntry?.amount || payload.lockAmountSompi || recovery.lockAmountSompi || null;

  return {
    protocol: RECOVERY_PROTOCOL,
    network: "kaspa-mainnet",
    exportedAtIso: new Date().toISOString(),
    vaultProtocol: payload.p || VAULT_PROTOCOL,
    payloadVersion: payload.v || VAULT_PAYLOAD_VERSION,
    type,
    vaultName: payload.vaultName || recovery.vaultName || (type === "dead_man_switch" ? "Dead Man's Switch" : "Time-Locked Vault"),
    deployTxId: transaction?.transaction_id || null,
    selectedOutpoint: activeUtxo?.outpoint || null,
    selectedOutpointId: outpointId(activeUtxo?.outpoint) || null,
    vaultAddress: payload.vaultAddress || recovery.vaultAddress || null,
    ownerAddress: payload.ownerAddress || recovery.ownerAddress || null,
    beneficiaryAddress: payload.beneficiaryAddress || recovery.beneficiaryAddress || null,
    ownerPublicKey: payload.ownerPublicKey || recovery.ownerPublicKey || null,
    unlockTime: payload.unlockTime || recovery.unlockTime || null,
    inactivityDaaBlocks: payload.inactivityDaaBlocks || recovery.inactivityDaaBlocks || null,
    lockDaaBlocks: payload.lockDaaBlocks || recovery.lockDaaBlocks || null,
    lockSeconds: payload.lockSeconds || recovery.lockSeconds || null,
    lockAmountSompi: amountSompi,
    lockAmountKas: amountSompi ? (Number(amountSompi) / 100000000).toString() : null,
    redeemScript: payload.redeemScript || recovery.redeemScript || null,
    scriptPublicKey: recovery.scriptPublicKey || null,
    createdBlueScore: payload.createdBlueScore || recovery.createdBlueScore || null,
    createdAtIso: payload.createdAtIso || recovery.createdAtIso || null,
    rawPayload: payload,
  };
}

async function scanAddress(address, mode = "all") {
  if (!address?.startsWith("kaspa:")) throw new Error("Provide a full kaspa: address.");

  const discovered = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const offset = page * SCAN_PAGE_SIZE;
    const transactions = await fetchJson(`${KASPA_API}/addresses/${address}/full-transactions?limit=${SCAN_PAGE_SIZE}&offset=${offset}`);
    if (!Array.isArray(transactions) || transactions.length === 0) break;

    for (const transaction of transactions) {
      const payload = parsePayload(transaction?.payload);
      if (!payload || payload.p !== VAULT_PROTOCOL || payload.v !== VAULT_PAYLOAD_VERSION) continue;

      const isTimeLock =
        payload.action === "create" &&
        payload.ownerAddress === address &&
        payload.pinnedOwnerAddress === address;
      const isDmsOwner = payload.action === "dms-create" && payload.ownerAddress === address;
      const isDmsBeneficiary =
        payload.action === "dms-create" &&
        payload.beneficiaryAddress === address &&
        payload.pinnedBeneficiaryAddress === address;

      if (mode === "owner" && !(isTimeLock || isDmsOwner)) continue;
      if (mode === "beneficiary" && !isDmsBeneficiary) continue;
      if (mode === "all" && !(isTimeLock || isDmsOwner || isDmsBeneficiary)) continue;

      discovered.push({
        type: isTimeLock ? "time_lock" : "dead_man_switch",
        payload,
        transaction,
      });
    }
  }

  const found = [];
  const ordered = discovered.sort((a, b) => txTime(b.transaction) - txTime(a.transaction));
  for (const item of ordered.filter((candidate) => candidate.type === "time_lock")) {
    const activeUtxos = spendableUtxos(await getUtxos(item.payload.vaultAddress));
    const deployTxId = String(item.transaction?.transaction_id || "");
    const matchingUtxos = activeUtxos.filter((utxo) => {
      const outpoint = utxo?.outpoint || {};
      return String(outpoint.transactionId || outpoint.transaction_id || outpoint.txId || "") === deployTxId;
    });
    for (const utxo of matchingUtxos) {
      found.push(makeRecovery(item.type, item.payload, item.transaction, utxo));
    }
  }

  const dmsByAddress = new Map();
  for (const item of ordered.filter((candidate) => candidate.type === "dead_man_switch")) {
    const entries = dmsByAddress.get(item.payload.vaultAddress) || [];
    entries.push(item);
    dmsByAddress.set(item.payload.vaultAddress, entries);
  }
  for (const [vaultAddress, creations] of dmsByAddress) {
    const activeUtxos = spendableUtxos(await getUtxos(vaultAddress));
    for (const utxo of activeUtxos) {
      const outpoint = utxo?.outpoint || {};
      const outpointTxId = String(outpoint.transactionId || outpoint.transaction_id || outpoint.txId || "");
      let creation = creations.find((item) => String(item.transaction?.transaction_id || "") === outpointTxId);

      if (!creation && outpointTxId) {
        const pulseTransaction = await fetchJson(`${KASPA_API}/transactions/${outpointTxId}`);
        const pulsePayload = parsePayload(pulseTransaction?.payload);
        if (pulsePayload?.action === "dms-heartbeat" && pulsePayload?.vaultId) {
          creation = creations.find(
            (item) => String(item.transaction?.transaction_id || "") === String(pulsePayload.vaultId),
          );
        }
      }

      // Legacy heartbeat payloads did not carry a vaultId. Their covenant is still
      // recoverable, but identical legacy creations can only use the newest metadata.
      creation ||= creations[0];
      if (creation) found.push(makeRecovery("dead_man_switch", creation.payload, creation.transaction, utxo));
    }
  }

  const unique = new Map();
  for (const recovery of found.sort((a, b) => recoveryTime(b) - recoveryTime(a))) {
    const key = recovery.selectedOutpointId || recovery.deployTxId || recovery.vaultAddress;
    if (key && !unique.has(key)) unique.set(key, recovery);
  }

  return Array.from(unique.values()).sort((a, b) => recoveryTime(b) - recoveryTime(a));
}

async function writeFile(path, data) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function readRecovery(path) {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8"));
}

async function claimDraft(file, apiUrl, vaultIndex = 0) {
  const document = await readRecovery(file);
  const records = Array.isArray(document?.vaults) ? document.vaults : [document];
  if (!Number.isInteger(vaultIndex) || vaultIndex < 0 || vaultIndex >= records.length) {
    throw new Error("--vault must select an existing recovery record; available indexes: 0-" + Math.max(0, records.length - 1) + ".");
  }
  const recovery = records[vaultIndex];
  if (recovery.protocol !== RECOVERY_PROTOCOL) throw new Error("Invalid recovery file protocol.");

  const params = new URLSearchParams();
  if (recovery.type === "time_lock") {
    params.set("action", "unlock");
    params.set("address", recovery.ownerAddress || "");
    params.set("ownerAddress", recovery.ownerAddress || "");
  } else {
    params.set("action", "dms-release");
    params.set("beneficiaryAddress", recovery.beneficiaryAddress || "");
    params.set("inactivityDaaBlocks", recovery.inactivityDaaBlocks || "");
    params.set("ownerPublicKey", recovery.ownerPublicKey || "");
    params.set("createdBlueScore", recovery.createdBlueScore || "");
    params.set("lastPulseBlueScore", recovery.lastPulseBlueScore || "");
  }
  params.set("vaultAddress", recovery.vaultAddress || "");
  params.set("unlockTime", recovery.unlockTime || "");
  params.set("redeemScript", recovery.redeemScript || "");
  params.set("feePolicy", recovery.rawPayload?.feePolicy || "legacy-cap");
  params.set("outpointTxId", recovery.selectedOutpoint?.transactionId || recovery.selectedOutpoint?.transaction_id || recovery.selectedOutpoint?.txId || "");
  params.set("outpointIndex", recovery.selectedOutpoint?.index ?? "");

  return fetchJson(`${apiUrl}?${params.toString()}`);
}

async function main() {
  const command = process.argv[2];
  if (!command || has("--help") || has("-h")) {
    usage();
    return;
  }

  if (command === "scan" || command === "export") {
    const address = arg("--address");
    const mode = arg("--mode", "all");
    const out = arg("--out");
    const vaults = await scanAddress(address, mode);
    const result = { protocol: RECOVERY_PROTOCOL, address, mode, count: vaults.length, vaults };

    if (command === "export" || out) {
      if (!out) throw new Error("--out is required for export.");
      await writeFile(out, result);
      console.log(`Wrote ${vaults.length} recovery record(s) to ${out}`);
      return;
    }

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "claim-draft") {
    const file = arg("--file");
    if (!file) throw new Error("--file is required.");
    const apiUrl = arg("--api", DEFAULT_VAULT_API);
    const vaultIndex = Number(arg("--vault", "0"));
    console.log(JSON.stringify(await claimDraft(file, apiUrl, vaultIndex), null, 2));
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Error: ${error?.message || String(error)}`);
  process.exitCode = 1;
});

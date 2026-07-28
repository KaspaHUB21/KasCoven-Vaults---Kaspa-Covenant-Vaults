import path from "path";
import { createRequire } from "module";
import { kaspaApiUrl, kaspaHistoryApiUrl } from "../../../lib/kaspa-endpoints.js";
import { findIndexedVaults, indexVaultCreation } from "../../../lib/vault-index.js";

const TOCCATA_FEE_RATE = 100n;
const FEE_SAFETY_BUFFER_SOMPI = 50_000n;
const MIN_RETURN_SOMPI = 1_000_000n;
const MIN_COMPUTE_MASS = 120_000n;
const DEFAULT_LOCK_SOMPI = 20_000_000n;
const DEFAULT_LOCK_SECONDS = 300;
const MAINNET_BLOCKS_PER_SECOND = 10;
const VAULT_PROTOCOL = "kaslab-time-lock-vault-v1";
const VAULT_PAYLOAD_VERSION = 2;
const RECOVERY_PROTOCOL = "kascoven-vault-recovery-v1";
const KEYLESS_MAX_FEE_SOMPI = 15_000_000n;
const DMS_NOTICE_SOMPI = 3_000_000n;
const MAX_SCAN_PAGES = 10_000;
const SCAN_PAGE_SIZE = 50;

function loadToccataKaspa() {
  const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));
  return requireFromProject(
    path.join(
      process.cwd(),
      ".toccata-mini-test",
      "sdk",
      "kaspa-wasm32-sdk",
      "nodejs",
      "kaspa",
      "kaspa.js",
    ),
  );
}

function asBigInt(value) {
  return BigInt(String(value || "0"));
}

function kasToSompi(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_LOCK_SOMPI;
  return BigInt(Math.round(numeric * 100000000));
}

function cleanVaultName(value, fallback) {
  const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 64);
  return name || fallback;
}

function isValidKaspaAddress(kaspa, address) {
  if (!address?.startsWith("kaspa:")) return false;

  try {
    kaspa.payToAddressScript(address);
    return true;
  } catch {
    return false;
  }
}

function normalizeSchnorrPublicKey(publicKey) {
  const hex = String(publicKey || "").trim().replace(/^0x/i, "").toLowerCase();

  if (/^[0-9a-f]{64}$/.test(hex)) return hex;
  if (/^(02|03)[0-9a-f]{64}$/.test(hex)) return hex.slice(2);
  return "";
}

function makeScriptPublicKey(kaspa, scriptPublicKey) {
  const raw = scriptPublicKey?.scriptPublicKey || scriptPublicKey;
  return new kaspa.ScriptPublicKey(0, Buffer.from(raw, "hex"));
}

function scriptPublicKeyBytes(kaspa, address) {
  const scriptPublicKey = kaspa.payToAddressScript(address);
  const { script, version } = scriptPublicKey.toJSON();
  const scriptBytes = Buffer.from(script, "hex");
  const versionBytes = Buffer.alloc(2);
  versionBytes.writeUInt16BE(Number(version || 0));
  return Buffer.concat([versionBytes, scriptBytes]);
}

function makeTimeLockVault(kaspa, unlockTime, ownerAddress) {
  if (!ownerAddress?.startsWith("kaspa:")) {
    throw new Error("A valid owner Kaspa address is required for pinned time-lock vaults.");
  }

  const ownerScriptPublicKeyBytes = scriptPublicKeyBytes(kaspa, ownerAddress);
  const builder = new kaspa.ScriptBuilder();
  builder.addLockTime(BigInt(unlockTime));
  builder.addOp(kaspa.Opcodes.OpCheckLockTimeVerify);

  builder.addOp(kaspa.Opcodes.OpTxInputCount);
  builder.addI64(1n);
  builder.addOp(kaspa.Opcodes.OpNumEqualVerify);

  builder.addOp(kaspa.Opcodes.OpTxOutputCount);
  builder.addI64(1n);
  builder.addOp(kaspa.Opcodes.OpNumEqualVerify);

  builder.addI64(0n);
  builder.addOp(kaspa.Opcodes.OpTxOutputSpk);
  builder.addData(ownerScriptPublicKeyBytes);
  builder.addOp(kaspa.Opcodes.OpEqualVerify);

  builder.addI64(0n);
  builder.addOp(kaspa.Opcodes.OpTxOutputAmount);
  builder.addOp(kaspa.Opcodes.OpTxInputIndex);
  builder.addOp(kaspa.Opcodes.OpTxInputAmount);
  builder.addI64(KEYLESS_MAX_FEE_SOMPI);
  builder.addOp(kaspa.Opcodes.OpSub);
  builder.addOp(kaspa.Opcodes.OpGreaterThanOrEqual);
  builder.addOp(kaspa.Opcodes.OpVerify);

  builder.addOp(kaspa.Opcodes.OpTrue);
  const redeemScript = builder.toString();
  const scriptPublicKey = builder.createPayToScriptHashScript();
  const address = kaspa.addressFromScriptPublicKey(scriptPublicKey, "mainnet").toString();

  return {
    address,
    unlockTime: String(unlockTime),
    ownerAddress,
    pinnedOwnerAddress: ownerAddress,
    pinnedOwnerScriptPublicKey: ownerScriptPublicKeyBytes.toString("hex"),
    maxFeeSompi: KEYLESS_MAX_FEE_SOMPI.toString(),
    redeemScript,
    unlockScript: builder.encodePayToScriptHashSignatureScript(""),
    scriptPublicKey: scriptPublicKey.toJSON(),
  };
}

function makeWizardVault(kaspa, unlockTime) {
  const builder = new kaspa.ScriptBuilder();
  builder.addLockTime(BigInt(unlockTime));
  builder.addOp(kaspa.Opcodes.OpCheckLockTimeVerify);

  builder.addOp(kaspa.Opcodes.OpTxInputCount);
  builder.addI64(1n);
  builder.addOp(kaspa.Opcodes.OpNumEqualVerify);

  builder.addOp(kaspa.Opcodes.OpTxOutputCount);
  builder.addI64(1n);
  builder.addOp(kaspa.Opcodes.OpNumEqualVerify);

  builder.addI64(0n);
  builder.addOp(kaspa.Opcodes.OpTxOutputAmount);
  builder.addOp(kaspa.Opcodes.OpTxInputIndex);
  builder.addOp(kaspa.Opcodes.OpTxInputAmount);
  builder.addI64(KEYLESS_MAX_FEE_SOMPI);
  builder.addOp(kaspa.Opcodes.OpSub);
  builder.addOp(kaspa.Opcodes.OpGreaterThanOrEqual);
  builder.addOp(kaspa.Opcodes.OpVerify);

  builder.addOp(kaspa.Opcodes.OpTrue);
  const redeemScript = builder.toString();
  const scriptPublicKey = builder.createPayToScriptHashScript();
  const address = kaspa.addressFromScriptPublicKey(scriptPublicKey, "mainnet").toString();

  return {
    address,
    unlockTime: String(unlockTime),
    maxFeeSompi: KEYLESS_MAX_FEE_SOMPI.toString(),
    redeemScript,
    unlockScript: builder.encodePayToScriptHashSignatureScript(""),
    scriptPublicKey: scriptPublicKey.toJSON(),
  };
}

function makeDeadManSwitchVault(kaspa, inactivityDaaBlocks, beneficiaryAddress, ownerPublicKey) {
  if (!beneficiaryAddress?.startsWith("kaspa:")) {
    throw new Error("A valid beneficiary Kaspa address is required for dead-man-switch vaults.");
  }

  const normalizedOwnerPublicKey = normalizeSchnorrPublicKey(ownerPublicKey);
  if (!normalizedOwnerPublicKey) {
    throw new Error("An owner public key is required for heartbeat dead-man-switch vaults.");
  }

  const beneficiaryScriptPublicKeyBytes = scriptPublicKeyBytes(kaspa, beneficiaryAddress);
  const builder = new kaspa.ScriptBuilder();

  builder.addOp(kaspa.Opcodes.OpIf);
  builder.addData(Buffer.from(normalizedOwnerPublicKey, "hex"));
  builder.addOp(kaspa.Opcodes.OpCheckSigVerify);

  builder.addOp(kaspa.Opcodes.OpTxInputCount);
  builder.addI64(2n);
  builder.addOp(kaspa.Opcodes.OpNumEqualVerify);

  builder.addOp(kaspa.Opcodes.OpTxOutputCount);
  builder.addI64(2n);
  builder.addOp(kaspa.Opcodes.OpNumEqualVerify);

  builder.addI64(0n);
  builder.addOp(kaspa.Opcodes.OpTxOutputSpk);
  builder.addOp(kaspa.Opcodes.OpTxInputIndex);
  builder.addOp(kaspa.Opcodes.OpTxInputSpk);
  builder.addOp(kaspa.Opcodes.OpEqualVerify);

  builder.addI64(0n);
  builder.addOp(kaspa.Opcodes.OpTxOutputAmount);
  builder.addOp(kaspa.Opcodes.OpTxInputIndex);
  builder.addOp(kaspa.Opcodes.OpTxInputAmount);
  builder.addOp(kaspa.Opcodes.OpGreaterThanOrEqual);
  builder.addOp(kaspa.Opcodes.OpVerify);
  builder.addOp(kaspa.Opcodes.OpTrue);

  builder.addOp(kaspa.Opcodes.OpElse);
  builder.addSequence(BigInt(inactivityDaaBlocks));
  builder.addOp(kaspa.Opcodes.OpCheckSequenceVerify);

  builder.addOp(kaspa.Opcodes.OpTxInputCount);
  builder.addI64(1n);
  builder.addOp(kaspa.Opcodes.OpNumEqualVerify);

  builder.addOp(kaspa.Opcodes.OpTxOutputCount);
  builder.addI64(1n);
  builder.addOp(kaspa.Opcodes.OpNumEqualVerify);

  builder.addI64(0n);
  builder.addOp(kaspa.Opcodes.OpTxOutputSpk);
  builder.addData(beneficiaryScriptPublicKeyBytes);
  builder.addOp(kaspa.Opcodes.OpEqualVerify);

  builder.addI64(0n);
  builder.addOp(kaspa.Opcodes.OpTxOutputAmount);
  builder.addOp(kaspa.Opcodes.OpTxInputIndex);
  builder.addOp(kaspa.Opcodes.OpTxInputAmount);
  builder.addI64(KEYLESS_MAX_FEE_SOMPI);
  builder.addOp(kaspa.Opcodes.OpSub);
  builder.addOp(kaspa.Opcodes.OpGreaterThanOrEqual);
  builder.addOp(kaspa.Opcodes.OpVerify);
  builder.addOp(kaspa.Opcodes.OpTrue);
  builder.addOp(kaspa.Opcodes.OpEndIf);

  const redeemScript = builder.toString();
  const scriptPublicKey = builder.createPayToScriptHashScript();
  const address = kaspa.addressFromScriptPublicKey(scriptPublicKey, "mainnet").toString();
  const beneficiaryUnlockScript = new kaspa.ScriptBuilder()
    .addI64(0n)
    .addData(Buffer.from(redeemScript, "hex"))
    .drain();

  return {
    address,
    inactivityDaaBlocks: String(inactivityDaaBlocks),
    beneficiaryAddress,
    pinnedBeneficiaryAddress: beneficiaryAddress,
    ownerPublicKey: normalizedOwnerPublicKey,
    maxFeeSompi: KEYLESS_MAX_FEE_SOMPI.toString(),
    redeemScript,
    unlockScript: beneficiaryUnlockScript,
    scriptPublicKey: scriptPublicKey.toJSON(),
  };
}

function jsonPayloadHex(value) {
  return Buffer.from(JSON.stringify(value)).toString("hex");
}

function makeRecoveryRecord(type, payload, vault) {
  return {
    protocol: RECOVERY_PROTOCOL,
    network: "kaspa-mainnet",
    vaultProtocol: VAULT_PROTOCOL,
    payloadVersion: VAULT_PAYLOAD_VERSION,
    type,
    vaultName: payload.vaultName,
    vaultAddress: payload.vaultAddress,
    ownerAddress: payload.ownerAddress || null,
    beneficiaryAddress: payload.beneficiaryAddress || null,
    ownerPublicKey: payload.ownerPublicKey || null,
    unlockTime: payload.unlockTime || null,
    inactivityDaaBlocks: payload.inactivityDaaBlocks || null,
    lockDaaBlocks: payload.lockDaaBlocks || null,
    lockSeconds: payload.lockSeconds || null,
    lockAmountSompi: payload.lockAmountSompi || null,
    redeemScript: payload.redeemScript,
    scriptPublicKey: vault.scriptPublicKey,
    createdBlueScore: payload.createdBlueScore || null,
    createdAtIso: payload.createdAtIso || null,
  };
}

function parseJsonPayload(payload) {
  if (!payload || typeof payload !== "string") return null;

  try {
    const json = Buffer.from(payload, "hex").toString("utf8");
    if (!json.trim().startsWith("{")) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function getCurrentBlueScore() {
  const response = await fetch(kaspaApiUrl("/info/blockdag"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Could not fetch current Kaspa DAA score for the time-lock.");
  }

  const data = await response.json();
  return Number(data?.virtualDaaScore || data?.blueScore || 0);
}

async function findLatestDeadManSwitchPulse(beneficiaryAddress, vaultAddress) {
  if (!beneficiaryAddress?.startsWith("kaspa:") || !vaultAddress?.startsWith("kaspa:")) return null;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const offset = page * SCAN_PAGE_SIZE;
    const response = await fetch(
      kaspaApiUrl(`/addresses/${beneficiaryAddress}/full-transactions?limit=${SCAN_PAGE_SIZE}&offset=${offset}`),
      { cache: "no-store" },
    );

    if (!response.ok) return null;

    const transactions = await response.json();
    if (!Array.isArray(transactions) || transactions.length === 0) break;

    const pulse = transactions
      .map((transaction) => ({ transaction, payload: parseJsonPayload(transaction?.payload) }))
      .filter(
        ({ payload }) =>
          payload?.p === VAULT_PROTOCOL &&
          payload?.v === VAULT_PAYLOAD_VERSION &&
          payload?.action === "dms-heartbeat" &&
          payload?.vaultAddress === vaultAddress,
      )
      .sort((a, b) => Number(b.transaction?.accepting_block_time || b.transaction?.block_time || 0) - Number(a.transaction?.accepting_block_time || a.transaction?.block_time || 0))[0];

    if (pulse) return pulse;
  }

  return null;
}

function pickSpendableUtxo(utxos, minimumAmount = MIN_RETURN_SOMPI) {
  return (Array.isArray(utxos) ? utxos : [])
    .filter((item) => asBigInt(item?.utxoEntry?.amount) > minimumAmount && !item?.utxoEntry?.isCoinbase)
    .sort((a, b) => Number(asBigInt(b.utxoEntry.amount) - asBigInt(a.utxoEntry.amount)))[0];
}

function spendableUtxos(utxos, minimumAmount = MIN_RETURN_SOMPI) {
  return (Array.isArray(utxos) ? utxos : [])
    .filter((item) => asBigInt(item?.utxoEntry?.amount) > minimumAmount && !item?.utxoEntry?.isCoinbase)
    .sort((a, b) => Number(asBigInt(b.utxoEntry.amount) - asBigInt(a.utxoEntry.amount)));
}

function pickVaultUtxo(utxos, outpointTxId, outpointIndex) {
  const spendable = spendableUtxos(utxos);
  if (!outpointTxId) return spendable[0] || null;

  return (
    spendable.find((item) => {
      const outpoint = item?.outpoint || {};
      const txId = outpoint.transactionId || outpoint.transaction_id || outpoint.txId;
      return String(txId) === String(outpointTxId) && String(outpoint.index) === String(outpointIndex);
    }) || null
  );
}

function estimateFee(kaspa, transaction) {
  let txMass = MIN_COMPUTE_MASS;

  try {
    const calculated = BigInt(String(kaspa.calculateTransactionMass("mainnet", transaction, 1) || 0));
    if (calculated > txMass) txMass = calculated;
  } catch {
    // Keep the conservative fallback.
  }

  return txMass * TOCCATA_FEE_RATE + FEE_SAFETY_BUFFER_SOMPI;
}

async function createVaultDraft(kaspa, searchParams) {
  const address = searchParams.get("address");
  const lockSeconds = Math.max(1, Number(searchParams.get("lockSeconds") || DEFAULT_LOCK_SECONDS));
  const lockAmount = kasToSompi(searchParams.get("amountKas"));
  const vaultName = cleanVaultName(searchParams.get("vaultName"), "Time-Locked Vault");
  const currentBlueScore = await getCurrentBlueScore();
  const lockDaaBlocks = Math.max(1, Math.ceil(lockSeconds * MAINNET_BLOCKS_PER_SECOND));
  const unlockTime = currentBlueScore + lockDaaBlocks;

  if (!isValidKaspaAddress(kaspa, address)) {
    return Response.json({ error: "A valid Kaspa address is required." }, { status: 400 });
  }

  const vault = makeTimeLockVault(kaspa, unlockTime, address);
  const payload = {
    p: VAULT_PROTOCOL,
    v: VAULT_PAYLOAD_VERSION,
    recoveryProtocol: RECOVERY_PROTOCOL,
    action: "create",
    vaultName,
    ownerAddress: address,
    pinnedOwnerAddress: address,
    vaultAddress: vault.address,
    unlockTime: String(unlockTime),
    redeemScript: vault.redeemScript,
    pinnedOwnerScriptPublicKey: vault.pinnedOwnerScriptPublicKey,
    maxFeeSompi: KEYLESS_MAX_FEE_SOMPI.toString(),
    lockSeconds,
    lockDaaBlocks,
    lockAmountSompi: lockAmount.toString(),
    createdBlueScore: currentBlueScore,
    createdAtIso: new Date().toISOString(),
  };
  payload.recovery = makeRecoveryRecord("time_lock", payload, vault);
  const payloadHex = jsonPayloadHex(payload);
  const vaultScript = kaspa.payToAddressScript(vault.address);
  const changeScript = kaspa.payToAddressScript(address);
  const utxoResponse = await fetch(kaspaApiUrl(`/addresses/${address}/utxos`), { cache: "no-store" });

  if (!utxoResponse.ok) {
    throw new Error("Kaspa UTXO API returned an error for the wallet address.");
  }

  const selected = pickSpendableUtxo(await utxoResponse.json(), lockAmount + MIN_RETURN_SOMPI);
  if (!selected) {
    return Response.json(
      {
        error: "Not enough spendable KAS for this time-locked vault. Lower the amount or fund this wallet first.",
        requestedAmountKas: (Number(lockAmount) / 100000000).toString(),
      },
      { status: 400 },
    );
  }

  const outpoint = selected.outpoint;
  const utxoEntry = selected.utxoEntry;
  const amount = asBigInt(utxoEntry.amount);
  const inputScript = makeScriptPublicKey(kaspa, utxoEntry.scriptPublicKey);
  const input = {
    previousOutpoint: outpoint,
    sequence: 0n,
    sigOpCount: 1,
    utxo: {
      address,
      outpoint,
      amount,
      scriptPublicKey: inputScript,
      blockDaaScore: asBigInt(utxoEntry.blockDaaScore),
      isCoinbase: Boolean(utxoEntry.isCoinbase),
    },
  };
  const provisional = new kaspa.Transaction({
    version: 0,
    inputs: [input],
    outputs: [new kaspa.TransactionOutput(lockAmount, vaultScript)],
    lockTime: 0n,
    gas: 0n,
    payload: payloadHex,
    subnetworkId: "0000000000000000000000000000000000000000",
  });
  const fee = estimateFee(kaspa, provisional);
  const changeAmount = amount - lockAmount - fee;

  if (changeAmount < MIN_RETURN_SOMPI) {
    return Response.json(
      {
        error: "Not enough spendable KAS for this time-locked vault after the network fee. Lower the amount or fund this wallet first.",
        amountSompi: amount.toString(),
        neededSompi: (lockAmount + fee + MIN_RETURN_SOMPI).toString(),
        estimatedFeeSompi: fee.toString(),
      },
      { status: 400 },
    );
  }

  const transaction = new kaspa.Transaction({
    version: 0,
    inputs: [input],
    outputs: [
      new kaspa.TransactionOutput(lockAmount, vaultScript),
      new kaspa.TransactionOutput(changeAmount, changeScript),
    ],
    lockTime: 0n,
    gas: 0n,
    payload: payloadHex,
    subnetworkId: "0000000000000000000000000000000000000000",
  });

  return Response.json({
    status: "Time-locked vault create transaction ready",
    address,
    vaultName,
    vault,
    currentBlueScore,
    payload,
    lockDaaBlocks,
    estimatedUnlockTimeIso: new Date(Date.now() + lockSeconds * 1000).toISOString(),
    selectedOutpoint: outpoint,
    lockSeconds,
    lockAmountSompi: lockAmount.toString(),
    lockAmountKas: (Number(lockAmount) / 100000000).toString(),
    estimatedFeeSompi: fee.toString(),
    estimatedFeeKas: (Number(fee) / 100000000).toString(),
    changeAmountSompi: changeAmount.toString(),
    changeAmountKas: (Number(changeAmount) / 100000000).toString(),
    tx: JSON.parse(transaction.serializeToSafeJSON()),
    txJson: transaction.serializeToSafeJSON(),
  });
}

async function createWizardVaultDraft(kaspa, searchParams) {
  const address = searchParams.get("address");
  const lockAmount = kasToSompi(searchParams.get("amountKas"));
  const vaultName = cleanVaultName(searchParams.get("vaultName"), "First Come, First Served");
  const currentBlueScore = await getCurrentBlueScore();
  const requestedUnlockDaaScore = Number(searchParams.get("unlockDaaScore") || 0);
  const legacyLockSeconds = Math.max(1, Number(searchParams.get("lockSeconds") || DEFAULT_LOCK_SECONDS));
  const unlockTime = requestedUnlockDaaScore || currentBlueScore + Math.ceil(legacyLockSeconds * MAINNET_BLOCKS_PER_SECOND);
  const lockDaaBlocks = unlockTime - currentBlueScore;

  if (!isValidKaspaAddress(kaspa, address)) {
    return Response.json({ error: "A valid creator Kaspa address is required." }, { status: 400 });
  }
  if (!Number.isSafeInteger(unlockTime) || lockDaaBlocks < 1) {
    return Response.json({ error: "Unlock DAA score must be a whole number above the current DAA score." }, { status: 400 });
  }

  const vault = makeWizardVault(kaspa, unlockTime);
  const payload = {
    p: VAULT_PROTOCOL,
    v: VAULT_PAYLOAD_VERSION,
    action: "wizard-create",
    wizardMode: "first-come-first-served",
    vaultName,
    ownerAddress: address,
    vaultAddress: vault.address,
    unlockTime: String(unlockTime),
    redeemScript: vault.redeemScript,
    maxFeeSompi: KEYLESS_MAX_FEE_SOMPI.toString(),
    lockSeconds: Math.ceil(lockDaaBlocks / MAINNET_BLOCKS_PER_SECOND),
    lockDaaBlocks,
    lockAmountSompi: lockAmount.toString(),
    createdBlueScore: currentBlueScore,
    createdAtIso: new Date().toISOString(),
  };
  const payloadHex = jsonPayloadHex(payload);
  const vaultScript = kaspa.payToAddressScript(vault.address);
  const changeScript = kaspa.payToAddressScript(address);
  const utxoResponse = await fetch(kaspaApiUrl(`/addresses/${address}/utxos`), { cache: "no-store" });
  if (!utxoResponse.ok) throw new Error("Kaspa UTXO API returned an error for the creator wallet.");

  const selected = pickSpendableUtxo(await utxoResponse.json(), lockAmount + MIN_RETURN_SOMPI);
  if (!selected) {
    return Response.json({ error: "Not enough spendable KAS for this special vault." }, { status: 400 });
  }

  const outpoint = selected.outpoint;
  const utxoEntry = selected.utxoEntry;
  const amount = asBigInt(utxoEntry.amount);
  const input = {
    previousOutpoint: outpoint,
    sequence: 0n,
    sigOpCount: 1,
    utxo: {
      address,
      outpoint,
      amount,
      scriptPublicKey: makeScriptPublicKey(kaspa, utxoEntry.scriptPublicKey),
      blockDaaScore: asBigInt(utxoEntry.blockDaaScore),
      isCoinbase: Boolean(utxoEntry.isCoinbase),
    },
  };
  const provisional = new kaspa.Transaction({
    version: 0,
    inputs: [input],
    outputs: [new kaspa.TransactionOutput(lockAmount, vaultScript)],
    lockTime: 0n,
    gas: 0n,
    payload: payloadHex,
    subnetworkId: "0000000000000000000000000000000000000000",
  });
  const fee = estimateFee(kaspa, provisional);
  const changeAmount = amount - lockAmount - fee;
  if (changeAmount < MIN_RETURN_SOMPI) {
    return Response.json({ error: "Not enough spendable KAS after the network fee." }, { status: 400 });
  }

  const transaction = new kaspa.Transaction({
    version: 0,
    inputs: [input],
    outputs: [
      new kaspa.TransactionOutput(lockAmount, vaultScript),
      new kaspa.TransactionOutput(changeAmount, changeScript),
    ],
    lockTime: 0n,
    gas: 0n,
    payload: payloadHex,
    subnetworkId: "0000000000000000000000000000000000000000",
  });

  return Response.json({
    status: "First-come-first-served vault transaction ready",
    address,
    vaultName,
    vault,
    payload,
    currentBlueScore,
    lockDaaBlocks,
    lockSeconds: Math.ceil(lockDaaBlocks / MAINNET_BLOCKS_PER_SECOND),
    lockAmountSompi: lockAmount.toString(),
    lockAmountKas: (Number(lockAmount) / 100000000).toString(),
    unlockDaaScore: String(unlockTime),
    estimatedFeeSompi: fee.toString(),
    changeAmountSompi: changeAmount.toString(),
    tx: JSON.parse(transaction.serializeToSafeJSON()),
    txJson: transaction.serializeToSafeJSON(),
  });
}

async function createDeadManSwitchDraft(kaspa, searchParams) {
  const address = searchParams.get("address");
  const publicKey = searchParams.get("publicKey");
  const beneficiaryAddress = searchParams.get("beneficiaryAddress");
  const lockSeconds = Math.max(1, Number(searchParams.get("lockSeconds") || DEFAULT_LOCK_SECONDS));
  const lockAmount = kasToSompi(searchParams.get("amountKas"));
  const vaultName = cleanVaultName(searchParams.get("vaultName"), "Dead Man's Switch");
  const currentBlueScore = await getCurrentBlueScore();
  const lockDaaBlocks = Math.max(1, Math.ceil(lockSeconds * MAINNET_BLOCKS_PER_SECOND));
  const unlockTime = currentBlueScore + lockDaaBlocks;

  if (!isValidKaspaAddress(kaspa, address)) {
    return Response.json({ error: "A valid owner Kaspa address is required." }, { status: 400 });
  }

  if (!isValidKaspaAddress(kaspa, beneficiaryAddress)) {
    return Response.json(
      { error: "The beneficiary address is not a valid Kaspa address. Paste the full kaspa: address and try again." },
      { status: 400 },
    );
  }

  const ownerPublicKey = normalizeSchnorrPublicKey(publicKey);
  if (!ownerPublicKey) {
    return Response.json({ error: "Owner public key is required so this dead-man-switch can receive heartbeat pulses." }, { status: 400 });
  }

  const vault = makeDeadManSwitchVault(kaspa, lockDaaBlocks, beneficiaryAddress, ownerPublicKey);
  const payload = {
    p: VAULT_PROTOCOL,
    v: VAULT_PAYLOAD_VERSION,
    recoveryProtocol: RECOVERY_PROTOCOL,
    action: "dms-create",
    dmsMode: "heartbeat",
    vaultName,
    ownerAddress: address,
    ownerPublicKey,
    beneficiaryAddress,
    pinnedBeneficiaryAddress: beneficiaryAddress,
    vaultAddress: vault.address,
    unlockTime: String(unlockTime),
    inactivityDaaBlocks: String(lockDaaBlocks),
    redeemScript: vault.redeemScript,
    pinnedBeneficiaryScriptPublicKey: scriptPublicKeyBytes(kaspa, beneficiaryAddress).toString("hex"),
    maxFeeSompi: KEYLESS_MAX_FEE_SOMPI.toString(),
    lockSeconds,
    lockDaaBlocks,
    lockAmountSompi: lockAmount.toString(),
    createdBlueScore: currentBlueScore,
    createdAtIso: new Date().toISOString(),
  };
  payload.recovery = makeRecoveryRecord("dead_man_switch", payload, vault);
  const payloadHex = jsonPayloadHex(payload);
  const vaultScript = kaspa.payToAddressScript(vault.address);
  const beneficiaryScript = kaspa.payToAddressScript(beneficiaryAddress);
  const changeScript = kaspa.payToAddressScript(address);
  const utxoResponse = await fetch(kaspaApiUrl(`/addresses/${address}/utxos`), { cache: "no-store" });

  if (!utxoResponse.ok) {
    throw new Error("Kaspa UTXO API returned an error for the owner wallet address.");
  }

  const selected = pickSpendableUtxo(await utxoResponse.json(), lockAmount + DMS_NOTICE_SOMPI + MIN_RETURN_SOMPI);
  if (!selected) {
    return Response.json(
      {
        error: "Not enough spendable KAS for this dead-man-switch vault. Lower the amount or fund this wallet first.",
        requestedAmountKas: (Number(lockAmount) / 100000000).toString(),
        noticeKas: (Number(DMS_NOTICE_SOMPI) / 100000000).toString(),
      },
      { status: 400 },
    );
  }

  const outpoint = selected.outpoint;
  const utxoEntry = selected.utxoEntry;
  const amount = asBigInt(utxoEntry.amount);
  const inputScript = makeScriptPublicKey(kaspa, utxoEntry.scriptPublicKey);
  const input = {
    previousOutpoint: outpoint,
    sequence: 0n,
    sigOpCount: 1,
    utxo: {
      address,
      outpoint,
      amount,
      scriptPublicKey: inputScript,
      blockDaaScore: asBigInt(utxoEntry.blockDaaScore),
      isCoinbase: Boolean(utxoEntry.isCoinbase),
    },
  };
  const provisional = new kaspa.Transaction({
    version: 0,
    inputs: [input],
    outputs: [
      new kaspa.TransactionOutput(lockAmount, vaultScript),
      new kaspa.TransactionOutput(DMS_NOTICE_SOMPI, beneficiaryScript),
    ],
    lockTime: 0n,
    gas: 0n,
    payload: payloadHex,
    subnetworkId: "0000000000000000000000000000000000000000",
  });
  const fee = estimateFee(kaspa, provisional);
  const changeAmount = amount - lockAmount - DMS_NOTICE_SOMPI - fee;

  if (changeAmount < MIN_RETURN_SOMPI) {
    return Response.json(
      {
        error: "Not enough spendable KAS for this dead-man-switch vault after the beneficiary notice output and network fee. Lower the amount or fund this wallet first.",
        amountSompi: amount.toString(),
        neededSompi: (lockAmount + DMS_NOTICE_SOMPI + fee + MIN_RETURN_SOMPI).toString(),
        noticeSompi: DMS_NOTICE_SOMPI.toString(),
        estimatedFeeSompi: fee.toString(),
      },
      { status: 400 },
    );
  }

  const transaction = new kaspa.Transaction({
    version: 0,
    inputs: [input],
    outputs: [
      new kaspa.TransactionOutput(lockAmount, vaultScript),
      new kaspa.TransactionOutput(DMS_NOTICE_SOMPI, beneficiaryScript),
      new kaspa.TransactionOutput(changeAmount, changeScript),
    ],
    lockTime: 0n,
    gas: 0n,
    payload: payloadHex,
    subnetworkId: "0000000000000000000000000000000000000000",
  });

  return Response.json({
    status: "Dead-man-switch vault create transaction ready",
    address,
    vaultName,
    beneficiaryAddress,
    vault,
    currentBlueScore,
    payload,
    lockDaaBlocks,
    estimatedUnlockTimeIso: new Date(Date.now() + lockSeconds * 1000).toISOString(),
    selectedOutpoint: outpoint,
    lockSeconds,
    lockAmountSompi: lockAmount.toString(),
    lockAmountKas: (Number(lockAmount) / 100000000).toString(),
    noticeSompi: DMS_NOTICE_SOMPI.toString(),
    noticeKas: (Number(DMS_NOTICE_SOMPI) / 100000000).toString(),
    estimatedFeeSompi: fee.toString(),
    estimatedFeeKas: (Number(fee) / 100000000).toString(),
    changeAmountSompi: changeAmount.toString(),
    changeAmountKas: (Number(changeAmount) / 100000000).toString(),
    tx: JSON.parse(transaction.serializeToSafeJSON()),
    txJson: transaction.serializeToSafeJSON(),
  });
}

async function scanActiveVaults(kaspa, searchParams) {
  const address = searchParams.get("address");

  if (!address?.startsWith("kaspa:")) {
    return Response.json({ error: "A valid Kaspa address is required." }, { status: 400 });
  }

  const candidates = [];

  for (let page = -1; page < MAX_SCAN_PAGES; page += 1) {
    let transactions;
    if (page === -1) {
      const indexed = await findIndexedVaults({ ownerAddress: address });
      transactions = indexed.map((record) => ({
        transaction_id: record.deployTxId,
        payload: record.payload,
        accepting_block_time: record.acceptingBlockTime,
      }));
    } else {
      const offset = page * SCAN_PAGE_SIZE;
      const response = await fetch(
        kaspaHistoryApiUrl(`/addresses/${address}/full-transactions?limit=${SCAN_PAGE_SIZE}&offset=${offset}`),
        { cache: "no-store" },
      );

      if (!response.ok) {
        if (candidates.length) break;
        throw new Error("Kaspa archival transaction history API returned an error for this wallet.");
      }

      transactions = await response.json();
      if (!Array.isArray(transactions) || transactions.length === 0) break;
    }

    for (const transaction of transactions) {
      const payload = parseJsonPayload(transaction?.payload);
      if (
        !payload ||
        payload.p !== VAULT_PROTOCOL ||
        payload.v !== VAULT_PAYLOAD_VERSION ||
        payload.action !== "create" ||
        payload.ownerAddress !== address ||
        payload.pinnedOwnerAddress !== address ||
        !payload.vaultAddress?.startsWith("kaspa:") ||
        !payload.unlockTime ||
        !payload.redeemScript
      ) {
        continue;
      }

      await indexVaultCreation({
        deployTxId: transaction.transaction_id,
        payload,
        acceptingBlockTime: transaction.accepting_block_time || transaction.block_time || null,
        source: page === -1 ? "index-refresh" : "history-backfill",
      }).catch(() => null);

      const vault = makeTimeLockVault(kaspa, payload.unlockTime, payload.ownerAddress);
      if (vault.address !== payload.vaultAddress || vault.redeemScript !== payload.redeemScript) {
        continue;
      }

      const utxoResponse = await fetch(kaspaApiUrl(`/addresses/${payload.vaultAddress}/utxos`), {
        cache: "no-store",
      });
      if (!utxoResponse.ok) continue;

      const utxos = await utxoResponse.json();
      const selected = pickSpendableUtxo(utxos);
      if (!selected) continue;

      const currentBlueScore = await getCurrentBlueScore();
      const remainingDaaBlocks = Math.max(0, Number(payload.unlockTime) - currentBlueScore);
      const estimatedRemainingSeconds = Math.ceil(remainingDaaBlocks / MAINNET_BLOCKS_PER_SECOND);
      const amount = asBigInt(selected?.utxoEntry?.amount);

      candidates.push({
        status: "Active time-locked vault found",
        vaultName: payload.vaultName || "Time-Locked Vault",
        address,
        deployTxId: transaction.transaction_id,
        acceptingBlockTime: transaction.accepting_block_time || transaction.block_time || null,
        vault,
        currentBlueScore,
        lockDaaBlocks: Number(payload.lockDaaBlocks || 0),
        lockSeconds: Number(payload.lockSeconds || 0),
        estimatedUnlockTimeIso: new Date(Date.now() + estimatedRemainingSeconds * 1000).toISOString(),
        selectedOutpoint: selected.outpoint,
        selectedAmountSompi: amount.toString(),
        selectedAmountKas: (Number(amount) / 100000000).toString(),
        lockAmountSompi: String(payload.lockAmountSompi || amount.toString()),
        lockAmountKas: (Number(asBigInt(payload.lockAmountSompi || amount)) / 100000000).toString(),
        readyToBroadcast: remainingDaaBlocks === 0,
        remainingDaaBlocks,
        estimatedRemainingSeconds,
        payload,
      });
    }
  }

  const candidatesByOutpoint = new Map();
  for (const candidate of candidates) {
    const outpoint = candidate.selectedOutpoint || {};
    const txId = outpoint.transactionId || outpoint.transaction_id || outpoint.txId;
    candidatesByOutpoint.set(`${txId}:${outpoint.index}`, candidate);
  }
  const uniqueCandidates = Array.from(candidatesByOutpoint.values())
    .sort((a, b) => Number(b.acceptingBlockTime || 0) - Number(a.acceptingBlockTime || 0));

  return Response.json({
    status: uniqueCandidates.length ? "Active vaults found" : "No active time-locked vaults found",
    address,
    count: uniqueCandidates.length,
    vaults: uniqueCandidates,
  });
}

async function scanDeadManSwitchVaults(kaspa, searchParams) {
  const beneficiaryAddress = searchParams.get("beneficiaryAddress");
  const ownerAddress = searchParams.get("ownerAddress");
  const scanAddress = beneficiaryAddress || ownerAddress;
  const scanMode = beneficiaryAddress ? "beneficiary" : "owner";

  if (!scanAddress?.startsWith("kaspa:")) {
    return Response.json({ error: "A valid beneficiary or owner Kaspa address is required." }, { status: 400 });
  }

  const candidates = [];

  for (let page = -1; page < MAX_SCAN_PAGES; page += 1) {
    let transactions;
    if (page === -1) {
      const indexed = await findIndexedVaults(
        scanMode === "beneficiary"
          ? { beneficiaryAddress }
          : { ownerAddress },
      );
      transactions = indexed.map((record) => ({
        transaction_id: record.deployTxId,
        payload: record.payload,
        accepting_block_time: record.acceptingBlockTime,
      }));
    } else {
      const offset = page * SCAN_PAGE_SIZE;
      const response = await fetch(
        kaspaHistoryApiUrl(`/addresses/${scanAddress}/full-transactions?limit=${SCAN_PAGE_SIZE}&offset=${offset}`),
        { cache: "no-store" },
      );

      if (!response.ok) {
        if (candidates.length) break;
        throw new Error("Kaspa archival transaction history API returned an error for this address.");
      }

      transactions = await response.json();
      if (!Array.isArray(transactions) || transactions.length === 0) break;
    }

    for (const transaction of transactions) {
      const payload = parseJsonPayload(transaction?.payload);
      if (
        !payload ||
        payload.p !== VAULT_PROTOCOL ||
        payload.v !== VAULT_PAYLOAD_VERSION ||
        payload.action !== "dms-create" ||
        (scanMode === "beneficiary" && payload.beneficiaryAddress !== beneficiaryAddress) ||
        (scanMode === "beneficiary" && payload.pinnedBeneficiaryAddress !== beneficiaryAddress) ||
        (scanMode === "owner" && payload.ownerAddress !== ownerAddress) ||
        !payload.vaultAddress?.startsWith("kaspa:") ||
        !payload.unlockTime ||
        !payload.redeemScript ||
        !payload.beneficiaryAddress?.startsWith("kaspa:")
      ) {
        continue;
      }

      await indexVaultCreation({
        deployTxId: transaction.transaction_id,
        payload,
        acceptingBlockTime: transaction.accepting_block_time || transaction.block_time || null,
        source: page === -1 ? "index-refresh" : "history-backfill",
      }).catch(() => null);

      const vault =
        payload.dmsMode === "heartbeat"
          ? makeDeadManSwitchVault(kaspa, BigInt(payload.inactivityDaaBlocks || payload.lockDaaBlocks || 1), payload.beneficiaryAddress, payload.ownerPublicKey)
          : makeTimeLockVault(kaspa, payload.unlockTime, payload.beneficiaryAddress);
      if (vault.address !== payload.vaultAddress || vault.redeemScript !== payload.redeemScript) {
        continue;
      }

      const utxoResponse = await fetch(kaspaApiUrl(`/addresses/${payload.vaultAddress}/utxos`), {
        cache: "no-store",
      });
      if (!utxoResponse.ok) continue;

      const utxos = await utxoResponse.json();
      const activeUtxos = spendableUtxos(utxos);
      if (!activeUtxos.length) continue;

      const currentBlueScore = await getCurrentBlueScore();
      const inactivityDaaBlocks = Number(payload.inactivityDaaBlocks || payload.lockDaaBlocks || 0);
      const latestPulse = payload.dmsMode === "heartbeat" ? await findLatestDeadManSwitchPulse(payload.beneficiaryAddress, payload.vaultAddress) : null;
      const lastPulseBlueScore = Number(latestPulse?.payload?.pulsedBlueScore || 0);
      const timerStartBlueScore = Number(payload.createdBlueScore || currentBlueScore);

      for (const selected of activeUtxos) {
        const sequenceStartBlueScore = Number(selected?.utxoEntry?.blockDaaScore || 0);
        const claimStartBlueScore =
          payload.dmsMode === "heartbeat"
            ? Math.max(timerStartBlueScore, sequenceStartBlueScore || timerStartBlueScore)
            : timerStartBlueScore;
        const remainingDaaBlocks =
          payload.dmsMode === "heartbeat"
            ? Math.max(0, claimStartBlueScore + inactivityDaaBlocks - currentBlueScore)
            : Math.max(0, Number(payload.unlockTime) - currentBlueScore);
        const estimatedRemainingSeconds = Math.ceil(remainingDaaBlocks / MAINNET_BLOCKS_PER_SECOND);
        const amount = asBigInt(selected?.utxoEntry?.amount);

        candidates.push({
          status: "Claimable dead-man-switch vault found",
          dmsMode: payload.dmsMode || "absolute-time-lock",
          vaultName: payload.vaultName || "Dead Man's Switch",
          beneficiaryAddress: payload.beneficiaryAddress,
          ownerAddress: payload.ownerAddress || null,
          ownerPublicKey: payload.ownerPublicKey || null,
          deployTxId: transaction.transaction_id,
          acceptingBlockTime: transaction.accepting_block_time || transaction.block_time || null,
          vault,
          currentBlueScore,
          timerStartBlueScore,
          claimStartBlueScore,
          sequenceStartBlueScore: sequenceStartBlueScore || null,
          lastPulseBlueScore: lastPulseBlueScore || null,
          lastPulseTxId: latestPulse?.transaction?.transaction_id || null,
          inactivityDaaBlocks,
          lockDaaBlocks: Number(payload.lockDaaBlocks || 0),
          lockSeconds: Number(payload.lockSeconds || 0),
          estimatedUnlockTimeIso: new Date(Date.now() + estimatedRemainingSeconds * 1000).toISOString(),
          selectedOutpoint: selected.outpoint,
          selectedAmountSompi: amount.toString(),
          selectedAmountKas: (Number(amount) / 100000000).toString(),
          lockAmountSompi: String(payload.lockAmountSompi || amount.toString()),
          lockAmountKas: (Number(asBigInt(payload.lockAmountSompi || amount)) / 100000000).toString(),
          readyToBroadcast: remainingDaaBlocks === 0,
          remainingDaaBlocks,
          estimatedRemainingSeconds,
          payload,
        });
      }
    }
  }

  const candidatesByOutpoint = new Map();
  for (const candidate of candidates) {
    const outpoint = candidate.selectedOutpoint || {};
    const txId = outpoint.transactionId || outpoint.transaction_id || outpoint.txId;
    const key = `${txId}:${outpoint.index}`;
    const existing = candidatesByOutpoint.get(key);
    const candidateMatchesOutpoint = candidate.deployTxId === txId;
    const existingMatchesOutpoint = existing?.deployTxId === txId;

    if (!existing || (candidateMatchesOutpoint && !existingMatchesOutpoint)) {
      candidatesByOutpoint.set(key, candidate);
    }
  }

  const uniqueCandidates = Array.from(candidatesByOutpoint.values()).sort(
    (a, b) => Number(b.acceptingBlockTime || 0) - Number(a.acceptingBlockTime || 0),
  );

  return Response.json({
    status: uniqueCandidates.length ? "Claimable dead-man-switch vaults found" : "No claimable dead-man-switch vaults found",
    address: scanAddress,
    beneficiaryAddress: beneficiaryAddress || null,
    ownerAddress: ownerAddress || null,
    scanMode,
    count: uniqueCandidates.length,
    vaults: uniqueCandidates,
  });
}

async function createDeadManSwitchReleaseDraft(kaspa, searchParams) {
  const beneficiaryAddress = searchParams.get("beneficiaryAddress");
  const vaultAddress = searchParams.get("vaultAddress");
  const unlockTime = searchParams.get("unlockTime");
  const inactivityDaaBlocks = searchParams.get("inactivityDaaBlocks");
  const ownerPublicKey = normalizeSchnorrPublicKey(searchParams.get("ownerPublicKey"));
  const createdBlueScore = Number(searchParams.get("createdBlueScore") || 0);
  const lastPulseBlueScore = Number(searchParams.get("lastPulseBlueScore") || 0);
  const outpointTxId = searchParams.get("outpointTxId");
  const outpointIndex = searchParams.get("outpointIndex");
  const redeemScript = String(searchParams.get("redeemScript") || "").replace(/^0x/i, "");
  const isHeartbeatVault = Boolean(inactivityDaaBlocks && ownerPublicKey);

  if (!beneficiaryAddress?.startsWith("kaspa:")) {
    return Response.json({ error: "A valid beneficiary Kaspa address is required." }, { status: 400 });
  }

  if (!vaultAddress?.startsWith("kaspa:") || !redeemScript || (!unlockTime && !isHeartbeatVault)) {
    return Response.json({ error: "Vault address, unlock timing and redeem script are required." }, { status: 400 });
  }

  const vault = isHeartbeatVault
    ? makeDeadManSwitchVault(kaspa, BigInt(inactivityDaaBlocks), beneficiaryAddress, ownerPublicKey)
    : makeTimeLockVault(kaspa, unlockTime, beneficiaryAddress);
  if (vault.address !== vaultAddress || vault.redeemScript !== redeemScript) {
    return Response.json({ error: "Vault address does not match the provided pinned beneficiary, unlock script or time." }, { status: 400 });
  }

  const currentBlueScore = await getCurrentBlueScore();
  const utxoResponse = await fetch(kaspaApiUrl(`/addresses/${vaultAddress}/utxos`), { cache: "no-store" });
  if (!utxoResponse.ok) {
    throw new Error("Kaspa UTXO API returned an error for the dead-man-switch vault address.");
  }

  const selected = pickVaultUtxo(await utxoResponse.json(), outpointTxId, outpointIndex);
  if (!selected) {
    return Response.json({ error: "No spendable dead-man-switch vault UTXO found yet. Wait for indexing and try again." }, { status: 400 });
  }

  const sequenceStartBlueScore = Number(selected?.utxoEntry?.blockDaaScore || 0);
  const timerStartBlueScore = isHeartbeatVault
    ? Math.max(lastPulseBlueScore || createdBlueScore || currentBlueScore, sequenceStartBlueScore || 0)
    : lastPulseBlueScore || createdBlueScore || currentBlueScore;
  const remainingDaaBlocks = isHeartbeatVault
    ? Math.max(0, timerStartBlueScore + Number(inactivityDaaBlocks) - currentBlueScore)
    : Math.max(0, Number(unlockTime) - currentBlueScore);
  if (remainingDaaBlocks > 0) {
    return Response.json(
      {
        error: "Dead-man-switch is still locked. The selected vault UTXO has not met its sequence-lock yet.",
        currentBlueScore,
        unlockTime: isHeartbeatVault ? String(timerStartBlueScore + Number(inactivityDaaBlocks)) : unlockTime,
        readyToBroadcast: false,
        remainingDaaBlocks,
        estimatedRemainingSeconds: Math.ceil(remainingDaaBlocks / MAINNET_BLOCKS_PER_SECOND),
        sequenceStartBlueScore: isHeartbeatVault ? sequenceStartBlueScore : null,
      },
      { status: 400 },
    );
  }

  const outpoint = selected.outpoint;
  const utxoEntry = selected.utxoEntry;
  const amount = asBigInt(utxoEntry.amount);
  const vaultScriptPublicKey = makeScriptPublicKey(kaspa, utxoEntry.scriptPublicKey);
  const beneficiaryScript = kaspa.payToAddressScript(beneficiaryAddress);
  const input = {
    previousOutpoint: outpoint,
    sequence: isHeartbeatVault ? BigInt(inactivityDaaBlocks) : 0n,
    sigOpCount: 0,
    computeBudget: 1000,
    signatureScript: vault.unlockScript,
    utxo: {
      address: vaultAddress,
      outpoint,
      amount,
      scriptPublicKey: vaultScriptPublicKey,
      blockDaaScore: asBigInt(utxoEntry.blockDaaScore),
      isCoinbase: Boolean(utxoEntry.isCoinbase),
    },
  };
  const provisional = new kaspa.Transaction({
    version: 1,
    inputs: [input],
    outputs: [new kaspa.TransactionOutput(amount - MIN_RETURN_SOMPI, beneficiaryScript)],
    lockTime: isHeartbeatVault ? 0n : BigInt(unlockTime),
    gas: 0n,
    payload: "",
    subnetworkId: "0000000000000000000000000000000000000000",
  });
  const fee = estimateFee(kaspa, provisional);
  const returnAmount = amount - fee;

  if (fee > KEYLESS_MAX_FEE_SOMPI) {
    return Response.json(
      {
        error: "Estimated network fee exceeds the dead-man-switch consensus fee cap. Retry later.",
        estimatedFeeSompi: fee.toString(),
        maxFeeSompi: KEYLESS_MAX_FEE_SOMPI.toString(),
      },
      { status: 400 },
    );
  }

  if (returnAmount <= MIN_RETURN_SOMPI) {
    return Response.json(
      {
        error: "Vault UTXO is too small to release with the estimated Toccata fee.",
        amountSompi: amount.toString(),
        estimatedFeeSompi: fee.toString(),
      },
      { status: 400 },
    );
  }

  const transaction = new kaspa.Transaction({
    version: 1,
    inputs: [input],
    outputs: [new kaspa.TransactionOutput(returnAmount, beneficiaryScript)],
    lockTime: isHeartbeatVault ? 0n : BigInt(unlockTime),
    gas: 0n,
    payload: "",
    subnetworkId: "0000000000000000000000000000000000000000",
  });

  return Response.json({
    status: "Dead-man-switch release transaction ready",
    beneficiaryAddress,
    vaultAddress,
    unlockTime,
    inactivityDaaBlocks: isHeartbeatVault ? String(inactivityDaaBlocks) : null,
    timerStartBlueScore: isHeartbeatVault ? timerStartBlueScore : null,
    sequenceStartBlueScore: isHeartbeatVault ? sequenceStartBlueScore : null,
    currentBlueScore,
    readyToBroadcast: true,
    selectedOutpoint: outpoint,
    selectedAmountSompi: amount.toString(),
    selectedAmountKas: (Number(amount) / 100000000).toString(),
    estimatedFeeSompi: fee.toString(),
    estimatedFeeKas: (Number(fee) / 100000000).toString(),
    maxFeeSompi: KEYLESS_MAX_FEE_SOMPI.toString(),
    returnAmountSompi: returnAmount.toString(),
    returnAmountKas: (Number(returnAmount) / 100000000).toString(),
    redeemScript,
    unlockScript: vault.unlockScript,
    tx: JSON.parse(transaction.serializeToSafeJSON()),
    txJson: transaction.serializeToSafeJSON(),
  });
}

async function createDeadManSwitchHeartbeatDraft(kaspa, searchParams) {
  const ownerAddress = searchParams.get("address");
  const ownerPublicKey = normalizeSchnorrPublicKey(searchParams.get("publicKey"));
  const beneficiaryAddress = searchParams.get("beneficiaryAddress");
  const vaultAddress = searchParams.get("vaultAddress");
  const inactivityDaaBlocks = searchParams.get("inactivityDaaBlocks");
  const outpointTxId = searchParams.get("outpointTxId");
  const outpointIndex = searchParams.get("outpointIndex");
  const redeemScript = String(searchParams.get("redeemScript") || "").replace(/^0x/i, "");

  if (!isValidKaspaAddress(kaspa, ownerAddress)) {
    return Response.json({ error: "Connect the owner wallet before sending a pulse." }, { status: 400 });
  }

  if (!isValidKaspaAddress(kaspa, beneficiaryAddress) || !vaultAddress?.startsWith("kaspa:") || !ownerPublicKey || !inactivityDaaBlocks || !redeemScript) {
    return Response.json({ error: "Heartbeat requires owner key, beneficiary address, vault address, inactivity timer and redeem script." }, { status: 400 });
  }

  const vault = makeDeadManSwitchVault(kaspa, BigInt(inactivityDaaBlocks), beneficiaryAddress, ownerPublicKey);
  if (vault.address !== vaultAddress || vault.redeemScript !== redeemScript) {
    return Response.json({ error: "This pulse can only refresh the selected owner-signed dead-man-switch vault." }, { status: 400 });
  }

  const [vaultUtxoResponse, ownerUtxoResponse] = await Promise.all([
    fetch(kaspaApiUrl(`/addresses/${vaultAddress}/utxos`), { cache: "no-store" }),
    fetch(kaspaApiUrl(`/addresses/${ownerAddress}/utxos`), { cache: "no-store" }),
  ]);
  if (!vaultUtxoResponse.ok || !ownerUtxoResponse.ok) {
    throw new Error("Kaspa UTXO API returned an error while preparing the on-chain heartbeat.");
  }

  const vaultSelected = pickVaultUtxo(await vaultUtxoResponse.json(), outpointTxId, outpointIndex);
  const ownerSelected = pickSpendableUtxo(await ownerUtxoResponse.json(), MIN_RETURN_SOMPI + FEE_SAFETY_BUFFER_SOMPI);
  if (!vaultSelected) {
    return Response.json({ error: "The selected dead-man-switch vault UTXO is no longer spendable. Scan again." }, { status: 400 });
  }
  if (!ownerSelected) {
    return Response.json({ error: "The owner wallet needs a spendable KAS UTXO to pay the on-chain heartbeat fee." }, { status: 400 });
  }

  const vaultEntry = vaultSelected.utxoEntry;
  const vaultAmount = asBigInt(vaultEntry.amount);
  const ownerEntry = ownerSelected.utxoEntry;
  const ownerAmount = asBigInt(ownerEntry.amount);
  const vaultScript = makeScriptPublicKey(kaspa, vaultEntry.scriptPublicKey);
  const expectedVaultScript = kaspa.payToAddressScript(vaultAddress);
  if (vaultScript.toString() !== expectedVaultScript.toString()) {
    return Response.json({ error: "The selected UTXO does not match the reconstructed covenant address." }, { status: 400 });
  }

  const ownerScript = makeScriptPublicKey(kaspa, ownerEntry.scriptPublicKey);
  const ownerChangeScript = kaspa.payToAddressScript(ownerAddress);
  const currentBlueScore = await getCurrentBlueScore();
  const payload = {
    p: VAULT_PROTOCOL,
    v: VAULT_PAYLOAD_VERSION,
    action: "dms-heartbeat",
    dmsMode: "heartbeat",
    refreshMode: "covenant-utxo-recreation",
    ownerAddress,
    ownerPublicKey,
    beneficiaryAddress,
    vaultAddress,
    inactivityDaaBlocks: String(inactivityDaaBlocks),
    previousVaultOutpoint: vaultSelected.outpoint,
    pulsedBlueScore: currentBlueScore,
    pulsedAtIso: new Date().toISOString(),
  };
  const vaultInput = {
    previousOutpoint: vaultSelected.outpoint,
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: 1000,
    utxo: {
      address: vaultAddress,
      outpoint: vaultSelected.outpoint,
      amount: vaultAmount,
      scriptPublicKey: vaultScript,
      blockDaaScore: asBigInt(vaultEntry.blockDaaScore),
      isCoinbase: Boolean(vaultEntry.isCoinbase),
    },
  };
  const ownerInput = {
    previousOutpoint: ownerSelected.outpoint,
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: 10,
    utxo: {
      address: ownerAddress,
      outpoint: ownerSelected.outpoint,
      amount: ownerAmount,
      scriptPublicKey: ownerScript,
      blockDaaScore: asBigInt(ownerEntry.blockDaaScore),
      isCoinbase: Boolean(ownerEntry.isCoinbase),
    },
  };
  const provisional = new kaspa.Transaction({
    version: 1,
    inputs: [vaultInput, ownerInput],
    outputs: [
      new kaspa.TransactionOutput(vaultAmount, expectedVaultScript),
      new kaspa.TransactionOutput(ownerAmount - MIN_RETURN_SOMPI, ownerChangeScript),
    ],
    lockTime: 0n,
    gas: 0n,
    payload: jsonPayloadHex(payload),
    subnetworkId: "0000000000000000000000000000000000000000",
  });
  const fee = estimateFee(kaspa, provisional);
  const ownerChangeAmount = ownerAmount - fee;
  if (ownerChangeAmount <= MIN_RETURN_SOMPI || fee > KEYLESS_MAX_FEE_SOMPI) {
    return Response.json({
      error: "The owner fee UTXO is too small or the estimated heartbeat fee exceeds the covenant safety cap.",
      ownerAmountSompi: ownerAmount.toString(),
      estimatedFeeSompi: fee.toString(),
    }, { status: 400 });
  }

  const transaction = new kaspa.Transaction({
    version: 1,
    inputs: [vaultInput, ownerInput],
    outputs: [
      new kaspa.TransactionOutput(vaultAmount, expectedVaultScript),
      new kaspa.TransactionOutput(ownerChangeAmount, ownerChangeScript),
    ],
    lockTime: 0n,
    gas: 0n,
    payload: jsonPayloadHex(payload),
    subnetworkId: "0000000000000000000000000000000000000000",
  });

  return Response.json({
    status: "On-chain dead-man-switch heartbeat transaction ready",
    branch: "owner-refresh",
    ownerAddress,
    beneficiaryAddress,
    vaultAddress,
    inactivityDaaBlocks: String(inactivityDaaBlocks),
    currentBlueScore,
    previousVaultOutpoint: vaultSelected.outpoint,
    ownerFeeOutpoint: ownerSelected.outpoint,
    vaultAmountSompi: vaultAmount.toString(),
    estimatedFeeSompi: fee.toString(),
    estimatedFeeKas: (Number(fee) / 100000000).toString(),
    ownerChangeAmountSompi: ownerChangeAmount.toString(),
    ownerChangeAmountKas: (Number(ownerChangeAmount) / 100000000).toString(),
    estimatedUnlockTimeIso: new Date(Date.now() + (Number(inactivityDaaBlocks) / MAINNET_BLOCKS_PER_SECOND) * 1000).toISOString(),
    redeemScript,
    payload,
    tx: JSON.parse(transaction.serializeToSafeJSON()),
    txJson: transaction.serializeToSafeJSON(),
  });
}

async function createUnlockDraft(kaspa, searchParams) {
  const address = searchParams.get("address");
  const ownerAddress = searchParams.get("ownerAddress") || address;
  const vaultAddress = searchParams.get("vaultAddress");
  const unlockTime = searchParams.get("unlockTime");
  const redeemScript = String(searchParams.get("redeemScript") || "").replace(/^0x/i, "");

  if (!address?.startsWith("kaspa:")) {
    return Response.json({ error: "A valid destination Kaspa address is required." }, { status: 400 });
  }

  if (address !== ownerAddress) {
    return Response.json({ error: "This vault is pinned to its owner address; unlock destination cannot be changed." }, { status: 400 });
  }

  if (!vaultAddress?.startsWith("kaspa:") || !unlockTime || !redeemScript) {
    return Response.json({ error: "Vault address, unlock time and redeem script are required." }, { status: 400 });
  }

  const vault = makeTimeLockVault(kaspa, unlockTime, ownerAddress);
  if (vault.address !== vaultAddress || vault.redeemScript !== redeemScript) {
    return Response.json({ error: "Vault address does not match the provided pinned owner, unlock script or time." }, { status: 400 });
  }

  const utxoResponse = await fetch(kaspaApiUrl(`/addresses/${vaultAddress}/utxos`), { cache: "no-store" });
  if (!utxoResponse.ok) {
    throw new Error("Kaspa UTXO API returned an error for the vault address.");
  }

  const selected = pickSpendableUtxo(await utxoResponse.json());
  if (!selected) {
    return Response.json({ error: "No spendable vault UTXO found yet. Wait for indexing and try again." }, { status: 400 });
  }

  const outpoint = selected.outpoint;
  const utxoEntry = selected.utxoEntry;
  const amount = asBigInt(utxoEntry.amount);
  const vaultScriptPublicKey = makeScriptPublicKey(kaspa, utxoEntry.scriptPublicKey);
  const destinationScript = kaspa.payToAddressScript(address);
  const input = {
    previousOutpoint: outpoint,
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: 1000,
    signatureScript: vault.unlockScript,
    utxo: {
      address: vaultAddress,
      outpoint,
      amount,
      scriptPublicKey: vaultScriptPublicKey,
      blockDaaScore: asBigInt(utxoEntry.blockDaaScore),
      isCoinbase: Boolean(utxoEntry.isCoinbase),
    },
  };
  const provisional = new kaspa.Transaction({
    version: 1,
    inputs: [input],
    outputs: [new kaspa.TransactionOutput(amount - MIN_RETURN_SOMPI, destinationScript)],
    lockTime: BigInt(unlockTime),
    gas: 0n,
    payload: "",
    subnetworkId: "0000000000000000000000000000000000000000",
  });
  const fee = estimateFee(kaspa, provisional);
  const returnAmount = amount - fee;

  if (returnAmount <= MIN_RETURN_SOMPI) {
    return Response.json(
      {
        error: "Vault UTXO is too small to unlock with the estimated Toccata fee.",
        amountSompi: amount.toString(),
        estimatedFeeSompi: fee.toString(),
      },
      { status: 400 },
    );
  }

  const transaction = new kaspa.Transaction({
    version: 1,
    inputs: [input],
    outputs: [new kaspa.TransactionOutput(returnAmount, destinationScript)],
    lockTime: BigInt(unlockTime),
    gas: 0n,
    payload: "",
    subnetworkId: "0000000000000000000000000000000000000000",
  });

  return Response.json({
    status: "Time-locked vault unlock transaction ready",
    address,
    vaultAddress,
    unlockTime,
    currentBlueScore: await getCurrentBlueScore(),
    selectedOutpoint: outpoint,
    selectedAmountSompi: amount.toString(),
    selectedAmountKas: (Number(amount) / 100000000).toString(),
    estimatedFeeSompi: fee.toString(),
    estimatedFeeKas: (Number(fee) / 100000000).toString(),
    returnAmountSompi: returnAmount.toString(),
    returnAmountKas: (Number(returnAmount) / 100000000).toString(),
    redeemScript,
    unlockScript: vault.unlockScript,
    tx: JSON.parse(transaction.serializeToSafeJSON()),
    txJson: transaction.serializeToSafeJSON(),
  });
}

async function getVaultStatus(searchParams) {
  const unlockTime = Number(searchParams.get("unlockTime") || 0);
  if (!unlockTime) {
    return Response.json({ error: "Unlock time is required." }, { status: 400 });
  }

  const currentBlueScore = await getCurrentBlueScore();
  const remainingDaaBlocks = Math.max(0, unlockTime - currentBlueScore);

  return Response.json({
    currentBlueScore,
    unlockTime,
    readyToBroadcast: remainingDaaBlocks === 0,
    remainingDaaBlocks,
    estimatedRemainingSeconds: Math.ceil(remainingDaaBlocks / MAINNET_BLOCKS_PER_SECOND),
  });
}

async function listWizardVaults(kaspa) {
  const records = await findIndexedVaults({});
  const currentBlueScore = await getCurrentBlueScore();
  const vaults = [];

  for (const record of records) {
    const payload = record.payload;
    if (payload?.action !== "wizard-create" || !payload.unlockTime) continue;

    const vault = makeWizardVault(kaspa, payload.unlockTime);
    if (vault.address !== payload.vaultAddress || vault.redeemScript !== payload.redeemScript) continue;

    const response = await fetch(kaspaApiUrl(`/addresses/${vault.address}/utxos`), { cache: "no-store" });
    if (!response.ok) continue;
    const selected = pickSpendableUtxo(await response.json());
    if (!selected) continue;

    const amount = asBigInt(selected.utxoEntry.amount);
    const remainingDaaBlocks = Math.max(0, Number(payload.unlockTime) - currentBlueScore);
    vaults.push({
      deployTxId: record.deployTxId,
      vaultName: payload.vaultName || "First Come, First Served",
      ownerAddress: payload.ownerAddress,
      vault,
      selectedOutpoint: selected.outpoint,
      amountSompi: amount.toString(),
      amountKas: (Number(amount) / 100000000).toString(),
      lockSeconds: Number(payload.lockSeconds || 0),
      unlockTime: String(payload.unlockTime),
      currentBlueScore,
      remainingDaaBlocks,
      estimatedRemainingSeconds: Math.ceil(remainingDaaBlocks / MAINNET_BLOCKS_PER_SECOND),
      readyToClaim: remainingDaaBlocks === 0,
      createdAtIso: payload.createdAtIso || null,
    });
  }

  vaults.sort((a, b) => Number(a.unlockTime) - Number(b.unlockTime));
  return Response.json({ count: vaults.length, currentBlueScore, vaults });
}

async function createWizardClaimDraft(kaspa, searchParams) {
  const recipientAddress = searchParams.get("recipientAddress");
  const vaultAddress = searchParams.get("vaultAddress");
  const unlockTime = searchParams.get("unlockTime");
  const redeemScript = String(searchParams.get("redeemScript") || "").replace(/^0x/i, "");
  const outpointTxId = searchParams.get("outpointTxId");
  const outpointIndex = searchParams.get("outpointIndex");

  if (!isValidKaspaAddress(kaspa, recipientAddress)) {
    return Response.json({ error: "Connect the Kaspa wallet that should receive the prize." }, { status: 400 });
  }
  if (!vaultAddress?.startsWith("kaspa:") || !unlockTime || !redeemScript) {
    return Response.json({ error: "Vault address, unlock time and redeem script are required." }, { status: 400 });
  }

  const vault = makeWizardVault(kaspa, unlockTime);
  if (vault.address !== vaultAddress || vault.redeemScript !== redeemScript) {
    return Response.json({ error: "Special vault covenant data does not match its address." }, { status: 400 });
  }

  const currentBlueScore = await getCurrentBlueScore();
  const remainingDaaBlocks = Math.max(0, Number(unlockTime) - currentBlueScore);
  if (remainingDaaBlocks > 0) {
    return Response.json({
      error: "This special vault is still locked.",
      currentBlueScore,
      remainingDaaBlocks,
      estimatedRemainingSeconds: Math.ceil(remainingDaaBlocks / MAINNET_BLOCKS_PER_SECOND),
    }, { status: 400 });
  }

  const response = await fetch(kaspaApiUrl(`/addresses/${vaultAddress}/utxos`), { cache: "no-store" });
  if (!response.ok) throw new Error("Kaspa UTXO API returned an error for the special vault.");
  const selected = pickVaultUtxo(await response.json(), outpointTxId, outpointIndex);
  if (!selected) {
    return Response.json({ error: "The prize has already been claimed or is not indexed yet." }, { status: 409 });
  }

  const outpoint = selected.outpoint;
  const utxoEntry = selected.utxoEntry;
  const amount = asBigInt(utxoEntry.amount);
  const input = {
    previousOutpoint: outpoint,
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: 1000,
    signatureScript: vault.unlockScript,
    utxo: {
      address: vaultAddress,
      outpoint,
      amount,
      scriptPublicKey: makeScriptPublicKey(kaspa, utxoEntry.scriptPublicKey),
      blockDaaScore: asBigInt(utxoEntry.blockDaaScore),
      isCoinbase: Boolean(utxoEntry.isCoinbase),
    },
  };
  const recipientScript = kaspa.payToAddressScript(recipientAddress);
  const provisional = new kaspa.Transaction({
    version: 1,
    inputs: [input],
    outputs: [new kaspa.TransactionOutput(amount - MIN_RETURN_SOMPI, recipientScript)],
    lockTime: BigInt(unlockTime),
    gas: 0n,
    payload: "",
    subnetworkId: "0000000000000000000000000000000000000000",
  });
  const fee = estimateFee(kaspa, provisional);
  if (fee > KEYLESS_MAX_FEE_SOMPI) {
    return Response.json({ error: "Estimated fee exceeds the covenant fee cap." }, { status: 400 });
  }
  const prizeAmount = amount - fee;
  if (prizeAmount <= MIN_RETURN_SOMPI) {
    return Response.json({ error: "The prize UTXO is too small to claim." }, { status: 400 });
  }

  const transaction = new kaspa.Transaction({
    version: 1,
    inputs: [input],
    outputs: [new kaspa.TransactionOutput(prizeAmount, recipientScript)],
    lockTime: BigInt(unlockTime),
    gas: 0n,
    payload: "",
    subnetworkId: "0000000000000000000000000000000000000000",
  });

  return Response.json({
    status: "Prize claim transaction ready",
    recipientAddress,
    vaultAddress,
    currentBlueScore,
    readyToBroadcast: true,
    selectedOutpoint: outpoint,
    selectedAmountSompi: amount.toString(),
    selectedAmountKas: (Number(amount) / 100000000).toString(),
    estimatedFeeSompi: fee.toString(),
    prizeAmountSompi: prizeAmount.toString(),
    prizeAmountKas: (Number(prizeAmount) / 100000000).toString(),
    tx: JSON.parse(transaction.serializeToSafeJSON()),
    txJson: transaction.serializeToSafeJSON(),
  });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "create";

  try {
    const kaspa = loadToccataKaspa();
    if (action === "status") return getVaultStatus(searchParams);
    if (action === "wizard-create") return createWizardVaultDraft(kaspa, searchParams);
    if (action === "wizard-list") return listWizardVaults(kaspa);
    if (action === "wizard-claim") return createWizardClaimDraft(kaspa, searchParams);
    if (action === "scan") return scanActiveVaults(kaspa, searchParams);
    if (action === "dms-create") return createDeadManSwitchDraft(kaspa, searchParams);
    if (action === "dms-scan") return scanDeadManSwitchVaults(kaspa, searchParams);
    if (action === "dms-release") return createDeadManSwitchReleaseDraft(kaspa, searchParams);
    if (action === "dms-heartbeat") return createDeadManSwitchHeartbeatDraft(kaspa, searchParams);
    if (action === "unlock") return createUnlockDraft(kaspa, searchParams);
    return createVaultDraft(kaspa, searchParams);
  } catch (error) {
    return Response.json(
      { error: error?.message || "Time-locked vault transaction could not be created." },
      { status: 500 },
    );
  }
}

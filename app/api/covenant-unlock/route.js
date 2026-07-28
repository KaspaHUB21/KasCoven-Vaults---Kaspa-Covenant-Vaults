import path from "path";
import { createRequire } from "module";
import { kaspaApiUrl } from "../../../lib/kaspa-endpoints.js";

const TOCCATA_FEE_RATE = 100n;
const FEE_SAFETY_BUFFER_SOMPI = 50_000n;
const MIN_RETURN_SOMPI = 1_000_000n;
const TOCCATA_UNLOCK_MIN_COMPUTE_MASS = 110_000n;

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

function makeScriptPublicKey(kaspa, scriptPublicKey) {
  const raw = scriptPublicKey?.scriptPublicKey || scriptPublicKey;
  return new kaspa.ScriptPublicKey(0, Buffer.from(raw, "hex"));
}

function normalizeVaultScriptType(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "ecdsa") return "ecdsa";
  if (normalized === "optrue") return "optrue";
  return "schnorr";
}

function makeOwnerVault(kaspa, publicKey, scriptType = "schnorr") {
  if (!publicKey && scriptType !== "optrue") return null;

  const builder = new kaspa.ScriptBuilder();
  if (scriptType === "optrue") {
    builder.addOp(kaspa.Opcodes.OpTrue);
  } else {
    builder.addData(publicKey);
    builder.addOp(scriptType === "ecdsa" ? kaspa.Opcodes.OpCheckSigECDSA : kaspa.Opcodes.OpCheckSig);
  }
  const script = builder.toString();
  const scriptPublicKey = builder.createPayToScriptHashScript();
  const address = kaspa.addressFromScriptPublicKey(scriptPublicKey, "mainnet").toString();

  return {
    address,
    scriptType,
    redeemScript: script,
    unlockScript: scriptType === "optrue" ? builder.encodePayToScriptHashSignatureScript("") : null,
    scriptPublicKey: scriptPublicKey.toJSON(),
  };
}

function pickVaultUtxo(utxos, outpointTxId, outpointIndex) {
  const candidates = Array.isArray(utxos) ? utxos : [];
  const matching = candidates.find((item) => {
    if (!outpointTxId) return false;
    return (
      item?.outpoint?.transactionId === outpointTxId &&
      Number(item?.outpoint?.index) === Number(outpointIndex || 0)
    );
  });

  return (
    matching ||
    candidates
      .filter((item) => asBigInt(item?.utxoEntry?.amount) > MIN_RETURN_SOMPI && !item?.utxoEntry?.isCoinbase)
      .sort((a, b) => Number(asBigInt(b.utxoEntry.amount) - asBigInt(a.utxoEntry.amount)))[0]
  );
}

function estimateTransactionFee(kaspa, transaction) {
  let txMass = 2000n;

  try {
    txMass = BigInt(String(kaspa.calculateTransactionMass("mainnet", transaction, 1) || 0));
  } catch {
    // Keep a conservative fallback when the SDK cannot estimate the unsigned draft.
  }

  return {
    txMass: txMass > TOCCATA_UNLOCK_MIN_COMPUTE_MASS ? txMass : TOCCATA_UNLOCK_MIN_COMPUTE_MASS,
    fee:
      (txMass > TOCCATA_UNLOCK_MIN_COMPUTE_MASS ? txMass : TOCCATA_UNLOCK_MIN_COMPUTE_MASS) *
        TOCCATA_FEE_RATE +
      FEE_SAFETY_BUFFER_SOMPI,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  const publicKey = searchParams.get("publicKey");
  const requestedVaultAddress = searchParams.get("vaultAddress");
  const outpointTxId = searchParams.get("outpointTxId");
  const outpointIndex = searchParams.get("outpointIndex") || "0";
  const vaultScriptType = normalizeVaultScriptType(searchParams.get("vaultScriptType"));

  if (!address?.startsWith("kaspa:")) {
    return Response.json({ error: "A valid owner Kaspa address is required." }, { status: 400 });
  }

  try {
    const kaspa = loadToccataKaspa();
    const ownerVault = makeOwnerVault(kaspa, publicKey, vaultScriptType);
    const vaultAddress = requestedVaultAddress || ownerVault?.address;

    if (!vaultAddress?.startsWith("kaspa:")) {
      return Response.json({ error: "A valid vault address could not be derived." }, { status: 400 });
    }

    const utxoResponse = await fetch(kaspaApiUrl(`/addresses/${vaultAddress}/utxos`), {
      cache: "no-store",
    });

    if (!utxoResponse.ok) {
      throw new Error("Kaspa UTXO API returned an error for the vault address.");
    }

    const utxos = await utxoResponse.json();
    const selected = pickVaultUtxo(utxos, outpointTxId, outpointIndex);

    if (!selected) {
      return Response.json({ error: "No spendable vault UTXO found yet. Wait for indexing and try again." }, { status: 400 });
    }

    const outpoint = selected.outpoint;
    const utxoEntry = selected.utxoEntry;
    const amount = asBigInt(utxoEntry.amount);
    const vaultScriptPublicKey = makeScriptPublicKey(kaspa, utxoEntry.scriptPublicKey);
    const ownerScript = kaspa.payToAddressScript(address);

    const vaultInput = {
      previousOutpoint: outpoint,
      sequence: 0n,
      sigOpCount: 0,
      computeBudget: 1000,
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
      inputs: [vaultInput],
      outputs: [new kaspa.TransactionOutput(amount - MIN_RETURN_SOMPI, ownerScript)],
      lockTime: 0n,
      gas: 0n,
      payload: Buffer.from("GOTHDAG_VAULT_UNLOCK_TEST").toString("hex"),
      subnetworkId: "0000000000000000000000000000000000000000",
    });
    const feeEstimate = estimateTransactionFee(kaspa, provisional);
    const returnAmount = amount - feeEstimate.fee;

    if (returnAmount <= MIN_RETURN_SOMPI) {
      return Response.json(
        {
          error: "Vault UTXO is too small to unlock with the estimated Toccata fee.",
          amountSompi: amount.toString(),
          estimatedFeeSompi: feeEstimate.fee.toString(),
        },
        { status: 400 },
      );
    }

    const unlockTx = new kaspa.Transaction({
      version: 1,
      inputs: [vaultInput],
      outputs: [new kaspa.TransactionOutput(returnAmount, ownerScript)],
      lockTime: 0n,
      gas: 0n,
      payload: Buffer.from("GOTHDAG_VAULT_UNLOCK_TEST").toString("hex"),
      subnetworkId: "0000000000000000000000000000000000000000",
    });

    if (ownerVault?.unlockScript) {
      unlockTx.inputs[0].signatureScript = ownerVault.unlockScript;
    }

    const finalFee = amount - unlockTx.outputs.reduce((total, output) => total + BigInt(String(output.value)), 0n);

    return Response.json({
      address,
      ownerVault,
      vaultScriptType,
      vaultAddress,
      selectedOutpoint: outpoint,
      selectedAmountSompi: amount.toString(),
      selectedAmountKas: (Number(amount) / 100000000).toString(),
      estimatedFeeSompi: finalFee.toString(),
      estimatedFeeKas: (Number(finalFee) / 100000000).toString(),
      returnAmountSompi: returnAmount.toString(),
      returnAmountKas: (Number(returnAmount) / 100000000).toString(),
      redeemScript: ownerVault?.redeemScript || null,
      readyToBroadcast: Boolean(ownerVault?.unlockScript),
      unlockTx: JSON.parse(unlockTx.serializeToSafeJSON()),
      unlockTxJson: unlockTx.serializeToSafeJSON(),
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || "Vault unlock transaction could not be created." },
      { status: 500 },
    );
  }
}

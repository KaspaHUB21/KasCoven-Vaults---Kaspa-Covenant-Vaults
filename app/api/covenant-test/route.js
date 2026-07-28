import path from "path";
import { createRequire } from "module";
import { kaspaApiUrl } from "../../../lib/kaspa-endpoints.js";

const FEE_BUFFER_SOMPI = 10000n;
const COVENANT_OUTPUT_SOMPI = 20_000_000n;
const TOCCATA_FEE_RATE = 100n;
const FEE_SAFETY_BUFFER_SOMPI = 50_000n;
const LOCK_PROTOCOL = "gothdag-holder-lock-v1";

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

function pickSpendableUtxo(utxos) {
  return utxos
    .filter((item) => asBigInt(item?.utxoEntry?.amount) > COVENANT_OUTPUT_SOMPI + FEE_BUFFER_SOMPI * 4n && !item?.utxoEntry?.isCoinbase)
    .sort((a, b) => Number(asBigInt(b.utxoEntry.amount) - asBigInt(a.utxoEntry.amount)))[0];
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

function estimateToccataFee(kaspa, inputAmount, outputAmounts) {
  const storageMass = kaspa.calculateStorageMass(
    "mainnet",
    [Number(inputAmount)],
    outputAmounts.map((amount) => Number(amount)),
  );
  const estimatedMass = BigInt(String(storageMass || 0));
  return {
    storageMass: estimatedMass,
    fee: estimatedMass * TOCCATA_FEE_RATE + FEE_SAFETY_BUFFER_SOMPI,
  };
}

function estimateTransactionFee(kaspa, transaction, fallbackMass) {
  let txMass = fallbackMass;

  try {
    txMass = kaspa.calculateTransactionMass("mainnet", transaction, 1);
  } catch {
    // Keep the storage-mass fallback when the SDK cannot estimate a draft transaction.
  }

  return {
    txMass: BigInt(String(txMass || 0)),
    fee: BigInt(String(txMass || 0)) * TOCCATA_FEE_RATE + FEE_SAFETY_BUFFER_SOMPI,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  const publicKey = searchParams.get("publicKey");
  const nftTicker = searchParams.get("nftTicker");
  const nftId = searchParams.get("nftId");
  const vaultScriptType = normalizeVaultScriptType(searchParams.get("vaultScriptType"));
  const kaspa = loadToccataKaspa();
  const ownerVault = makeOwnerVault(kaspa, publicKey, vaultScriptType);
  const lockAddress = searchParams.get("lockAddress") || ownerVault?.address || address;

  if (!address?.startsWith("kaspa:")) {
    return Response.json({ error: "A valid Kaspa address is required." }, { status: 400 });
  }

  if (!lockAddress.startsWith("kaspa:")) {
    return Response.json({ error: "A valid lock address is required." }, { status: 400 });
  }

  try {
    const utxoResponse = await fetch(kaspaApiUrl(`/addresses/${address}/utxos`), {
      cache: "no-store",
    });

    if (!utxoResponse.ok) {
      throw new Error("Kaspa UTXO API returned an error.");
    }

    const utxos = await utxoResponse.json();
    const selected = pickSpendableUtxo(Array.isArray(utxos) ? utxos : []);

    if (!selected) {
      return Response.json({ error: "No spendable KAS UTXO found for this wallet." }, { status: 400 });
    }

    const outpoint = selected.outpoint;
    const utxoEntry = selected.utxoEntry;
    const amount = asBigInt(utxoEntry.amount);
    const inputScript = makeScriptPublicKey(kaspa, utxoEntry.scriptPublicKey);
    const outputScript = kaspa.payToAddressScript(address);

    const input = {
      previousOutpoint: outpoint,
      sequence: 0n,
      sigOpCount: 1,
      computeBudget: 1000,
      utxo: {
        address,
        outpoint,
        amount,
        scriptPublicKey: inputScript,
        blockDaaScore: asBigInt(utxoEntry.blockDaaScore),
        isCoinbase: Boolean(utxoEntry.isCoinbase),
      },
    };
    const covenantInput = {
      ...input,
      sigOpCount: 0,
    };

    const simplePskt = new kaspa.PSKT(undefined)
      .toConstructor()
      .input(input)
      .output(new kaspa.TransactionOutput(amount - FEE_BUFFER_SOMPI, outputScript))
      .noMoreInputs()
      .noMoreOutputs()
      .serialize();

    const simpleTx = new kaspa.Transaction({
      version: 0,
      inputs: [input],
      outputs: [new kaspa.TransactionOutput(amount - FEE_BUFFER_SOMPI, outputScript)],
      lockTime: 0n,
      gas: 0n,
      payload: "",
      subnetworkId: "0000000000000000000000000000000000000000",
    });

    const covenantTx = new kaspa.Transaction({
      version: 1,
      inputs: [covenantInput],
      outputs: [
        new kaspa.TransactionOutput(COVENANT_OUTPUT_SOMPI, outputScript),
        new kaspa.TransactionOutput(amount - COVENANT_OUTPUT_SOMPI - FEE_BUFFER_SOMPI * 2n, inputScript),
      ],
      lockTime: 0n,
      gas: 0n,
      payload: Buffer.from("GOTHDAG_COVENANT_DRYRUN").toString("hex"),
      subnetworkId: "0000000000000000000000000000000000000000",
    });

    covenantTx.populateGenesisCovenants([new kaspa.GenesisCovenantGroup(0, [0])]);

    const vaultScript = kaspa.payToAddressScript(lockAddress);
    const kasVaultFeeEstimate = estimateToccataFee(kaspa, amount, [
      COVENANT_OUTPUT_SOMPI,
      amount - COVENANT_OUTPUT_SOMPI,
    ]);
    const kasVaultEnvelope = {
      p: "gothdag-kas-vault-v1",
      op: "kas-lock",
      owner: address,
      lockAddress,
      scriptType: vaultScriptType,
      unlock: "owner-signed-vault-spend",
      note: "GOTHDAG_KAS_VAULT_TEST",
    };
    let kasVaultTx = new kaspa.Transaction({
      version: 1,
      inputs: [covenantInput],
      outputs: [
        new kaspa.TransactionOutput(COVENANT_OUTPUT_SOMPI, vaultScript),
        new kaspa.TransactionOutput(amount - COVENANT_OUTPUT_SOMPI - kasVaultFeeEstimate.fee, inputScript),
      ],
      lockTime: 0n,
      gas: 0n,
      payload: Buffer.from(JSON.stringify(kasVaultEnvelope)).toString("hex"),
      subnetworkId: "0000000000000000000000000000000000000000",
    });
    kasVaultTx.populateGenesisCovenants([new kaspa.GenesisCovenantGroup(0, [0])]);

    const kasVaultTxFeeEstimate = estimateTransactionFee(kaspa, kasVaultTx, kasVaultFeeEstimate.storageMass);
    kasVaultTx = new kaspa.Transaction({
      version: 1,
      inputs: [covenantInput],
      outputs: [
        new kaspa.TransactionOutput(COVENANT_OUTPUT_SOMPI, vaultScript),
        new kaspa.TransactionOutput(amount - COVENANT_OUTPUT_SOMPI - kasVaultTxFeeEstimate.fee, inputScript),
      ],
      lockTime: 0n,
      gas: 0n,
      payload: Buffer.from(JSON.stringify(kasVaultEnvelope)).toString("hex"),
      subnetworkId: "0000000000000000000000000000000000000000",
    });
    kasVaultTx.populateGenesisCovenants([new kaspa.GenesisCovenantGroup(0, [0])]);

    let nftVaultTx = null;
    let nftVaultEnvelope = null;

    if (nftTicker && nftId) {
      const nftFeeEstimate = estimateToccataFee(kaspa, amount, [
        COVENANT_OUTPUT_SOMPI,
        amount - COVENANT_OUTPUT_SOMPI,
      ]);

      nftVaultEnvelope = {
        p: LOCK_PROTOCOL,
        op: "holder-lock",
        assetProtocol: "krc-721",
        tick: String(nftTicker).toUpperCase(),
        id: String(nftId),
        owner: address,
        lockAddress,
        unlock: "owner-signed-covenant-spend",
        note: "GOTHDAG_NON_CUSTODIAL_LOCK_TEST",
      };

      nftVaultTx = new kaspa.Transaction({
        version: 1,
        inputs: [covenantInput],
        outputs: [
          new kaspa.TransactionOutput(COVENANT_OUTPUT_SOMPI, vaultScript),
          new kaspa.TransactionOutput(amount - COVENANT_OUTPUT_SOMPI - nftFeeEstimate.fee, inputScript),
        ],
        lockTime: 0n,
        gas: 0n,
        payload: Buffer.from(JSON.stringify(nftVaultEnvelope)).toString("hex"),
        subnetworkId: "0000000000000000000000000000000000000000",
      });
      nftVaultTx.populateGenesisCovenants([new kaspa.GenesisCovenantGroup(0, [0])]);

      const txFeeEstimate = estimateTransactionFee(kaspa, nftVaultTx, nftFeeEstimate.storageMass);
      nftVaultTx = new kaspa.Transaction({
        version: 1,
        inputs: [covenantInput],
        outputs: [
          new kaspa.TransactionOutput(COVENANT_OUTPUT_SOMPI, vaultScript),
          new kaspa.TransactionOutput(amount - COVENANT_OUTPUT_SOMPI - txFeeEstimate.fee, inputScript),
        ],
        lockTime: 0n,
        gas: 0n,
        payload: Buffer.from(JSON.stringify(nftVaultEnvelope)).toString("hex"),
        subnetworkId: "0000000000000000000000000000000000000000",
      });
      nftVaultTx.populateGenesisCovenants([new kaspa.GenesisCovenantGroup(0, [0])]);
    }

    const nftVaultStorageMass = nftVaultTx
      ? kaspa.calculateStorageMass(
          "mainnet",
          [Number(amount)],
          [Number(COVENANT_OUTPUT_SOMPI), Number(nftVaultTx.outputs[1].value)],
        )?.toString()
      : null;
    const nftVaultTransactionMass = nftVaultTx
      ? (() => {
          try {
            return kaspa.calculateTransactionMass("mainnet", nftVaultTx, 1).toString();
          } catch {
            return null;
          }
        })()
      : null;
    const nftVaultFeeSompi = nftVaultTx
      ? (
          amount -
          nftVaultTx.outputs.reduce((total, output) => total + BigInt(String(output.value)), 0n)
        ).toString()
      : null;

    let covenantPsktError = null;
    try {
      new kaspa.PSKT(covenantTx).serialize();
    } catch (error) {
      covenantPsktError = error?.message || String(error);
    }

    return Response.json({
      address,
      selectedOutpoint: outpoint,
      selectedAmountSompi: amount.toString(),
      ownerVault,
      kasVaultEnvelope,
      kasVaultOutputSompi: COVENANT_OUTPUT_SOMPI.toString(),
      kasVaultOutputKas: (Number(COVENANT_OUTPUT_SOMPI) / 100000000).toString(),
      kasVaultFeeSompi: (
        amount -
        kasVaultTx.outputs.reduce((total, output) => total + BigInt(String(output.value)), 0n)
      ).toString(),
      kasVaultFeeKas: (
        Number(
          amount -
            kasVaultTx.outputs.reduce((total, output) => total + BigInt(String(output.value)), 0n),
        ) / 100000000
      ).toString(),
      kasVaultTx: JSON.parse(kasVaultTx.serializeToSafeJSON()),
      kasVaultTxJson: kasVaultTx.serializeToSafeJSON(),
      simplePskt,
      simpleTxJson: simpleTx.serializeToSafeJSON(),
      simplePsktNote:
        "This PSKT returns the selected UTXO back to the same wallet minus a tiny fee buffer. The test page only asks Kasware to sign it and does not broadcast it.",
      covenantTx: JSON.parse(covenantTx.serializeToSafeJSON()),
      covenantTxJson: covenantTx.serializeToSafeJSON(),
      covenantPsktError,
      nftVaultEnvelope,
      nftVaultOutputSompi: COVENANT_OUTPUT_SOMPI.toString(),
      nftVaultOutputKas: (Number(COVENANT_OUTPUT_SOMPI) / 100000000).toString(),
      nftVaultStorageMass,
      nftVaultTransactionMass,
      nftVaultFeeSompi,
      nftVaultFeeKas: nftVaultFeeSompi ? (Number(nftVaultFeeSompi) / 100000000).toString() : null,
      nftVaultTx: nftVaultTx ? JSON.parse(nftVaultTx.serializeToSafeJSON()) : null,
      nftVaultTxJson: nftVaultTx ? nftVaultTx.serializeToSafeJSON() : null,
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || "Covenant test data could not be created." },
      { status: 500 },
    );
  }
}

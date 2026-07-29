import path from "path";
import { createRequire } from "module";
import { KASPA_WRPC } from "../../../lib/kaspa-endpoints.js";
import { indexVaultCreation, parseVaultPayload } from "../../../lib/vault-index.js";
import { acquireConcurrency, enforceRateLimit, enforceSameOrigin, readJsonBody } from "../../../lib/api-security.js";

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

function timeoutAfter(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function scriptPublicKeyJson(scriptPublicKey) {
  const value = typeof scriptPublicKey?.toJSON === "function"
    ? scriptPublicKey.toJSON()
    : scriptPublicKey;
  return {
    version: Number(value?.version ?? 0),
    script: String(value?.script ?? value?.scriptPublicKey ?? "").toLowerCase(),
  };
}

function verifyVaultCreation(kaspa, transaction, payload) {
  if (!payload || !["create", "dms-create", "wizard-create"].includes(payload.action)) {
    return false;
  }

  let expectedScript;
  let expectedAmount;
  try {
    expectedScript = scriptPublicKeyJson(kaspa.payToAddressScript(payload.vaultAddress));
    expectedAmount = BigInt(String(payload.lockAmountSompi));
  } catch {
    return false;
  }
  if (expectedAmount <= 0n) return false;

  const hasCommittedVaultOutput = Array.from(transaction.outputs || []).some((output) => {
    const script = scriptPublicKeyJson(output?.scriptPublicKey);
    return (
      BigInt(String(output?.value ?? output?.amount ?? 0)) === expectedAmount &&
      script.version === expectedScript.version &&
      script.script === expectedScript.script
    );
  });
  const spendsFromOwner = Array.from(transaction.inputs || []).some(
    (input) => String(input?.utxo?.address || "") === payload.ownerAddress,
  );

  return hasCommittedVaultOutput && spendsFromOwner;
}

async function connectRpc(kaspa) {
  const candidates = [];
  if (KASPA_WRPC) {
    candidates.push({
      transport: "configured-wrpc",
      create: () => new kaspa.RpcClient({
        url: KASPA_WRPC,
        encoding: kaspa.Encoding.Borsh,
        networkId: "mainnet",
      }),
    });
  }
  candidates.push({
    transport: "public-wrpc-resolver",
    create: () => new kaspa.RpcClient({
      resolver: new kaspa.Resolver(),
      encoding: kaspa.Encoding.Borsh,
      networkId: "mainnet",
    }),
  });

  const connectionErrors = [];
  for (const candidate of candidates) {
    const client = candidate.create();
    try {
      await Promise.race([
        client.connect(),
        timeoutAfter(10_000, "Kaspa " + candidate.transport + " connection timed out."),
      ]);
      return { rpc: client, transport: candidate.transport, connectionErrors };
    } catch (error) {
      await client.disconnect().catch(() => null);
      connectionErrors.push(candidate.transport + ": " + (error && error.message ? error.message : String(error)));
    }
  }
  throw new Error("No Kaspa wRPC endpoint could be reached. " + connectionErrors.join(" | "));
}

export async function POST(request) {
  let debug = null;
  let rpc = null;
  const originError = enforceSameOrigin(request);
  if (originError) return originError;
  const rateError = enforceRateLimit(request, "broadcast", 12);
  if (rateError) return rateError;
  const release = acquireConcurrency("broadcast", 4);
  if (!release) return Response.json({ error: "The transaction relay is busy. Retry shortly." }, { status: 503 });

  try {
    const body = await readJsonBody(request);
    const signedTxJson = body?.signedTxJson;
    const redeemScript = typeof body?.redeemScript === "string" ? body.redeemScript.replace(/^0x/i, "") : "";
    const branch = typeof body?.branch === "string" ? body.branch : "";

    if (!signedTxJson || typeof signedTxJson !== "string") {
      return Response.json({ error: "signedTxJson is required." }, { status: 400 });
    }

    const kaspa = loadToccataKaspa();
    const transaction = kaspa.Transaction.deserializeFromSafeJSON(signedTxJson);

    if (redeemScript && transaction.inputs?.[0]) {
      const signatureScript = String(transaction.inputs[0].signatureScript || "");
      const redeemPush = new kaspa.ScriptBuilder().addData(Buffer.from(redeemScript, "hex")).drain();
      const branchPush =
        branch === "owner-refresh"
          ? new kaspa.ScriptBuilder().addI64(1n).drain()
          : "";

      if (!signatureScript.endsWith(redeemPush)) {
        transaction.inputs[0].signatureScript = `${signatureScript}${branchPush}${redeemPush}`;
      } else if (branchPush && !signatureScript.endsWith(`${branchPush}${redeemPush}`)) {
        transaction.inputs[0].signatureScript = `${signatureScript.slice(0, -redeemPush.length)}${branchPush}${redeemPush}`;
      }

      debug = {
        redeemScriptBytes: Buffer.from(redeemScript, "hex").length,
        originalSignatureScriptBytes: Buffer.from(signatureScript, "hex").length,
        finalSignatureScriptBytes: Buffer.from(String(transaction.inputs[0].signatureScript || ""), "hex").length,
        redeemScriptWasAppended: !signatureScript.endsWith(redeemPush),
        branch,
        inputSigOpCount: transaction.inputs[0].sigOpCount,
        txVersion: transaction.version,
      };
    }

    const connection = await connectRpc(kaspa);
    rpc = connection.rpc;
    debug = {
      ...(debug || {}),
      rpcTransport: connection.transport,
      connectionFallbacks: connection.connectionErrors,
    };

    try {
      const result = await Promise.race([
        rpc.submitTransaction({ transaction, allowOrphan: false }),
        timeoutAfter(25_000, "Kaspa RPC did not confirm the broadcast in time. This is usually a temporary network/RPC delay, not a vault bug. Wait a moment, check your wallet or explorer, then retry if no transaction appears."),
      ]);
      const transactionId = result?.transactionId || result;
      const vaultPayload = parseVaultPayload(transaction.payload);
      let vaultIndexed = false;
      let vaultIndexError = null;

      if (vaultPayload) {
        if (!verifyVaultCreation(kaspa, transaction, vaultPayload)) {
          vaultIndexError = "Vault metadata did not match a committed transaction output and was not indexed.";
        } else {
          try {
            vaultIndexed = await indexVaultCreation({
              deployTxId: transactionId,
              payload: vaultPayload,
              source: "verified-broadcast",
            });
          } catch (error) {
            vaultIndexError = error?.message || String(error);
          }
        }
      }

      return Response.json({
        ok: true,
        txId: transactionId,
        result,
        transport: connection.transport,
        vaultIndexed,
        vaultIndexError,
      });
    } finally {
      await rpc.disconnect().catch(() => null);
    }
  } catch (error) {
    await rpc?.disconnect?.().catch(() => null);

    const message = error?.message || "Signed transaction could not be broadcast.";
    const timedOut = /timed out|did not confirm/i.test(message);

    return Response.json(
      { error: message, debug },
      { status: error?.status || (timedOut ? 504 : 500) },
    );
  } finally {
    release();
  }
}

import path from "path";
import { createRequire } from "module";
import { KASPA_WRPC } from "../../../lib/kaspa-endpoints.js";

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

export async function POST(request) {
  let debug = null;
  let rpc = null;

  try {
    const body = await request.json();
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

    rpc = new kaspa.RpcClient({
      url: KASPA_WRPC,
      encoding: kaspa.Encoding.Borsh,
      networkId: "mainnet",
    });

    await Promise.race([
      rpc.connect(),
      timeoutAfter(10_000, "Kaspa RPC connection timed out. Please wait a moment and try broadcasting again."),
    ]);

    try {
      const result = await Promise.race([
        rpc.submitTransaction({ transaction, allowOrphan: false }),
        timeoutAfter(25_000, "Kaspa RPC did not confirm the broadcast in time. This is usually a temporary network/RPC delay, not a vault bug. Wait a moment, check your wallet or explorer, then retry if no transaction appears."),
      ]);

      return Response.json({
        ok: true,
        txId: result?.transactionId || result,
        result,
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
      { status: timedOut ? 504 : 500 },
    );
  }
}

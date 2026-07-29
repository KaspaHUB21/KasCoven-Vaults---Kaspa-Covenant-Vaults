function scriptPublicKeyJson(scriptPublicKey) {
  const value = typeof scriptPublicKey?.toJSON === "function"
    ? scriptPublicKey.toJSON()
    : scriptPublicKey;
  return {
    version: Number(value?.version ?? 0),
    script: String(value?.script ?? value?.scriptPublicKey ?? "").toLowerCase(),
  };
}

export function verifyVaultCreationTransaction(kaspa, transaction, payload) {
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
    try {
      const script = scriptPublicKeyJson(output?.scriptPublicKey);
      return (
        BigInt(String(output?.value ?? output?.amount ?? 0)) === expectedAmount &&
        script.version === expectedScript.version &&
        script.script === expectedScript.script
      );
    } catch {
      return false;
    }
  });
  const spendsFromOwner = Array.from(transaction.inputs || []).some(
    (input) => String(input?.utxo?.address || "") === payload.ownerAddress,
  );

  return hasCommittedVaultOutput && spendsFromOwner;
}

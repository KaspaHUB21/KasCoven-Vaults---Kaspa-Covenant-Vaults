"use client";

import { useEffect, useMemo, useState } from "react";
import { connectKaspire, restoreKaspire } from "../../lib/kaspire-wallet";

function shortAddress(address) {
  return address ? `${address.slice(0, 12)}…${address.slice(-8)}` : "Not connected";
}

function formatCountdown(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds || 0)));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remaining = value % 60;
  return `${hours ? `${hours}h ` : ""}${String(minutes).padStart(2, "0")}m ${String(remaining).padStart(2, "0")}s`;
}

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || "Request failed.");
  return data;
}

export default function WizardPage() {
  const [wallet, setWallet] = useState(null);
  const [walletName, setWalletName] = useState("");
  const [address, setAddress] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [kaspireAction, setKaspireAction] = useState(null);
  const [vaultName, setVaultName] = useState("The Wizard's Prize");
  const [amountKas, setAmountKas] = useState("1");
  const [lockSeconds, setLockSeconds] = useState("300");
  const [vaults, setVaults] = useState([]);
  const [loadingVaults, setLoadingVaults] = useState(true);
  const [createState, setCreateState] = useState(null);
  const [claimState, setClaimState] = useState({});
  const [now, setNow] = useState(Date.now());

  const connectedLabel = useMemo(
    () => address ? `${walletName} · ${shortAddress(address)}` : "Connect Wallet",
    [address, walletName],
  );

  async function applyWallet(nextWallet, name) {
    const accounts = name === "Kasware"
      ? await nextWallet.getAccounts()
      : await nextWallet.requestAccounts();
    const nextAddress = typeof accounts?.[0] === "string" ? accounts[0] : accounts?.[0]?.address;
    if (!nextAddress?.startsWith("kaspa:")) throw new Error(`${name} returned no Kaspa Mainnet address.`);
    const nextPublicKey = await nextWallet.getPublicKey().catch(() => "");
    setWallet(nextWallet);
    setWalletName(name);
    setAddress(nextAddress);
    setPublicKey(nextPublicKey);
    setWalletMenuOpen(false);
  }

  async function connectWithKaspire() {
    try {
      const nextWallet = await connectKaspire({ onDisplayUri: setPairing });
      setPairing(null);
      await applyWallet(nextWallet, "Kaspire");
    } catch (error) {
      setCreateState({ error: error?.message || String(error) });
    }
  }

  async function connectWithKasware() {
    try {
      if (!window.kasware) throw new Error("Kasware is not installed in this browser.");
      const accounts = await window.kasware.requestAccounts();
      if (!accounts?.length) throw new Error("Kasware returned no account.");
      await applyWallet(window.kasware, "Kasware");
    } catch (error) {
      setCreateState({ error: error?.message || String(error) });
    }
  }

  async function loadVaults() {
    try {
      const data = await readResponse(await fetch("/api/timelock-vault?action=wizard-list", { cache: "no-store" }));
      const loadedAt = Date.now();
      setVaults(Array.isArray(data.vaults) ? data.vaults.map((vault) => ({ ...vault, _loadedAt: loadedAt })) : []);
    } catch (error) {
      setClaimState((current) => ({ ...current, list: { error: error?.message || String(error) } }));
    } finally {
      setLoadingVaults(false);
    }
  }

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const refresh = window.setInterval(loadVaults, 15_000);
    const handleAction = (event) => setKaspireAction(event.detail?.active ? event.detail : null);
    window.addEventListener("vaults:kaspireAction", handleAction);
    loadVaults();

    (async () => {
      try {
        const restored = await restoreKaspire();
        if (restored) return await applyWallet(restored, "Kaspire");
        if (window.kasware?.getAccounts) {
          const accounts = await window.kasware.getAccounts();
          if (accounts?.length) await applyWallet(window.kasware, "Kasware");
        }
      } catch {
        // A disconnected wallet is a normal initial state.
      }
    })();

    return () => {
      window.clearInterval(tick);
      window.clearInterval(refresh);
      window.removeEventListener("vaults:kaspireAction", handleAction);
    };
  }, []);

  async function createVault() {
    setCreateState({ loading: true });
    try {
      if (!wallet || !address || !publicKey) throw new Error("Connect a wallet before creating a prize.");
      const params = new URLSearchParams({ action: "wizard-create", address, vaultName, amountKas, lockSeconds });
      const draft = await readResponse(await fetch(`/api/timelock-vault?${params}`, { cache: "no-store" }));
      const signed = await wallet.signPskt({
        txJsonString: draft.txJson,
        options: {
          autoFinalized: false,
          autoFinalize: false,
          toSignInputs: [{ index: 0, address, publicKey }],
        },
      });
      const broadcast = await readResponse(await fetch("/api/covenant-broadcast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTxJson: signed }),
      }));
      setCreateState({ ok: true, draft, broadcast });
      window.setTimeout(loadVaults, 2500);
    } catch (error) {
      setCreateState({ error: error?.message || String(error) });
    }
  }

  async function claimVault(vault) {
    const key = vault.deployTxId;
    setClaimState((current) => ({ ...current, [key]: { loading: true } }));
    try {
      if (!address) throw new Error("Connect the wallet that should receive the prize.");
      const outpoint = vault.selectedOutpoint || {};
      const params = new URLSearchParams({
        action: "wizard-claim",
        recipientAddress: address,
        vaultAddress: vault.vault.address,
        unlockTime: vault.unlockTime,
        redeemScript: vault.vault.redeemScript,
        outpointTxId: outpoint.transactionId || outpoint.transaction_id || outpoint.txId || "",
        outpointIndex: String(outpoint.index ?? ""),
      });
      const draft = await readResponse(await fetch(`/api/timelock-vault?${params}`, { cache: "no-store" }));
      const broadcast = await readResponse(await fetch("/api/covenant-broadcast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTxJson: draft.txJson }),
      }));
      setClaimState((current) => ({ ...current, [key]: { ok: true, draft, broadcast } }));
      await loadVaults();
    } catch (error) {
      setClaimState((current) => ({ ...current, [key]: { error: error?.message || String(error) } }));
      await loadVaults();
    }
  }

  return (
    <main className="wizardPage">
      <header className="wizardHeader">
        <a className="wizardBrand" href="/">
          <img src="/kascoven-logo.png" alt="" aria-hidden="true" />
          <span>KasCoven <strong>Wizard</strong></span>
        </a>
        <div className="wizardWallet">
          <button type="button" onClick={() => setWalletMenuOpen((open) => !open)}>{connectedLabel}</button>
          {walletMenuOpen && !address ? (
            <div className="wizardWalletMenu">
              <button type="button" onClick={connectWithKaspire}><strong>Kaspire</strong><span>Mobile · WalletConnect</span></button>
              <button type="button" onClick={connectWithKasware}><strong>Kasware</strong><span>Browser extension</span></button>
            </div>
          ) : null}
        </div>
      </header>

      <section className="wizardHero">
        <p className="vaultEyebrow">SPECIAL COVENANT · PUBLIC CLAIM</p>
        <h1>When the clock strikes zero, anyone can win.</h1>
        <p>Create a permissionless Kaspa prize vault. No allowlist. No administrator. The first valid claim accepted by Kaspa receives the prize.</p>
      </section>

      <section className="wizardCreate">
        <div>
          <p className="vaultEyebrow">CREATE A CHALLENGE</p>
          <h2>Lock a prize for the fastest claimant</h2>
          <p>Creation requires your wallet signature. Claiming does not: after expiry, the covenant itself authorizes the first transaction.</p>
          <p className="wizardIrreversible">Once broadcast, the creator cannot cancel or reclaim this vault. After the timer expires, the prize is intentionally open to everyone.</p>
          <p className="wizardIrreversible">Once broadcast, the creator cannot cancel or reclaim this vault. After the timer expires, the prize is intentionally open to everyone.</p>
        </div>
        <div className="wizardForm">
          <label>Vault name<input value={vaultName} maxLength={64} onChange={(event) => setVaultName(event.target.value)} /></label>
          <label>Prize in KAS<input type="number" min="0.01" step="0.01" value={amountKas} onChange={(event) => setAmountKas(event.target.value)} /></label>
          <label>Timer in seconds<input type="number" min="1" step="1" value={lockSeconds} onChange={(event) => setLockSeconds(event.target.value)} /></label>
          <button type="button" onClick={createVault} disabled={createState?.loading || !address}>
            {createState?.loading ? "Waiting for wallet…" : "Create prize vault"}
          </button>
          {createState?.error ? <p className="wizardError">{createState.error}</p> : null}
          {createState?.ok ? <p className="wizardSuccess">Prize broadcast: {shortAddress(createState.broadcast?.txId)}</p> : null}
        </div>
      </section>

      <section className="wizardBoard">
        <div className="wizardBoardHeading">
          <div><p className="vaultEyebrow">LIVE PRIZE BOARD</p><h2>First come. First served.</h2></div>
          <button type="button" onClick={loadVaults} disabled={loadingVaults}>{loadingVaults ? "Loading…" : "Refresh"}</button>
        </div>
        {claimState.list?.error ? <p className="wizardError">{claimState.list.error}</p> : null}
        <div className="wizardPrizeGrid">
          {vaults.map((vault) => {
            const state = claimState[vault.deployTxId] || {};
            const elapsedSinceFetch = Math.max(0, Math.floor((now - (vault._loadedAt || now)) / 1000));
            const remaining = Math.max(0, vault.estimatedRemainingSeconds - elapsedSinceFetch);
            const ready = vault.readyToClaim || remaining === 0;
            return (
              <article className={`wizardPrize ${ready ? "isReady" : ""}`} key={vault.deployTxId}>
                <span className="wizardPrizeStatus">{ready ? "CLAIM OPEN" : "COUNTDOWN"}</span>
                <h3>{vault.vaultName}</h3>
                <strong className="wizardAmount">{vault.amountKas} KAS</strong>
                <div className="wizardClock">{ready ? "00m 00s" : formatCountdown(remaining)}</div>
                <p>Created by {shortAddress(vault.ownerAddress)}</p>
                <button type="button" disabled={!ready || !address || state.loading} onClick={() => claimVault(vault)}>
                  {state.loading ? "Racing to Kaspa…" : ready ? "Claim prize" : "Still locked"}
                </button>
                {state.ok ? <p className="wizardSuccess">You won this race. Transaction broadcast.</p> : null}
                {state.error ? <p className="wizardError">{state.error}</p> : null}
              </article>
            );
          })}
        </div>
        {!loadingVaults && !vaults.length ? <p className="wizardEmpty">No active prize vaults yet. Create the first one.</p> : null}
      </section>

      {pairing ? (
        <div className="pairingOverlay">
          <div className="pairingCard">
            <button className="pairingClose" type="button" onClick={() => setPairing(null)}>×</button>
            <h2>Connect Kaspire</h2>
            <img src={pairing.qrDataUrl} alt="Kaspire WalletConnect QR code" />
            <a className="connectWalletButton" href={/Android/i.test(window.navigator.userAgent) ? pairing.intentLink : pairing.appLink}>Open Kaspire</a>
          </div>
        </div>
      ) : null}

      {kaspireAction ? (
        <div className="kaspireActionPrompt">
          <strong>{kaspireAction.title}</strong>
          <p>{kaspireAction.message}</p>
          <a className="connectWalletButton" href={kaspireAction.launchUrl}>Open Kaspire</a>
        </div>
      ) : null}

      <footer className="footer-flow" data-darkreader-ignore>
        <a href="https://kaslab.space/" aria-label="Visit HUB21 at kaslab.space">Developed by HUB21</a>
      </footer>
    </main>
  );
}

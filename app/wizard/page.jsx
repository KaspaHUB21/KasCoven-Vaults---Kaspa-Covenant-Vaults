"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { connectKaspire, prepareKaspireConnection, restoreKaspire } from "../../lib/kaspire-wallet";

function shortAddress(address) {
  return address ? `${address.slice(0, 12)}…${address.slice(-8)}` : "Not connected";
}

function formatEstimatedDuration(daaBlocks) {
  let seconds = Math.max(0, Math.ceil(Number(daaBlocks || 0) / 10));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return `${days}d:${String(hours).padStart(2, "0")}h:${String(minutes).padStart(2, "0")}m:${String(seconds).padStart(2, "0")}s`;
}

function adjustDaaWithWheel(event, setValue, minimum) {
  event.preventDefault();
  const current = Number(event.currentTarget.value) || minimum;
  const delta = event.deltaY < 0 ? 100 : -100;
  setValue(String(Math.max(minimum, current + delta)));
}

function DurationSelector({ currentDaaScore, unlockDaaScore, onChange }) {
  let totalSeconds = Math.max(0, Math.ceil((Number(unlockDaaScore || 0) - Number(currentDaaScore || 0)) / 10));
  const values = {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };

  function update(unit, rawValue) {
    const limits = { days: Infinity, hours: 23, minutes: 59, seconds: 59 };
    const next = {
      ...values,
      [unit]: Math.min(limits[unit], Math.max(0, Math.floor(Number(rawValue) || 0))),
    };
    totalSeconds = Math.max(1, next.days * 86400 + next.hours * 3600 + next.minutes * 60 + next.seconds);
    onChange(String(Number(currentDaaScore || 0) + totalSeconds * 10));
  }

  return (
    <fieldset className="durationSelector wizardDurationSelector" disabled={!currentDaaScore}>
      <legend>Or choose a duration</legend>
      <div className="durationFields">
        {[
          ["days", "Days"],
          ["hours", "Hours"],
          ["minutes", "Minutes"],
          ["seconds", "Seconds"],
        ].map(([unit, label]) => (
          <label key={unit}>
            {label}
            <input
              type="number"
              min="0"
              max={unit === "days" ? undefined : unit === "hours" ? "23" : "59"}
              step="1"
              value={values[unit]}
              onChange={(event) => update(unit, event.target.value)}
              inputMode="numeric"
            />
          </label>
        ))}
      </div>
      <small>Changing the duration automatically updates the unlock DAA score.</small>
    </fieldset>
  );
}

async function readResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`The server returned an empty response (HTTP ${response.status}). Please refresh again.`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`The server returned an invalid response (HTTP ${response.status}). Please refresh again.`);
  }
  if (!response.ok) throw new Error(data?.error || "Request failed.");
  return data;
}

function TechnicalDetails({ data, title = "Technical details" }) {
  if (!data) return null;
  return (
    <details className="debugDetails">
      <summary>{title}</summary>
      <pre>{JSON.stringify(data, (key, value) => key === "loading" ? undefined : value, 2)}</pre>
    </details>
  );
}

export default function WizardPage() {
  const [wallet, setWallet] = useState(null);
  const [walletName, setWalletName] = useState("");
  const [address, setAddress] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [preparedKaspire, setPreparedKaspire] = useState(null);
  const [preparingKaspire, setPreparingKaspire] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [kaspireAction, setKaspireAction] = useState(null);
  const [vaultName, setVaultName] = useState("The Wizard's Prize");
  const [amountKas, setAmountKas] = useState("1");
  const [currentDaaScore, setCurrentDaaScore] = useState(0);
  const [unlockDaaScore, setUnlockDaaScore] = useState("");
  const unlockDaaTouchedRef = useRef(false);
  const [vaults, setVaults] = useState([]);
  const [loadingVaults, setLoadingVaults] = useState(true);
  const [createState, setCreateState] = useState(null);
  const [claimState, setClaimState] = useState({});

  const connectedLabel = useMemo(
    () => address ? `${walletName} · ${shortAddress(address)}` : "Connect Wallet",
    [address, walletName],
  );
  const unlockDaaDifference = Math.max(0, Number(unlockDaaScore || 0) - currentDaaScore);
  const estimatedUnlockDate = unlockDaaDifference
    ? new Date(Date.now() + Math.ceil(unlockDaaDifference / 10) * 1000)
    : null;

  async function applyWallet(nextWallet, name) {
    const accounts = name === "Kasware"
      ? await nextWallet.getAccounts()
      : await nextWallet.requestAccounts();
    const nextAddress = typeof accounts?.[0] === "string" ? accounts[0] : accounts?.[0]?.address;
    if (!nextAddress?.startsWith("kaspa:")) throw new Error(`${name} returned no Kaspa Mainnet address.`);
    setWallet(nextWallet);
    setWalletName(name);
    setAddress(nextAddress);
    setPublicKey("");
    setWalletMenuOpen(false);
    void nextWallet.getPublicKey().then(setPublicKey).catch(() => null);
  }

  async function prepareKaspire() {
    if (preparedKaspire || preparingKaspire) return;
    setPreparingKaspire(true);
    try {
      setPreparedKaspire(await prepareKaspireConnection());
    } catch (error) {
      setCreateState({ error: error?.message || "Kaspire pairing could not be prepared." });
    } finally {
      setPreparingKaspire(false);
    }
  }

  function toggleWalletMenu() {
    const opening = !walletMenuOpen;
    setWalletMenuOpen(opening);
    if (opening && !address) void prepareKaspire();
  }

  function launchKaspire() {
    const isAndroid = /Android/i.test(window.navigator.userAgent);
    if (isAndroid && preparedKaspire?.intentLink) {
      setWalletMenuOpen(false);
      window.location.assign(preparedKaspire.intentLink);
      void connectWithKaspire(true);
      return;
    }
    void connectWithKaspire(false);
  }

  async function connectWithKaspire(alreadyLaunched = false) {
    try {
      const nextWallet = await connectKaspire({
        onDisplayUri: async ({ appLink, intentLink }) => {
          const isAndroid = /Android/i.test(window.navigator.userAgent);
          if (isAndroid) {
            if (alreadyLaunched) return;
            window.location.assign(intentLink);
            return;
          }
          setPairing({ appLink, intentLink, qrDataUrl: "" });
          try {
            const QRCode = await import("qrcode");
            const qrDataUrl = await QRCode.toDataURL(appLink, {
              width: 320,
              margin: 2,
              errorCorrectionLevel: "M",
            });
            setPairing({ appLink, intentLink, qrDataUrl });
          } catch {
            setCreateState((current) => ({
              ...(current?.prepared ? current : {}),
              error: "The QR code could not be generated. Open the Kaspire link manually.",
            }));
          }
        },
      });
      setPairing(null);
      await applyWallet(nextWallet, "Kaspire");
    } catch (error) {
      setCreateState((current) => ({
        ...(current?.prepared ? current : {}),
        signing: false,
        error: error?.message || String(error),
      }));
    }
  }

  async function connectWithKasware() {
    try {
      if (!window.kasware) throw new Error("Kasware is not installed in this browser.");
      const accounts = await window.kasware.requestAccounts();
      if (!accounts?.length) throw new Error("Kasware returned no account.");
      await applyWallet(window.kasware, "Kasware");
    } catch (error) {
      setCreateState((current) => ({
        ...(current?.prepared ? current : {}),
        signing: false,
        error: error?.message || String(error),
      }));
    }
  }

  async function disconnectWallet() {
    try {
      if (walletName === "Kaspire" && typeof wallet?.disconnect === "function") {
        await wallet.disconnect();
      }
    } catch (error) {
      setCreateState((current) => ({
        ...(current?.prepared ? current : {}),
        signing: false,
        error: error?.message || String(error),
      }));
    } finally {
      setWallet(null);
      setWalletName("");
      setAddress("");
      setPublicKey("");
      setWalletMenuOpen(false);
    }
  }

  async function loadVaults() {
    try {
      let data;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          data = await readResponse(await fetch("/api/timelock-vault?action=wizard-list", { cache: "no-store" }));
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, attempt * 250));
        }
      }
      if (!data) throw lastError || new Error("Prize board could not be refreshed.");
      const nextCurrentDaaScore = Number(data.currentBlueScore || 0);
      setCurrentDaaScore(nextCurrentDaaScore);
      setUnlockDaaScore((current) => unlockDaaTouchedRef.current ? current : (nextCurrentDaaScore ? String(nextCurrentDaaScore + 6000) : current));
      setVaults(Array.isArray(data.vaults) ? data.vaults : []);
      setClaimState((current) => {
        if (!current.list) return current;
        const { list, ...remaining } = current;
        return remaining;
      });
    } catch (error) {
      setClaimState((current) => ({ ...current, list: { error: error?.message || String(error) } }));
    } finally {
      setLoadingVaults(false);
    }
  }

  async function loadCurrentDaaScore() {
    try {
      const data = await readResponse(await fetch("/api/timelock-vault?action=current-daa", { cache: "no-store" }));
      const score = Number(data.currentDaaScore || 0);
      if (score) {
        setCurrentDaaScore(score);
        setUnlockDaaScore((current) => unlockDaaTouchedRef.current ? current : String(score + 6000));
      }
    } catch {
      // Keep the last authoritative score during a temporary RPC delay.
    }
  }

  useEffect(() => {
    const refresh = window.setInterval(loadVaults, 15_000);
    const daaRefresh = window.setInterval(loadCurrentDaaScore, 1_000);
    const handleAction = (event) => setKaspireAction(event.detail?.active ? event.detail : null);
    window.addEventListener("vaults:kaspireAction", handleAction);
    loadVaults();
    loadCurrentDaaScore();

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
      window.clearInterval(refresh);
      window.clearInterval(daaRefresh);
      window.removeEventListener("vaults:kaspireAction", handleAction);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPreparingKaspire(true);
    prepareKaspireConnection()
      .then((prepared) => {
        if (!cancelled && prepared) setPreparedKaspire(prepared);
      })
      .catch(() => null)
      .finally(() => {
        if (!cancelled) setPreparingKaspire(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function prepareVault() {
    setCreateState({ loading: true });
    try {
      if (!wallet || !address || !publicKey) throw new Error("Connect a wallet before creating a prize.");
      if (!Number.isFinite(Number(amountKas)) || Number(amountKas) < 1) {
        throw new Error("The minimum prize vault amount is 1 KAS.");
      }
      if (!Number.isSafeInteger(Number(unlockDaaScore)) || Number(unlockDaaScore) <= currentDaaScore) {
        setUnlockDaaScore(String(currentDaaScore + 1));
        throw new Error("Unlock DAA score must be a whole number in the future.");
      }
      const params = new URLSearchParams({ action: "wizard-create", address, vaultName, amountKas, unlockDaaScore });
      const draft = await readResponse(await fetch(`/api/timelock-vault?${params}`, { cache: "no-store" }));
      setCreateState({ prepared: true, draft });
      unlockDaaTouchedRef.current = true;
    } catch (error) {
      setCreateState({ error: error?.message || String(error) });
    }
  }

  async function signAndBroadcastVault() {
    if (!createState?.prepared || !createState?.draft) {
      setCreateState({ error: "Prepare the prize vault before signing and broadcasting." });
      return;
    }
    if (Number(createState.draft?.unlockDaaScore || createState.draft?.vault?.unlockTime || 0) <= currentDaaScore) {
      setUnlockDaaScore(String(currentDaaScore + 1));
      setCreateState({ error: "The prepared unlock score has already passed. Choose a future DAA score and prepare again." });
      return;
    }
    setCreateState((current) => ({ ...current, signing: true, error: null }));
    try {
      if (!wallet || !address || !publicKey) throw new Error("Reconnect the wallet used to prepare this prize.");
      const draft = createState.draft;
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
      setCreateState((current) => ({
        ...(current || {}),
        signing: false,
        error: error?.message || String(error),
      }));
    }
  }

  async function claimVault(vault) {
    const key = vault.deployTxId;
    setClaimState((current) => ({ ...current, [key]: { loading: true } }));
    let draft = null;
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
      draft = await readResponse(await fetch(`/api/timelock-vault?${params}`, { cache: "no-store" }));
      const broadcast = await readResponse(await fetch("/api/covenant-broadcast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTxJson: draft.txJson }),
      }));
      setClaimState((current) => ({ ...current, [key]: { ok: true, draft, broadcast } }));
      await loadVaults();
    } catch (error) {
      setClaimState((current) => ({ ...current, [key]: { error: error?.message || String(error), draft } }));
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
          <button type="button" onClick={toggleWalletMenu}>{connectedLabel}</button>
          {walletMenuOpen && !address ? (
            <div className="wizardWalletMenu">
              <button type="button" disabled={preparingKaspire} onClick={launchKaspire}><strong>{preparingKaspire ? "Preparing Kaspire…" : "Kaspire"}</strong><span>Mobile · WalletConnect</span></button>
              <button type="button" onClick={connectWithKasware}><strong>Kasware</strong><span>Browser extension</span></button>
            </div>
          ) : null}
          {address ? <button className="wizardDisconnect" type="button" onClick={disconnectWallet}>Disconnect</button> : null}
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
        </div>
        <div className="wizardForm">
          <label>Vault name<input value={vaultName} maxLength={64} onChange={(event) => { setVaultName(event.target.value); setCreateState(null); }} /></label>
          <label>Prize in KAS<input type="number" min="1" step="0.01" value={amountKas} onChange={(event) => { setAmountKas(event.target.value); setCreateState(null); }} /></label>
          <label>Current DAA score<input type="text" value={currentDaaScore || "Loading…"} readOnly /></label>
          <label>Unlock DAA score<input type="number" min={currentDaaScore + 1} step="100" value={unlockDaaScore} onChange={(event) => { unlockDaaTouchedRef.current = true; setUnlockDaaScore(event.target.value); setCreateState(null); }} onWheel={(event) => { unlockDaaTouchedRef.current = true; adjustDaaWithWheel(event, setUnlockDaaScore, currentDaaScore + 1); }} /></label>
          <DurationSelector
            currentDaaScore={currentDaaScore}
            unlockDaaScore={unlockDaaScore}
            onChange={(value) => { unlockDaaTouchedRef.current = true; setUnlockDaaScore(value); setCreateState(null); }}
          />
          <div className="wizardDaaHint">
            {unlockDaaScore && currentDaaScore ? (
              <>
                <strong>{unlockDaaDifference.toLocaleString()} DAA until unlock</strong>
                <span>Estimated time (days:hours:minutes:seconds): ≈ {formatEstimatedDuration(unlockDaaDifference)}</span>
                <span>Estimated unlock: {estimatedUnlockDate?.toLocaleString()}</span>
                <small>Estimate based on approximately 10 DAA per second. Kaspa DAA score is authoritative.</small>
              </>
            ) : "Choose an unlock score above the current DAA score."}
          </div>
          <div className="wizardCreateSteps">
            <button type="button" onClick={prepareVault} disabled={createState?.loading || createState?.signing || !address}>
              {createState?.loading ? "Preparing…" : "1. Prepare vault"}
            </button>
            <button type="button" onClick={signAndBroadcastVault} disabled={!createState?.prepared || createState?.signing || createState?.ok}>
              {createState?.signing ? "Waiting for wallet…" : "2. Sign and broadcast"}
            </button>
          </div>
          {createState?.error ? <p className="wizardError">{createState.error}</p> : null}
          {createState?.prepared && !createState?.ok ? <p className="wizardSuccess">Draft prepared. Review the technical details, then sign and broadcast.</p> : null}
          {createState?.ok ? <p className="wizardSuccess">Prize broadcast: {shortAddress(createState.broadcast?.txId)}</p> : null}
          <TechnicalDetails data={createState?.draft} title="Prepared vault technical details" />
          <TechnicalDetails data={createState?.broadcast} title="Broadcast technical details" />
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
            const liveDaaScore = currentDaaScore || vault.currentBlueScore;
            const remaining = Math.max(0, Number(vault.unlockTime) - liveDaaScore);
            const ready = vault.readyToClaim || remaining === 0;
            return (
              <article className={`wizardPrize ${ready ? "isReady" : ""}`} key={vault.deployTxId}>
                <span className="wizardPrizeStatus">{ready ? "CLAIM OPEN" : "COUNTDOWN"}</span>
                <h3>{vault.vaultName}</h3>
                <strong className="wizardAmount">{vault.amountKas} KAS</strong>
                <div className="wizardClock">{ready ? "UNLOCKED" : `${remaining.toLocaleString()} DAA remaining`}</div>
                <p className="wizardDaaScores">Current DAA <strong>{Number(liveDaaScore).toLocaleString()}</strong><br />Unlock DAA <strong>{Number(vault.unlockTime).toLocaleString()}</strong></p>
                <p>Created by {shortAddress(vault.ownerAddress)}</p>
                <button type="button" disabled={!ready || !address || state.loading} onClick={() => claimVault(vault)}>
                  {state.loading ? "Racing to Kaspa…" : ready ? "Claim prize" : "Still locked"}
                </button>
                {state.ok ? <p className="wizardSuccess">You won this race. Transaction broadcast.</p> : null}
                {state.error ? <p className="wizardError">{state.error}</p> : null}
                <TechnicalDetails data={vault} title="Vault technical details" />
                <TechnicalDetails data={state.draft} title="Claim technical details" />
                <TechnicalDetails data={state.broadcast} title="Claim broadcast details" />
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
            {pairing.launching ? (
              <p>Secure connection is being established…</p>
            ) : pairing.qrDataUrl ? (
              <img src={pairing.qrDataUrl} alt="Kaspire WalletConnect QR code" />
            ) : (
              <p>Preparing QR code…</p>
            )}
            <a
              className="connectWalletButton pairingLaunchButton"
              href={/Android/i.test(window.navigator.userAgent) ? pairing.intentLink : pairing.appLink}
              onClick={() => setPairing((current) => current ? { ...current, launching: true } : current)}
            >
              {pairing.launching ? "Waiting for Kaspire…" : "Open Kaspire"}
            </a>
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

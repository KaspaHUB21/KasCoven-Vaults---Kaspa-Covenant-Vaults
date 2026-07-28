"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { connectKaspire, restoreKaspire } from "../lib/kaspire-wallet";

const methodNames = ["signPskt", "sendKaspa", "getPublicKey", "getAccounts", "signKRC20Transaction"];
const ACTIVE_TIME_LOCK_STORAGE_PREFIX = "kaslab-active-time-lock-vault:";
const ACTIVE_DMS_STORAGE_PREFIX = "kaslab-active-dms-vault:";
const RECOVERY_PROTOCOL = "kascoven-vault-recovery-v1";
const VAULT_PROTOCOL = "kaslab-time-lock-vault-v1";
const LAST_WALLET_STORAGE_KEY = "kascoven:last-wallet";

function providerSummary(provider) {
  if (!provider) return null;

  const ownKeys = Object.keys(provider).sort();
  const directMethods = methodNames.map((name) => ({
    name,
    available: typeof provider[name] === "function",
    arity: typeof provider[name] === "function" ? provider[name].length : null,
    source:
      typeof provider[name] === "function"
        ? String(provider[name]).replace(/\s+/g, " ").slice(0, 420)
        : null,
  }));

  return { ownKeys, directMethods };
}

function preview(value, length = 320) {
  return typeof value === "string" ? value.slice(0, length) : value;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function apiPath(path) {
  return path;
}

async function readApiResponse(response, fallbackMessage = "Request failed.") {
  const text = await response.text();
  let data = null;

  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    const message =
      data?.error ||
      data?.message ||
      `${fallbackMessage} The server returned an empty response (HTTP ${response.status}).`;
    throw new Error(message);
  }

  return data || {};
}

function isKaspaAddress(value) {
  return /^kaspa:[a-z0-9]{40,}$/i.test(String(value || "").trim());
}

function parsePositiveKas(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function friendlyErrorMessage(error) {
  const raw = error?.message || String(error || "");

  if (/beneficiary.*address|valid beneficiary|invalid address/i.test(raw)) {
    return "The beneficiary address is not a valid Kaspa address. Check that it starts with kaspa: and paste the full address.";
  }

  if (/owner wallet.*pulse network fee|vault balance is not used for pulse fees|pay the pulse/i.test(raw)) {
    return "Your owner wallet needs a small spendable KAS UTXO to pay the pulse network fee. The vault balance stays untouched.";
  }

  if (/sequence-lock|sequence locks|sequence lock/i.test(raw)) {
    return "This selected dead-man-switch vault is still locked by Kaspa sequence-lock rules. Wait a little longer, scan again, then claim this exact vault.";
  }

  if (/No spendable KAS UTXO|too small|Selected UTXO|insufficient|not enough|balance|fund this wallet/i.test(raw)) {
    return "Your wallet does not have enough spendable KAS for this vault amount, beneficiary notice output and network fee. Lower the amount or fund the wallet first.";
  }

  if (/Unexpected end of JSON|empty response|empty error response/i.test(raw)) {
    return "The wallet or server rejected the request before returning details. This is not a vault bug. Check the beneficiary address, amount and wallet balance, then try again.";
  }

  if (/504 Gateway Time-out|<html|nginx|did not confirm the broadcast in time|RPC connection timed out/i.test(raw)) {
    return "Kaspa RPC did not answer in time. This is usually a temporary network delay, not a vault bug. Wait a moment, check whether the transaction appears in your wallet or explorer, then retry if nothing appears.";
  }

  if (/storage mass/i.test(raw)) {
    return "The transaction was rejected by Kaspa storage-mass rules. This is a network dust/fee rule, not a vault bug. Try a higher amount or retry after the draft is refreshed.";
  }

  if (/User rejected|rejected by user|cancel/i.test(raw)) {
    return "The request was cancelled in Kasware. No vault was created.";
  }

  return raw || "The vault could not be created. Check the inputs and try again.";
}

function errorResult(error) {
  const technicalError = error?.message || String(error || "");
  return {
    loading: false,
    ok: false,
    error: friendlyErrorMessage(error),
    technicalError,
  };
}

function mergeVaultLists(currentVaults, incomingVaults) {
  const vaultMap = new Map();

  [...currentVaults, ...incomingVaults].forEach((vault) => {
    const key = vault?.selectedOutpoint
      ? `${vault.selectedOutpoint.transactionId || vault.selectedOutpoint.transaction_id || vault.selectedOutpoint.txId}:${vault.selectedOutpoint.index}`
      : vault?.deployTxId || vault?.vault?.address;
    if (key) vaultMap.set(key, vault);
  });

  return Array.from(vaultMap.values());
}

function vaultSelectionKey(vault) {
  if (!vault) return "";
  const outpoint = vault.selectedOutpoint;
  if (outpoint) {
    return `${outpoint.transactionId || outpoint.transaction_id || outpoint.txId}:${outpoint.index}`;
  }
  return vault.deployTxId || vault.vault?.address || "";
}

function getAccountAddress(report) {
  const account = report?.accounts?.[0];
  return typeof account === "string" ? account : account?.address;
}

function getActiveTimeLockStorageKey(address) {
  return `${ACTIVE_TIME_LOCK_STORAGE_PREFIX}${address}`;
}

function loadActiveTimeLockVault(address) {
  if (typeof window === "undefined" || !address) return null;

  try {
    return JSON.parse(window.localStorage.getItem(getActiveTimeLockStorageKey(address)) || "null");
  } catch {
    return null;
  }
}

function saveActiveTimeLockVault(address, vaultRecord) {
  if (typeof window === "undefined" || !address) return;

  window.localStorage.setItem(getActiveTimeLockStorageKey(address), JSON.stringify(vaultRecord));
}

function removeActiveTimeLockVault(address) {
  if (typeof window === "undefined" || !address) return;

  window.localStorage.removeItem(getActiveTimeLockStorageKey(address));
}

function getActiveDmsStorageKey(address) {
  return `${ACTIVE_DMS_STORAGE_PREFIX}${address}`;
}

function loadActiveDmsVault(address) {
  if (typeof window === "undefined" || !address) return null;

  try {
    return JSON.parse(window.localStorage.getItem(getActiveDmsStorageKey(address)) || "null");
  } catch {
    return null;
  }
}

function saveActiveDmsVault(address, vaultRecord) {
  if (typeof window === "undefined" || !address) return;

  window.localStorage.setItem(getActiveDmsStorageKey(address), JSON.stringify(vaultRecord));
}

function removeActiveDmsVault(address) {
  if (typeof window === "undefined" || !address) return;

  window.localStorage.removeItem(getActiveDmsStorageKey(address));
}

function shortAddress(address) {
  if (!address || typeof address !== "string") return "Not connected";
  return `${address.slice(0, 12)}...${address.slice(-8)}`;
}

function defaultVaultName(type, address) {
  return `${type} ${address ? shortAddress(address) : ""}`.trim();
}

function selectedOutpointId(outpoint) {
  if (!outpoint) return "";
  return `${outpoint.transactionId || outpoint.transaction_id || outpoint.txId || ""}:${outpoint.index ?? ""}`;
}

function buildRecoveryRecord(kind, draft, broadcast) {
  const payload = draft?.payload || {};
  const vault = draft?.vault || {};
  const type = kind === "dms" ? "dead_man_switch" : "time_lock";

  return {
    protocol: RECOVERY_PROTOCOL,
    network: "kaspa-mainnet",
    exportedAtIso: new Date().toISOString(),
    vaultProtocol: payload.p || VAULT_PROTOCOL,
    payloadVersion: payload.v || 2,
    type,
    vaultName: draft?.vaultName || payload.vaultName || (kind === "dms" ? "Dead Man's Switch" : "Time-Locked Vault"),
    deployTxId: draft?.deployTxId || broadcast?.txId || broadcast?.result?.transactionId || null,
    selectedOutpoint: draft?.selectedOutpoint || null,
    selectedOutpointId: selectedOutpointId(draft?.selectedOutpoint) || null,
    vaultAddress: vault.address || payload.vaultAddress || null,
    ownerAddress: draft?.ownerAddress || draft?.address || payload.ownerAddress || null,
    beneficiaryAddress: draft?.beneficiaryAddress || payload.beneficiaryAddress || null,
    ownerPublicKey: draft?.ownerPublicKey || payload.ownerPublicKey || null,
    unlockTime: vault.unlockTime || payload.unlockTime || null,
    inactivityDaaBlocks: draft?.inactivityDaaBlocks || payload.inactivityDaaBlocks || null,
    lockDaaBlocks: draft?.lockDaaBlocks || payload.lockDaaBlocks || null,
    lockSeconds: draft?.lockSeconds || payload.lockSeconds || null,
    lockAmountSompi: draft?.lockAmountSompi || payload.lockAmountSompi || null,
    lockAmountKas: draft?.lockAmountKas || null,
    redeemScript: vault.redeemScript || payload.redeemScript || null,
    scriptPublicKey: vault.scriptPublicKey || null,
    createdBlueScore: payload.createdBlueScore || draft?.currentBlueScore || null,
    createdAtIso: payload.createdAtIso || draft?.broadcastedAtIso || null,
    lastPulseBlueScore: draft?.lastPulseBlueScore || null,
    lastPulseTxId: draft?.lastPulseTxId || null,
    rawPayload: payload,
  };
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function DebugDetails({ title = "Technical details", data }) {
  if (!data) return null;

  return (
    <details className="debugDetails">
      <summary>{title}</summary>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

function InfoGrid({ items }) {
  const visibleItems = items.filter((item) => item.value !== undefined && item.value !== null && item.value !== "");
  if (!visibleItems.length) return null;

  return (
    <div className="infoGrid">
      {visibleItems.map((item) => (
        <div className="infoTile" key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function StatusNotice({ result, loadingText, successTitle, errorTitle, children }) {
  if (!result) return null;
  if (result.loading) return <div className="statusNotice isLoading">{loadingText}</div>;

  if (result.ok || result.prepared) {
    return (
      <div className="statusNotice isSuccess">
        <strong>{successTitle}</strong>
        {children}
      </div>
    );
  }

  return (
    <div className="statusNotice isError">
      <strong>{errorTitle}</strong>
      <p>{result.error || "Something went wrong. Please try again."}</p>
      <DebugDetails data={result} />
    </div>
  );
}

export function KasCovenVaults({ recoveryMode = false }) {
  const [report, setReport] = useState(null);
  const [activeProvider, setActiveProvider] = useState(null);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [kaspireAction, setKaspireAction] = useState(null);
  const [status, setStatus] = useState("");
  const [opTrueVaultResult, setOpTrueVaultResult] = useState(null);
  const [opTrueVaultBroadcastResult, setOpTrueVaultBroadcastResult] = useState(null);
  const [opTrueUnlockResult, setOpTrueUnlockResult] = useState(null);
  const [opTrueUnlockBroadcastResult, setOpTrueUnlockBroadcastResult] = useState(null);
  const [timeLockSeconds, setTimeLockSeconds] = useState("300");
  const [timeLockAmountKas, setTimeLockAmountKas] = useState("0.2");
  const [timeLockVaultName, setTimeLockVaultName] = useState("Savings time lock");
  const [timeLockCreateResult, setTimeLockCreateResult] = useState(null);
  const [timeLockCreateBroadcastResult, setTimeLockCreateBroadcastResult] = useState(null);
  const [timeLockUnlockResult, setTimeLockUnlockResult] = useState(null);
  const [timeLockUnlockBroadcastResult, setTimeLockUnlockBroadcastResult] = useState(null);
  const [dmsSeconds, setDmsSeconds] = useState("300");
  const [dmsAmountKas, setDmsAmountKas] = useState("0.2");
  const [dmsVaultName, setDmsVaultName] = useState("Beneficiary safety vault");
  const [dmsBeneficiaryAddress, setDmsBeneficiaryAddress] = useState("");
  const [dmsCreateResult, setDmsCreateResult] = useState(null);
  const [dmsCreateBroadcastResult, setDmsCreateBroadcastResult] = useState(null);
  const [dmsReleaseResult, setDmsReleaseResult] = useState(null);
  const [dmsReleaseBroadcastResult, setDmsReleaseBroadcastResult] = useState(null);
  const [dmsPulseResult, setDmsPulseResult] = useState(null);
  const [dmsScanResult, setDmsScanResult] = useState(null);
  const [dmsAutoReleaseEnabled, setDmsAutoReleaseEnabled] = useState(false);
  const [dmsAutoReleaseAttempted, setDmsAutoReleaseAttempted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [selectedVault, setSelectedVault] = useState("timeLock");
  const [showMyVaults, setShowMyVaults] = useState(recoveryMode);
  const [discoveredTimeLockVaults, setDiscoveredTimeLockVaults] = useState([]);
  const [discoveredDmsVaults, setDiscoveredDmsVaults] = useState([]);
  const timeLockReleaseRef = useRef(null);
  const dmsReleaseRef = useRef(null);
  const recoveryFileInputRef = useRef(null);

  const provider = activeProvider;
  const summary = useMemo(() => providerSummary(provider), [provider]);
  const visibleReport = report || { connected: false, accounts: [], summary };
  const accountAddress = getAccountAddress(visibleReport);
  const available = visibleReport.summary?.directMethods?.filter((method) => method.available) || [];
  const activeTimeLockBroadcasted = Boolean(timeLockCreateResult?.ok && timeLockCreateBroadcastResult?.ok);
  const timeLockUnlockAt = activeTimeLockBroadcasted && timeLockCreateResult?.draft?.estimatedUnlockTimeIso
    ? new Date(timeLockCreateResult.draft.estimatedUnlockTimeIso).getTime()
    : 0;
  const timeLockRemainingMs = timeLockUnlockAt ? timeLockUnlockAt - now : 0;
  const timeLockCanBroadcast = Boolean(timeLockUnlockResult?.ok && timeLockRemainingMs <= 0);
  const activeDmsBroadcasted = Boolean(dmsCreateResult?.ok && dmsCreateBroadcastResult?.ok);
  const dmsUnlockAt = activeDmsBroadcasted && dmsCreateResult?.draft?.estimatedUnlockTimeIso
    ? new Date(dmsCreateResult.draft.estimatedUnlockTimeIso).getTime()
    : 0;
  const dmsRemainingMs = dmsUnlockAt ? dmsUnlockAt - now : 0;
  const dmsCanBroadcastRelease = Boolean(dmsReleaseResult?.ok && dmsRemainingMs <= 0);
  const dmsOwnerAddress = dmsCreateResult?.draft?.ownerAddress || dmsCreateResult?.draft?.payload?.ownerAddress || "";
  const canSendDmsPulse = Boolean(activeDmsBroadcasted && accountAddress && dmsOwnerAddress && accountAddress === dmsOwnerAddress);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleKaspireAction = (event) => {
      setKaspireAction(event.detail?.active ? event.detail : null);
    };
    window.addEventListener("vaults:kaspireAction", handleKaspireAction);
    return () => window.removeEventListener("vaults:kaspireAction", handleKaspireAction);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function applyRestoredWallet(walletName, wallet, accounts, publicKey) {
      if (cancelled || !Array.isArray(accounts) || !accounts.length) return false;
      const nextReport = { connected: true, accounts, publicKey, walletName, summary: providerSummary(wallet) };
      setActiveProvider(wallet);
      setReport(nextReport);
      const address = getAccountAddress(nextReport);
      restoreActiveTimeLockVault(address);
      const restoredDms = restoreActiveDmsVault(address);
      await restoreActiveTimeLockVaultFromChain(address);
      const ownerDmsFound = await scanDmsVaultsForOwner(address);
      if (!restoredDms && !ownerDmsFound) {
        await scanDmsVaultsForBeneficiary(address, { silent: true });
      }
      if (!cancelled) {
        window.localStorage.setItem(LAST_WALLET_STORAGE_KEY, walletName.toLowerCase());
        setStatus("");
      }
      return !cancelled;
    }

    async function restoreKasware() {
      const kasware = window.kasware;
      if (!kasware || typeof kasware.getAccounts !== "function") return false;
      const accounts = await kasware.getAccounts();
      if (!Array.isArray(accounts) || !accounts.length) return false;
      const publicKey = typeof kasware.getPublicKey === "function" ? await kasware.getPublicKey().catch(() => null) : null;
      return applyRestoredWallet("Kasware", kasware, accounts, publicKey);
    }

    async function restoreWalletSession() {
      const preferred = window.localStorage.getItem(LAST_WALLET_STORAGE_KEY);
      try {
        if (preferred === "kasware") {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          if (await restoreKasware()) return;
        }

        const kaspire = await restoreKaspire();
        if (kaspire) {
          const accounts = await kaspire.requestAccounts();
          const publicKey = await kaspire.getPublicKey().catch(() => null);
          if (await applyRestoredWallet("Kaspire", kaspire, accounts, publicKey)) return;
        }

        if (preferred !== "kaspire") {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          await restoreKasware();
        }
      } catch (error) {
        if (!cancelled) setStatus(error?.message || "Could not restore the wallet session.");
      }
    }

    restoreWalletSession();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!dmsAutoReleaseEnabled || !activeDmsBroadcasted || dmsRemainingMs > 0 || dmsAutoReleaseAttempted) return;
    if (dmsReleaseBroadcastResult?.ok || dmsReleaseBroadcastResult?.loading) return;

    async function autoBroadcastDmsRelease() {
      setDmsAutoReleaseAttempted(true);
    setDmsReleaseResult({ loading: true, auto: true });
    setDmsReleaseBroadcastResult(null);

      try {
        const beneficiaryAddress =
          dmsCreateResult.draft?.beneficiaryAddress ||
          dmsCreateResult.draft?.payload?.beneficiaryAddress ||
          dmsBeneficiaryAddress;

        const releaseResponse = await fetch(
          apiPath(`/api/timelock-vault?${new URLSearchParams({
            action: "dms-release",
            beneficiaryAddress,
            vaultAddress: dmsCreateResult.draft?.vault?.address,
            unlockTime: dmsCreateResult.draft?.vault?.unlockTime,
            inactivityDaaBlocks: dmsCreateResult.draft?.inactivityDaaBlocks || dmsCreateResult.draft?.payload?.inactivityDaaBlocks || "",
            ownerPublicKey: dmsCreateResult.draft?.ownerPublicKey || dmsCreateResult.draft?.payload?.ownerPublicKey || "",
            createdBlueScore: dmsCreateResult.draft?.payload?.createdBlueScore || dmsCreateResult.draft?.currentBlueScore || "",
            lastPulseBlueScore: dmsCreateResult.draft?.lastPulseBlueScore || "",
            outpointTxId: dmsCreateResult.draft?.selectedOutpoint?.transactionId || dmsCreateResult.draft?.selectedOutpoint?.transaction_id || dmsCreateResult.draft?.selectedOutpoint?.txId || "",
            outpointIndex: dmsCreateResult.draft?.selectedOutpoint?.index ?? "",
            redeemScript: dmsCreateResult.draft?.vault?.redeemScript,
          }).toString()}`),
          { cache: "no-store" },
        );
        const releaseDraft = await readApiResponse(releaseResponse, "Could not create dead-man-switch release transaction.");

        setDmsReleaseResult({ loading: false, ok: true, auto: true, draft: releaseDraft, signed: releaseDraft.txJson });
        setDmsReleaseBroadcastResult({ loading: true, auto: true });

        const broadcastResponse = await fetch(apiPath("/api/covenant-broadcast"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ signedTxJson: releaseDraft.txJson }),
        });
        const broadcastData = await readApiResponse(broadcastResponse, "Could not broadcast dead-man-switch release.");

        setDmsReleaseBroadcastResult({ loading: false, ok: true, auto: true, data: broadcastData });

        const account = visibleReport.accounts?.[0];
        const address = typeof account === "string" ? account : account?.address;
        removeActiveDmsVault(address);
      } catch (error) {
        setDmsReleaseResult((current) =>
          current?.ok ? current : { ...errorResult(error), auto: true },
        );
        setDmsReleaseBroadcastResult({ ...errorResult(error), auto: true });
      }
    }

    autoBroadcastDmsRelease();
  }, [
    activeDmsBroadcasted,
    dmsAutoReleaseAttempted,
    dmsAutoReleaseEnabled,
    dmsBeneficiaryAddress,
    dmsCreateResult,
    dmsReleaseBroadcastResult?.loading,
    dmsReleaseBroadcastResult?.ok,
    dmsRemainingMs,
    visibleReport.accounts,
  ]);

  async function connectKasware() {
    setStatus("");

    try {
      const kasware = typeof window === "undefined" ? null : window.kasware;
      if (!kasware) throw new Error("Kasware is not available in this browser.");
      setActiveProvider(kasware);
      setWalletMenuOpen(false);

      if (typeof kasware.requestAccounts === "function") {
        const accounts = await kasware.requestAccounts();
        const publicKey = typeof kasware.getPublicKey === "function" ? await kasware.getPublicKey().catch(() => null) : null;
        const nextReport = { connected: true, accounts, publicKey, walletName: "Kasware", summary: providerSummary(kasware) };
        setReport(nextReport);
        window.localStorage.setItem(LAST_WALLET_STORAGE_KEY, "kasware");
        const address = getAccountAddress(nextReport);
        restoreActiveTimeLockVault(address);
        const restoredDms = restoreActiveDmsVault(address);
        await restoreActiveTimeLockVaultFromChain(address);
        const ownerDmsFound = await scanDmsVaultsForOwner(address);
        if (!restoredDms && !ownerDmsFound) {
          await scanDmsVaultsForBeneficiary(address, { silent: true });
        }
        return;
      }

      setReport({ connected: false, accounts: [], summary: providerSummary(kasware) });
      setStatus("Kasware was found, but requestAccounts is not available.");
    } catch (error) {
      setStatus(error?.message || "Connection failed.");
    }
  }

  async function connectWithKaspire() {
    setStatus("Opening Kaspire…");
    setWalletMenuOpen(false);
    setPairing(null);
    try {
      const kaspire = await connectKaspire({
        onDisplayUri: (nextPairing) => {
          if (/Android/i.test(window.navigator.userAgent)) {
            setStatus("Opening Kaspire for connection approval…");
            window.location.assign(nextPairing.intentLink);
            return;
          }
          setPairing(nextPairing);
        },
      });
      setActiveProvider(kaspire);
      const accounts = await kaspire.requestAccounts();
      const publicKey = await kaspire.getPublicKey();
      const nextReport = { connected: true, accounts, publicKey, walletName: "Kaspire", summary: providerSummary(kaspire) };
      setReport(nextReport);
      window.localStorage.setItem(LAST_WALLET_STORAGE_KEY, "kaspire");
      setPairing(null);
      setStatus("");
      const address = getAccountAddress(nextReport);
      restoreActiveTimeLockVault(address);
      const restoredDms = restoreActiveDmsVault(address);
      await restoreActiveTimeLockVaultFromChain(address);
      const ownerDmsFound = await scanDmsVaultsForOwner(address);
      if (!restoredDms && !ownerDmsFound) await scanDmsVaultsForBeneficiary(address, { silent: true });
    } catch (error) {
      setPairing(null);
      setStatus(error?.message || "Kaspire connection failed.");
    }
  }

  function refresh() {
    setStatus("");
    setOpTrueVaultResult(null);
    setOpTrueVaultBroadcastResult(null);
    setOpTrueUnlockResult(null);
    setOpTrueUnlockBroadcastResult(null);
    setTimeLockCreateResult(null);
    setTimeLockCreateBroadcastResult(null);
    setTimeLockUnlockResult(null);
    setTimeLockUnlockBroadcastResult(null);
    setDmsCreateResult(null);
    setDmsCreateBroadcastResult(null);
    setDmsReleaseResult(null);
    setDmsReleaseBroadcastResult(null);
    setDmsPulseResult(null);
    setDmsScanResult(null);
    setDmsAutoReleaseAttempted(false);
    setReport({ connected: false, accounts: [], summary: providerSummary(provider) });
  }

  async function disconnect() {
    setStatus("");
    await provider?.disconnect?.().catch(() => null);
    window.localStorage.removeItem(LAST_WALLET_STORAGE_KEY);
    setActiveProvider(null);
    setReport({ connected: false, accounts: [], summary: providerSummary(provider) });
    setShowMyVaults(false);
    setDiscoveredTimeLockVaults([]);
    setDiscoveredDmsVaults([]);
  }

  function scrollToReleaseSection(kind) {
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        const target = kind === "timeLock" ? timeLockReleaseRef.current : dmsReleaseRef.current;
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }, 0);
  }

  async function openMyVaults() {
    const address = getAccountAddress(visibleReport);
    setShowMyVaults((current) => !current);

    if (address?.startsWith("kaspa:")) {
      await scanOwnedVaults(address);
    }
  }

  function selectTimeLockVault(vault) {
    if (!vault?.vault?.address) return;

    const restoredDraft = {
      ...vault,
      status: "Active time-locked vault selected",
    };
    const broadcast = { txId: vault.deployTxId, status: "Selected from My vaults" };
    const address = getAccountAddress(visibleReport) || vault.address || vault.payload?.ownerAddress;

    setSelectedVault("timeLock");
    setTimeLockCreateResult({ loading: false, ok: true, restored: true, draft: restoredDraft, signed: "" });
    setTimeLockCreateBroadcastResult({ loading: false, ok: true, restored: true, data: broadcast });
    setTimeLockUnlockResult(null);
    setTimeLockUnlockBroadcastResult(null);
    setTimeLockAmountKas(restoredDraft.lockAmountKas || timeLockAmountKas);
    setTimeLockSeconds(String(restoredDraft.lockSeconds || timeLockSeconds));
    setTimeLockVaultName(restoredDraft.vaultName || restoredDraft.payload?.vaultName || defaultVaultName("Time lock", restoredDraft.vault?.address));
    if (address) saveActiveTimeLockVault(address, { draft: restoredDraft, signed: "", broadcast });
    scrollToReleaseSection("timeLock");
  }

  function selectDmsVault(vault) {
    if (!vault?.vault?.address) return;

    const restoredDraft = {
      ...vault,
      beneficiaryAddress: vault.beneficiaryAddress || vault.payload?.beneficiaryAddress,
      status: "Dead-man-switch vault selected",
    };
    const broadcast = { txId: vault.deployTxId, status: "Selected from My vaults" };
    const address = getAccountAddress(visibleReport) || vault.ownerAddress || vault.beneficiaryAddress;

    setSelectedVault("dms");
    setDmsCreateResult({ loading: false, ok: true, restored: true, restoredFromChain: true, draft: restoredDraft, signed: "" });
    setDmsCreateBroadcastResult({ loading: false, ok: true, restored: true, restoredFromChain: true, data: broadcast });
    setDmsReleaseResult(null);
    setDmsReleaseBroadcastResult(null);
    setDmsPulseResult(null);
    setDmsAutoReleaseAttempted(false);
    setDmsAmountKas(restoredDraft.lockAmountKas || dmsAmountKas);
    setDmsSeconds(String(restoredDraft.lockSeconds || dmsSeconds));
    setDmsVaultName(restoredDraft.vaultName || restoredDraft.payload?.vaultName || defaultVaultName("Dead man's switch", restoredDraft.vault?.address));
    setDmsBeneficiaryAddress(restoredDraft.beneficiaryAddress || restoredDraft.payload?.beneficiaryAddress || "");
    if (address) saveActiveDmsVault(address, { draft: restoredDraft, signed: "", broadcast });
    scrollToReleaseSection("dms");
  }

  function exportVaultRecovery(kind, draft, broadcast) {
    if (!draft?.vault?.address) {
      setStatus("Select or create a vault before exporting a recovery file.");
      return;
    }

    const recovery = buildRecoveryRecord(kind, draft, broadcast);
    const name = recovery.vaultName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "vault";
    downloadJson(`kascoven-${recovery.type}-${name}.json`, recovery);
    setStatus("Recovery file exported. It contains no private keys, but keep it available for future claims.");
  }

  function exportRawVaultRecovery(kind, vault) {
    exportVaultRecovery(kind, vault, { txId: vault?.deployTxId });
  }

  function restoreRecoveryRecord(recovery) {
    if (recovery?.protocol !== RECOVERY_PROTOCOL) {
      throw new Error("This is not a KasCoven recovery file.");
    }

    if (!recovery.vaultAddress?.startsWith("kaspa:") || !recovery.redeemScript) {
      throw new Error("Recovery file is missing the vault address or redeem script.");
    }

    const kind = recovery.type === "dead_man_switch" ? "dms" : "timeLock";
    const restoredDraft = {
      status: "Vault restored from recovery file",
      vaultName: recovery.vaultName,
      deployTxId: recovery.deployTxId,
      selectedOutpoint: recovery.selectedOutpoint || null,
      selectedAmountSompi: recovery.lockAmountSompi || null,
      lockAmountSompi: recovery.lockAmountSompi || null,
      lockAmountKas: recovery.lockAmountKas || (recovery.lockAmountSompi ? (Number(recovery.lockAmountSompi) / 100000000).toString() : ""),
      lockSeconds: recovery.lockSeconds || "",
      lockDaaBlocks: recovery.lockDaaBlocks || "",
      inactivityDaaBlocks: recovery.inactivityDaaBlocks || "",
      beneficiaryAddress: recovery.beneficiaryAddress || "",
      ownerAddress: recovery.ownerAddress || "",
      ownerPublicKey: recovery.ownerPublicKey || "",
      lastPulseBlueScore: recovery.lastPulseBlueScore || "",
      lastPulseTxId: recovery.lastPulseTxId || "",
      estimatedUnlockTimeIso: recovery.lockSeconds ? new Date(Date.now() + Number(recovery.lockSeconds) * 1000).toISOString() : "",
      currentBlueScore: recovery.createdBlueScore || "",
      vault: {
        address: recovery.vaultAddress,
        unlockTime: recovery.unlockTime,
        redeemScript: recovery.redeemScript,
        scriptPublicKey: recovery.scriptPublicKey || null,
      },
      payload: {
        ...(recovery.rawPayload || {}),
        p: recovery.vaultProtocol || VAULT_PROTOCOL,
        v: recovery.payloadVersion || 2,
        vaultName: recovery.vaultName,
        ownerAddress: recovery.ownerAddress,
        beneficiaryAddress: recovery.beneficiaryAddress,
        ownerPublicKey: recovery.ownerPublicKey,
        vaultAddress: recovery.vaultAddress,
        unlockTime: recovery.unlockTime,
        inactivityDaaBlocks: recovery.inactivityDaaBlocks,
        lockDaaBlocks: recovery.lockDaaBlocks,
        lockSeconds: recovery.lockSeconds,
        lockAmountSompi: recovery.lockAmountSompi,
        redeemScript: recovery.redeemScript,
        createdBlueScore: recovery.createdBlueScore,
      },
    };
    const broadcast = { txId: recovery.deployTxId, status: "Restored from recovery file" };

    if (kind === "dms") {
      setDiscoveredDmsVaults((vaults) => mergeVaultLists(vaults, [restoredDraft]));
      selectDmsVault(restoredDraft);
      const storageAddress = getAccountAddress(visibleReport) || recovery.ownerAddress || recovery.beneficiaryAddress;
      if (storageAddress) saveActiveDmsVault(storageAddress, { draft: restoredDraft, signed: "", broadcast });
      setStatus("Dead-man-switch restored from recovery file. Scan before claiming to refresh live UTXO and timer data.");
      return;
    }

    setDiscoveredTimeLockVaults((vaults) => mergeVaultLists(vaults, [restoredDraft]));
    selectTimeLockVault(restoredDraft);
    const storageAddress = getAccountAddress(visibleReport) || recovery.ownerAddress;
    if (storageAddress) saveActiveTimeLockVault(storageAddress, { draft: restoredDraft, signed: "", broadcast });
    setStatus("Time-locked vault restored from recovery file. Scan before unlocking to refresh live UTXO and timer data.");
  }

  async function importRecoveryFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const document = JSON.parse(await file.text());
      const recoveries = Array.isArray(document?.vaults) ? document.vaults : [document];
      if (!recoveries.length) throw new Error("The recovery export contains no vault records.");
      recoveries.forEach(restoreRecoveryRecord);
      if (recoveries.length > 1) setStatus(recoveries.length + " vaults restored. Scan before unlocking or claiming to refresh live chain state.");
    } catch (error) {
      setStatus(error?.message || "Recovery file could not be imported.");
    }
  }

  async function scanOwnedVaults(address) {
    if (!address?.startsWith("kaspa:")) return false;

    const [timeLockFound, dmsFound] = await Promise.all([
      restoreActiveTimeLockVaultFromChain(address),
      scanDmsVaultsForOwner(address),
    ]);

    return Boolean(timeLockFound || dmsFound);
  }

  function restoreActiveTimeLockVault(address) {
    const vaultRecord = loadActiveTimeLockVault(address);
    if (!vaultRecord?.draft?.vault?.address) return false;

    setTimeLockCreateResult({
      loading: false,
      ok: true,
      restored: true,
      draft: vaultRecord.draft,
      signed: vaultRecord.signed || "",
    });
    setTimeLockCreateBroadcastResult({
      loading: false,
      ok: true,
      restored: true,
      data: vaultRecord.broadcast || { status: "Restored from this browser" },
    });
    setTimeLockUnlockResult(null);
    setTimeLockUnlockBroadcastResult(null);
    setTimeLockAmountKas(vaultRecord.draft.lockAmountKas || timeLockAmountKas);
    setTimeLockSeconds(String(vaultRecord.draft.lockSeconds || timeLockSeconds));
    setTimeLockVaultName(vaultRecord.draft.vaultName || vaultRecord.draft.payload?.vaultName || timeLockVaultName);
    setStatus("Active time-locked vault restored from this browser.");
    return true;
  }

  async function restoreActiveTimeLockVaultFromChain(address) {
    if (!address?.startsWith("kaspa:")) return false;

    try {
      setStatus("Scanning Kaspa DAG for active time-locked vaults...");
      const response = await fetch(
        apiPath(`/api/timelock-vault?${new URLSearchParams({ action: "scan", address }).toString()}`),
        { cache: "no-store" },
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not scan for active vaults.");
      }

      const vaults = Array.isArray(data.vaults) ? data.vaults : [];
      setDiscoveredTimeLockVaults(vaults);

      const activeVault = vaults[0] || null;
      if (!activeVault?.vault?.address) {
        setStatus("");
        return false;
      }

      const restoredDraft = {
        ...activeVault,
        status: "Active time-locked vault restored from DAG",
      };
      const broadcast = { txId: activeVault.deployTxId, status: "Restored from DAG scan" };

      setTimeLockCreateResult({
        loading: false,
        ok: true,
        restored: true,
        restoredFromChain: true,
        draft: restoredDraft,
        signed: "",
      });
      setTimeLockCreateBroadcastResult({
        loading: false,
        ok: true,
        restored: true,
        restoredFromChain: true,
        data: broadcast,
      });
      setTimeLockUnlockResult(null);
      setTimeLockUnlockBroadcastResult(null);
      setTimeLockAmountKas(restoredDraft.lockAmountKas || timeLockAmountKas);
      setTimeLockSeconds(String(restoredDraft.lockSeconds || timeLockSeconds));
      setTimeLockVaultName(restoredDraft.vaultName || restoredDraft.payload?.vaultName || timeLockVaultName);
      saveActiveTimeLockVault(address, { draft: restoredDraft, signed: "", broadcast });
      setStatus("Active time-locked vault restored from Kaspa DAG.");
      return true;
    } catch (error) {
      setStatus(`DAG scan failed: ${error?.message || String(error)}`);
      return false;
    }
  }

  function restoreActiveDmsVault(address) {
    const vaultRecord = loadActiveDmsVault(address);
    if (!vaultRecord?.draft?.vault?.address) return false;

    setDmsCreateResult({
      loading: false,
      ok: true,
      restored: true,
      draft: vaultRecord.draft,
      signed: vaultRecord.signed || "",
    });
    setDmsCreateBroadcastResult({
      loading: false,
      ok: true,
      restored: true,
      data: vaultRecord.broadcast || { status: "Restored from this browser" },
    });
    setDmsReleaseResult(null);
    setDmsReleaseBroadcastResult(null);
    setDmsPulseResult(null);
    setDmsAutoReleaseAttempted(false);
    setDmsAmountKas(vaultRecord.draft.lockAmountKas || dmsAmountKas);
    setDmsSeconds(String(vaultRecord.draft.lockSeconds || dmsSeconds));
    setDmsVaultName(vaultRecord.draft.vaultName || vaultRecord.draft.payload?.vaultName || dmsVaultName);
    setDmsBeneficiaryAddress(vaultRecord.draft.beneficiaryAddress || vaultRecord.draft.payload?.beneficiaryAddress || "");
    setStatus("Active dead-man-switch vault restored from this browser.");
    return true;
  }

  async function scanDmsVaultsForBeneficiary(scanAddress, options = {}) {
    const beneficiaryAddress = scanAddress || getAccountAddress(visibleReport) || dmsBeneficiaryAddress;

    if (!beneficiaryAddress?.startsWith("kaspa:")) {
      if (!options.silent) {
        setDmsScanResult({ loading: false, ok: false, error: "Connect or enter the beneficiary Kaspa address first." });
      }
      return false;
    }

    if (!options.silent) setDmsScanResult({ loading: true });

    try {
      const response = await fetch(
        apiPath(`/api/timelock-vault?${new URLSearchParams({
          action: "dms-scan",
          beneficiaryAddress,
        }).toString()}`),
        { cache: "no-store" },
      );
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Could not scan for dead-man-switch vaults.");

      const vaults = Array.isArray(data.vaults) ? data.vaults : [];
      if (vaults.length) {
        setDiscoveredDmsVaults((current) => mergeVaultLists(current, vaults));
      }

      const activeVault = vaults[0] || null;
      if (!activeVault?.vault?.address) {
        if (!options.silent) setDmsScanResult({ loading: false, ok: true, data });
        return false;
      }

      const restoredDraft = {
        ...activeVault,
        beneficiaryAddress,
        status: "Dead-man-switch vault restored from beneficiary history",
      };
      const broadcast = { txId: activeVault.deployTxId, status: "Restored from beneficiary history scan" };

      setDmsBeneficiaryAddress(beneficiaryAddress);
      setDmsCreateResult({
        loading: false,
        ok: true,
        restored: true,
        restoredFromChain: true,
        draft: restoredDraft,
        signed: "",
      });
      setDmsCreateBroadcastResult({
        loading: false,
        ok: true,
        restored: true,
        restoredFromChain: true,
        data: broadcast,
      });
      setDmsReleaseResult(null);
      setDmsReleaseBroadcastResult(null);
      setDmsAutoReleaseAttempted(false);
      setDmsAmountKas(restoredDraft.lockAmountKas || dmsAmountKas);
      setDmsSeconds(String(restoredDraft.lockSeconds || dmsSeconds));
      setDmsVaultName(restoredDraft.vaultName || restoredDraft.payload?.vaultName || dmsVaultName);
      saveActiveDmsVault(beneficiaryAddress, { draft: restoredDraft, signed: "", broadcast });
      setDmsScanResult({ loading: false, ok: true, data });
      if (!options.silent) setStatus("Claimable dead-man-switch vault restored from beneficiary history.");
      return true;
    } catch (error) {
      if (!options.silent) {
        setDmsScanResult({ loading: false, ok: false, error: error?.message || String(error) });
      }
      return false;
    }
  }

  async function scanDmsVaultsForOwner(ownerAddress) {
    if (!ownerAddress?.startsWith("kaspa:")) return false;

    try {
      const response = await fetch(
        apiPath(`/api/timelock-vault?${new URLSearchParams({
          action: "dms-scan",
          ownerAddress,
        }).toString()}`),
        { cache: "no-store" },
      );
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Could not scan for owned dead-man-switch vaults.");

      const vaults = Array.isArray(data.vaults) ? data.vaults : [];
      if (vaults.length) {
        setDiscoveredDmsVaults((current) => mergeVaultLists(current, vaults));
      }

      const activeVault = vaults[0] || null;
      if (!activeVault?.vault?.address) return false;

      const restoredDraft = {
        ...activeVault,
        beneficiaryAddress: activeVault.beneficiaryAddress,
        status: "Dead-man-switch vault restored from owner history",
      };
      const broadcast = { txId: activeVault.deployTxId, status: "Restored from owner history scan" };

      setDmsBeneficiaryAddress(activeVault.beneficiaryAddress || "");
      setDmsCreateResult({
        loading: false,
        ok: true,
        restored: true,
        restoredFromChain: true,
        draft: restoredDraft,
        signed: "",
      });
      setDmsCreateBroadcastResult({
        loading: false,
        ok: true,
        restored: true,
        restoredFromChain: true,
        data: broadcast,
      });
      setDmsReleaseResult(null);
      setDmsReleaseBroadcastResult(null);
      setDmsAutoReleaseAttempted(false);
      setDmsVaultName(restoredDraft.vaultName || restoredDraft.payload?.vaultName || dmsVaultName);
      return true;
    } catch (error) {
      setStatus(`DMS owner scan failed: ${error?.message || String(error)}`);
      return false;
    }
  }

  async function getSigningContext(extraParams = {}) {
    if (!provider || typeof provider.signPskt !== "function") {
      throw new Error("Kasware signPskt is not available.");
    }

    const account = visibleReport.accounts?.[0];
    const address = typeof account === "string" ? account : account?.address;
    const publicKey =
      visibleReport.publicKey ||
      (typeof account === "object" ? account?.publicKey || account?.pubkey || account?.pubKey : null) ||
      (typeof provider.getPublicKey === "function" ? await provider.getPublicKey().catch(() => null) : null);

    if (!address?.startsWith("kaspa:")) {
      throw new Error("Connect Kasware first so the vault test can use your Kaspa address.");
    }

    if (!publicKey) {
      throw new Error("Kasware did not expose a public key. Reconnect Kasware and try again.");
    }

    const requestParams = new URLSearchParams({ address, publicKey, ...extraParams });
    const response = await fetch(apiPath(`/api/covenant-test?${requestParams.toString()}`), { cache: "no-store" });
    const draft = await response.json();

    if (!response.ok) {
      throw new Error(draft.error || "Could not create vault draft.");
    }

    const toSignInputs = [{ index: 0, address, publicKey }];
    const signOptions = { autoFinalized: false, autoFinalize: false, toSignInputs };

    return { address, publicKey, draft, toSignInputs, signOptions };
  }

  async function createOpTrueVaultTx() {
    setStatus("");
    setOpTrueVaultResult({ loading: true });
    setOpTrueVaultBroadcastResult(null);
    setOpTrueUnlockResult(null);
    setOpTrueUnlockBroadcastResult(null);

    try {
      const { draft, toSignInputs, signOptions } = await getSigningContext({ vaultScriptType: "optrue" });

      if (!draft.kasVaultTxJson) {
        throw new Error("The API did not create an OP_TRUE KAS vault transaction.");
      }

      const signed = await provider.signPskt({
        txJsonString: draft.kasVaultTxJson,
        options: signOptions,
      });

      setOpTrueVaultResult({
        loading: false,
        ok: true,
        draft,
        toSignInputs,
        signOptions,
        signed,
      });
    } catch (error) {
      setOpTrueVaultResult({ loading: false, ok: false, error: error?.message || String(error) });
    }
  }

  async function broadcastOpTrueVaultTx() {
    setOpTrueVaultBroadcastResult({ loading: true });

    try {
      if (!opTrueVaultResult?.ok || typeof opTrueVaultResult.signed !== "string") {
        throw new Error("Create and sign an OP_TRUE vault transaction before broadcasting.");
      }

      const response = await fetch(apiPath("/api/covenant-broadcast"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTxJson: opTrueVaultResult.signed }),
      });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Broadcast failed.");
      setOpTrueVaultBroadcastResult({ loading: false, ok: true, data });
    } catch (error) {
      setOpTrueVaultBroadcastResult({ loading: false, ok: false, error: error?.message || String(error) });
    }
  }

  async function createOpTrueUnlockTx() {
    setOpTrueUnlockResult({ loading: true });
    setOpTrueUnlockBroadcastResult(null);

    try {
      const { address, publicKey, draft: signingDraft } = await getSigningContext({ vaultScriptType: "optrue" });
      const vaultAddress = signingDraft.ownerVault?.address;

      if (!vaultAddress) {
        throw new Error("Could not derive OP_TRUE vault address.");
      }

      const response = await fetch(
        apiPath(`/api/covenant-unlock?${new URLSearchParams({
          address,
          publicKey,
          vaultAddress,
          vaultScriptType: "optrue",
        }).toString()}`),
        { cache: "no-store" },
      );
      const draft = await response.json();

      if (!response.ok) throw new Error(draft.error || "Could not create OP_TRUE vault unlock draft.");
      if (!draft.readyToBroadcast) throw new Error("OP_TRUE unlock draft was not marked ready to broadcast.");

      setOpTrueUnlockResult({ loading: false, ok: true, draft, signed: draft.unlockTxJson });
    } catch (error) {
      setOpTrueUnlockResult({ loading: false, ok: false, error: error?.message || String(error) });
    }
  }

  async function broadcastOpTrueUnlockTx() {
    setOpTrueUnlockBroadcastResult({ loading: true });

    try {
      if (!opTrueUnlockResult?.ok || typeof opTrueUnlockResult.signed !== "string") {
        throw new Error("Create an OP_TRUE vault unlock transaction before broadcasting.");
      }

      const response = await fetch(apiPath("/api/covenant-broadcast"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTxJson: opTrueUnlockResult.signed }),
      });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Broadcast failed.");
      setOpTrueUnlockBroadcastResult({ loading: false, ok: true, data });
    } catch (error) {
      setOpTrueUnlockBroadcastResult({ loading: false, ok: false, error: error?.message || String(error) });
    }
  }

  async function createTimeLockVaultTx() {
    setTimeLockCreateResult({ loading: true });
    setTimeLockCreateBroadcastResult(null);
    setTimeLockUnlockResult(null);
    setTimeLockUnlockBroadcastResult(null);

    try {
      const account = visibleReport.accounts?.[0];
      const address = typeof account === "string" ? account : account?.address;

      if (!address?.startsWith("kaspa:")) {
        throw new Error("Connect Kasware first so the time-lock test can use your Kaspa address.");
      }

      setTimeLockCreateResult({
        loading: false,
        prepared: true,
        ok: false,
        address,
        draft: {
          vaultName: timeLockVaultName,
          lockSeconds: timeLockSeconds,
          lockAmountKas: timeLockAmountKas,
        },
      });
    } catch (error) {
      setTimeLockCreateResult({ loading: false, ok: false, error: error?.message || String(error) });
    }
  }

  async function broadcastTimeLockVaultCreateTx() {
    setTimeLockCreateBroadcastResult({ loading: true });

    try {
      if (!timeLockCreateResult?.prepared) {
        throw new Error("Prepare a time-locked vault before broadcasting.");
      }

      if (!provider || typeof provider.signPskt !== "function") {
        throw new Error("Kasware signPskt is required to sign the time-locked vault create transaction.");
      }

      const account = visibleReport.accounts?.[0];
      const address = typeof account === "string" ? account : account?.address;
      const publicKey =
        visibleReport.publicKey ||
        (typeof account === "object" ? account?.publicKey || account?.pubkey || account?.pubKey : null) ||
        (typeof provider.getPublicKey === "function" ? await provider.getPublicKey().catch(() => null) : null);

      if (!address?.startsWith("kaspa:")) {
        throw new Error("Connect Kasware first so the time-lock test can use your Kaspa address.");
      }

      if (!publicKey) {
        throw new Error("Kasware did not expose a public key. Reconnect Kasware and try again.");
      }

      const draftResponse = await fetch(
        apiPath(`/api/timelock-vault?${new URLSearchParams({
          action: "create",
          address,
          vaultName: timeLockCreateResult.draft?.vaultName || timeLockVaultName,
          lockSeconds: timeLockCreateResult.draft?.lockSeconds || timeLockSeconds,
          amountKas: timeLockCreateResult.draft?.lockAmountKas || timeLockAmountKas,
        }).toString()}`),
        { cache: "no-store" },
      );
      const draft = await draftResponse.json();

      if (!draftResponse.ok) throw new Error(draft.error || "Could not create time-locked vault transaction.");

      const toSignInputs = [{ index: 0, address, publicKey }];
      const signOptions = { autoFinalized: false, autoFinalize: false, toSignInputs };
      const signed = await provider.signPskt({ txJsonString: draft.txJson, options: signOptions });
      const response = await fetch(apiPath("/api/covenant-broadcast"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTxJson: signed }),
      });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Broadcast failed.");
      const broadcastedAtIso = new Date().toISOString();
      const deployTxId = data.txId || data.result?.transactionId || null;
      const activeDraft = {
        ...draft,
        deployTxId,
        selectedOutpoint: deployTxId ? { transactionId: deployTxId, index: 0 } : null,
        broadcastedAtIso,
      };

      setTimeLockCreateResult({ loading: false, ok: true, draft: activeDraft, toSignInputs, signOptions, signed });
      setTimeLockCreateBroadcastResult({ loading: false, ok: true, data });
      setDiscoveredTimeLockVaults((vaults) => [activeDraft, ...vaults.filter((vault) => vault.vault?.address !== activeDraft.vault?.address)]);
      saveActiveTimeLockVault(address, { draft: activeDraft, signed, broadcast: data });
    } catch (error) {
      setTimeLockCreateBroadcastResult({ loading: false, ok: false, error: error?.message || String(error) });
    }
  }

  async function createTimeLockUnlockTx() {
    setTimeLockUnlockResult({ loading: true });
    setTimeLockUnlockBroadcastResult(null);

    try {
      if (!activeTimeLockBroadcasted) {
        throw new Error("Broadcast the time-locked vault first.");
      }

      const account = visibleReport.accounts?.[0];
      const address = typeof account === "string" ? account : account?.address;

      if (!address?.startsWith("kaspa:")) {
        throw new Error("Connect the wallet that should receive the unlocked KAS.");
      }

      const response = await fetch(
        apiPath(`/api/timelock-vault?${new URLSearchParams({
          action: "unlock",
          address,
          ownerAddress: timeLockCreateResult.draft?.address || timeLockCreateResult.draft?.payload?.ownerAddress || address,
          vaultAddress: timeLockCreateResult.draft?.vault?.address,
          unlockTime: timeLockCreateResult.draft?.vault?.unlockTime,
          redeemScript: timeLockCreateResult.draft?.vault?.redeemScript,
        }).toString()}`),
        { cache: "no-store" },
      );
      const draft = await response.json();

      if (!response.ok) throw new Error(draft.error || "Could not create time-locked vault unlock transaction.");

      setTimeLockUnlockResult({ loading: false, ok: true, draft, signed: draft.txJson });
    } catch (error) {
      setTimeLockUnlockResult({ loading: false, ok: false, error: error?.message || String(error) });
    }
  }

  async function broadcastTimeLockUnlockTx() {
    setTimeLockUnlockBroadcastResult({ loading: true });

    try {
      if (!timeLockUnlockResult?.ok || typeof timeLockUnlockResult.signed !== "string") {
        throw new Error("Create a time-locked vault unlock transaction before broadcasting.");
      }

      if (timeLockRemainingMs > 0) {
        throw new Error(`The vault is still locked. Try again in ${formatDuration(timeLockRemainingMs)}.`);
      }

      const account = visibleReport.accounts?.[0];
      const address = typeof account === "string" ? account : account?.address;

      const statusResponse = await fetch(
        apiPath(`/api/timelock-vault?${new URLSearchParams({
          action: "status",
          unlockTime: timeLockUnlockResult.draft?.unlockTime,
        }).toString()}`),
        { cache: "no-store" },
      );
      const statusData = await statusResponse.json();

      if (!statusResponse.ok) throw new Error(statusData.error || "Could not check vault lock status.");
      if (!statusData.readyToBroadcast) {
        throw new Error(
          `The vault is still locked for about ${statusData.estimatedRemainingSeconds}s (${statusData.remainingDaaBlocks} DAA blocks).`,
        );
      }

      const response = await fetch(apiPath("/api/covenant-broadcast"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTxJson: timeLockUnlockResult.signed }),
      });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Broadcast failed.");
      setTimeLockUnlockBroadcastResult({ loading: false, ok: true, data });
      removeActiveTimeLockVault(address);
    } catch (error) {
      setTimeLockUnlockBroadcastResult({ loading: false, ok: false, error: error?.message || String(error) });
    }
  }

  async function createDmsVaultTx() {
    setDmsCreateResult({ loading: true });
    setDmsCreateBroadcastResult(null);
    setDmsReleaseResult(null);
    setDmsReleaseBroadcastResult(null);
    setDmsPulseResult(null);

    try {
      const account = visibleReport.accounts?.[0];
      const address = typeof account === "string" ? account : account?.address;

      if (!isKaspaAddress(address)) {
        throw new Error("Connect Kasware first so the dead-man-switch can use your Kaspa address.");
      }

      if (!isKaspaAddress(dmsBeneficiaryAddress)) {
        throw new Error("The beneficiary address is not a valid Kaspa address. Paste the full kaspa: address before preparing the dead-man-switch.");
      }

      if (!parsePositiveKas(dmsAmountKas)) {
        throw new Error("Enter a valid KAS amount greater than 0 before preparing the dead-man-switch.");
      }

      setDmsCreateResult({
        loading: false,
        prepared: true,
        ok: false,
        address,
        draft: {
          vaultName: dmsVaultName,
          lockSeconds: dmsSeconds,
          lockAmountKas: dmsAmountKas,
          beneficiaryAddress: dmsBeneficiaryAddress,
        },
      });
    } catch (error) {
      setDmsCreateResult(errorResult(error));
    }
  }

  async function broadcastDmsVaultCreateTx() {
    setDmsCreateBroadcastResult({ loading: true });

    try {
      if (!dmsCreateResult?.prepared) {
        throw new Error("Prepare a dead-man-switch vault before broadcasting.");
      }

      if (!provider || typeof provider.signPskt !== "function") {
        throw new Error("Kasware signPskt is required to sign the dead-man-switch create transaction.");
      }

      const account = visibleReport.accounts?.[0];
      const address = typeof account === "string" ? account : account?.address;
      const publicKey =
        visibleReport.publicKey ||
        (typeof account === "object" ? account?.publicKey || account?.pubkey || account?.pubKey : null) ||
        (typeof provider.getPublicKey === "function" ? await provider.getPublicKey().catch(() => null) : null);

      if (!isKaspaAddress(address)) {
        throw new Error("Connect Kasware first so the dead-man-switch can use your Kaspa address.");
      }

      if (!publicKey) {
        throw new Error("Kasware did not expose a public key. Reconnect Kasware and try again.");
      }

      const beneficiaryAddress = dmsCreateResult.draft?.beneficiaryAddress || dmsBeneficiaryAddress;
      const amountKas = dmsCreateResult.draft?.lockAmountKas || dmsAmountKas;

      if (!isKaspaAddress(beneficiaryAddress)) {
        throw new Error("The beneficiary address is not a valid Kaspa address. Paste the full kaspa: address before creating the vault.");
      }

      if (!parsePositiveKas(amountKas)) {
        throw new Error("Enter a valid KAS amount greater than 0 before creating the vault.");
      }

      const draftResponse = await fetch(
        apiPath(`/api/timelock-vault?${new URLSearchParams({
          action: "dms-create",
          address,
          publicKey,
          vaultName: dmsCreateResult.draft?.vaultName || dmsVaultName,
          beneficiaryAddress,
          lockSeconds: dmsCreateResult.draft?.lockSeconds || dmsSeconds,
          amountKas,
        }).toString()}`),
        { cache: "no-store" },
      );
      const draft = await readApiResponse(draftResponse, "Could not create dead-man-switch vault transaction.");

      const toSignInputs = [{ index: 0, address, publicKey }];
      const signOptions = { autoFinalized: false, autoFinalize: false, toSignInputs };
      const signed = await provider.signPskt({ txJsonString: draft.txJson, options: signOptions });
      const response = await fetch(apiPath("/api/covenant-broadcast"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTxJson: signed }),
      });
      const data = await readApiResponse(response, "Could not broadcast dead-man-switch vault.");
      const broadcastedAtIso = new Date().toISOString();
      const deployTxId = data.txId || data.result?.transactionId || null;
      const activeDraft = {
        ...draft,
        deployTxId,
        selectedOutpoint: deployTxId ? { transactionId: deployTxId, index: 0 } : null,
        broadcastedAtIso,
      };

      setDmsCreateResult({ loading: false, ok: true, draft: activeDraft, toSignInputs, signOptions, signed });
      setDmsCreateBroadcastResult({ loading: false, ok: true, data });
      setDmsAutoReleaseAttempted(false);
      setDiscoveredDmsVaults((vaults) => mergeVaultLists(vaults, [activeDraft]));
      saveActiveDmsVault(address, { draft: activeDraft, signed, broadcast: data });
    } catch (error) {
      setDmsCreateBroadcastResult(errorResult(error));
    }
  }

  async function sendDmsPulse() {
    setDmsPulseResult({ loading: true });

    try {
      if (!activeDmsBroadcasted) {
        throw new Error("Select or create an active dead-man-switch vault before sending a pulse.");
      }

      if (!provider || typeof provider.signPskt !== "function") {
        throw new Error("Kasware signPskt is required to sign the pulse transaction.");
      }

      const account = visibleReport.accounts?.[0];
      const address = typeof account === "string" ? account : account?.address;
      const publicKey =
        visibleReport.publicKey ||
        (typeof account === "object" ? account?.publicKey || account?.pubkey || account?.pubKey : null) ||
        (typeof provider.getPublicKey === "function" ? await provider.getPublicKey().catch(() => null) : null);
      const draft = dmsCreateResult?.draft || {};
      const beneficiaryAddress = draft.beneficiaryAddress || draft.payload?.beneficiaryAddress || dmsBeneficiaryAddress;
      const ownerPublicKey = draft.ownerPublicKey || draft.payload?.ownerPublicKey || publicKey;
      const inactivityDaaBlocks = draft.inactivityDaaBlocks || draft.payload?.inactivityDaaBlocks;

      if (!isKaspaAddress(address)) {
        throw new Error("Connect the owner wallet before sending a pulse.");
      }

      if (draft.ownerAddress && address !== draft.ownerAddress) {
        throw new Error("Only the vault creator can send an owner pulse for this dead-man-switch vault.");
      }

      if (!ownerPublicKey || !inactivityDaaBlocks) {
        throw new Error("This is an older dead-man-switch vault and cannot be pulsed. Create a new heartbeat-enabled DMS vault.");
      }

      const pulseResponse = await fetch(
        apiPath(`/api/timelock-vault?${new URLSearchParams({
          action: "dms-heartbeat",
          address,
          publicKey: ownerPublicKey,
          beneficiaryAddress,
          vaultAddress: draft.vault?.address,
          inactivityDaaBlocks,
          outpointTxId: draft.selectedOutpoint?.transactionId || draft.selectedOutpoint?.transaction_id || draft.selectedOutpoint?.txId || "",
          outpointIndex: draft.selectedOutpoint?.index ?? "",
          redeemScript: draft.vault?.redeemScript,
        }).toString()}`),
        { cache: "no-store" },
      );
      const pulseDraft = await readApiResponse(pulseResponse, "Could not create dead-man-switch pulse transaction.");
      const toSignInputs = [
        { index: 0, address, publicKey },
        { index: 1, address, publicKey },
      ];
      const signOptions = {
        autoFinalized: false,
        autoFinalize: false,
        toSignInputs,
        redeemScript: pulseDraft.redeemScript,
      };
      const signed = await provider.signPskt({ txJsonString: pulseDraft.txJson, options: signOptions });
      const response = await fetch(apiPath("/api/covenant-broadcast"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signedTxJson: signed,
          redeemScript: pulseDraft.redeemScript,
          branch: pulseDraft.branch,
        }),
      });
      const data = await readApiResponse(response, "Could not broadcast dead-man-switch pulse.");
      const refreshedDraft = {
        ...draft,
        selectedOutpoint: (data.txId || data.result?.transactionId)
          ? { transactionId: data.txId || data.result?.transactionId, index: 0 }
          : draft.selectedOutpoint,
        estimatedUnlockTimeIso: pulseDraft.estimatedUnlockTimeIso,
        lastPulseBlueScore: pulseDraft.currentBlueScore,
        lastPulseTxId: data.txId || data.result?.transactionId || null,
        lastPulseAtIso: new Date().toISOString(),
      };

      setDmsCreateResult((current) => ({ ...(current || {}), loading: false, ok: true, draft: refreshedDraft }));
      setDmsCreateBroadcastResult((current) => current || { loading: false, ok: true, data: { status: "Vault selected" } });
      setDmsPulseResult({ loading: false, ok: true, draft: pulseDraft, data });
      setDiscoveredDmsVaults((vaults) => mergeVaultLists(vaults, [refreshedDraft]));
      saveActiveDmsVault(address, { draft: refreshedDraft, signed: "", broadcast: data });
    } catch (error) {
      setDmsPulseResult(errorResult(error));
    }
  }

  async function createDmsReleaseTx() {
    setDmsReleaseResult({ loading: true });
    setDmsReleaseBroadcastResult(null);

    try {
      if (!activeDmsBroadcasted) {
        throw new Error("Broadcast the dead-man-switch vault first.");
      }

      const beneficiaryAddress =
        dmsCreateResult.draft?.beneficiaryAddress ||
        dmsCreateResult.draft?.payload?.beneficiaryAddress ||
        dmsBeneficiaryAddress;

      const response = await fetch(
        apiPath(`/api/timelock-vault?${new URLSearchParams({
          action: "dms-release",
          beneficiaryAddress,
          vaultAddress: dmsCreateResult.draft?.vault?.address,
          unlockTime: dmsCreateResult.draft?.vault?.unlockTime,
          inactivityDaaBlocks: dmsCreateResult.draft?.inactivityDaaBlocks || dmsCreateResult.draft?.payload?.inactivityDaaBlocks || "",
          ownerPublicKey: dmsCreateResult.draft?.ownerPublicKey || dmsCreateResult.draft?.payload?.ownerPublicKey || "",
          createdBlueScore: dmsCreateResult.draft?.payload?.createdBlueScore || dmsCreateResult.draft?.currentBlueScore || "",
          lastPulseBlueScore: dmsCreateResult.draft?.lastPulseBlueScore || "",
          outpointTxId: dmsCreateResult.draft?.selectedOutpoint?.transactionId || dmsCreateResult.draft?.selectedOutpoint?.transaction_id || dmsCreateResult.draft?.selectedOutpoint?.txId || "",
          outpointIndex: dmsCreateResult.draft?.selectedOutpoint?.index ?? "",
          redeemScript: dmsCreateResult.draft?.vault?.redeemScript,
        }).toString()}`),
        { cache: "no-store" },
      );
      const draft = await readApiResponse(response, "Could not create dead-man-switch release transaction.");

      setDmsReleaseResult({ loading: false, ok: true, draft, signed: draft.txJson });
    } catch (error) {
      setDmsReleaseResult(errorResult(error));
    }
  }

  async function broadcastDmsReleaseTx() {
    setDmsReleaseBroadcastResult({ loading: true });

    try {
      if (!dmsReleaseResult?.ok || typeof dmsReleaseResult.signed !== "string") {
        throw new Error("Create a dead-man-switch release transaction before broadcasting.");
      }

      if (dmsRemainingMs > 0) {
        throw new Error(`The dead-man-switch is still locked. Try again in ${formatDuration(dmsRemainingMs)}.`);
      }

      const response = await fetch(apiPath("/api/covenant-broadcast"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTxJson: dmsReleaseResult.signed }),
      });
      const data = await readApiResponse(response, "Could not broadcast dead-man-switch release.");
      setDmsReleaseBroadcastResult({ loading: false, ok: true, data });

      const account = visibleReport.accounts?.[0];
      const address = typeof account === "string" ? account : account?.address;
      removeActiveDmsVault(address);
    } catch (error) {
      setDmsReleaseBroadcastResult(errorResult(error));
    }
  }

  const timeLockDebug = {
    create: timeLockCreateResult,
    broadcast: timeLockCreateBroadcastResult,
    unlock: timeLockUnlockResult,
    unlockBroadcast: timeLockUnlockBroadcastResult,
  };
  const dmsDebug = {
    create: dmsCreateResult,
    broadcast: dmsCreateBroadcastResult,
    pulse: dmsPulseResult,
    scan: dmsScanResult,
    release: dmsReleaseResult,
    releaseBroadcast: dmsReleaseBroadcastResult,
  };
  const ownedVaults = [
    ...discoveredTimeLockVaults.map((vault, index) => ({
      kind: "timeLock",
      raw: vault,
      name: vault.vaultName || vault.payload?.vaultName || `Time lock ${index + 1}`,
      type: "Time-locked vault",
      address: vault.vault?.address,
      amount: `${vault.lockAmountKas || "?"} KAS`,
      unlock: vault.estimatedUnlockTimeIso,
      ready: vault.readyToBroadcast,
      id: `time-${vault.deployTxId || vault.vault?.address}`,
    })),
    ...discoveredDmsVaults.map((vault, index) => ({
      kind: "dms",
      raw: vault,
      name: vault.vaultName || vault.payload?.vaultName || `Dead man's switch ${index + 1}`,
      type: "Dead-man-switch vault",
      address: vault.vault?.address,
      amount: `${vault.lockAmountKas || "?"} KAS`,
      unlock: vault.estimatedUnlockTimeIso,
      ready: vault.readyToBroadcast,
      beneficiary: vault.beneficiaryAddress,
      id: `dms-${vault.selectedOutpoint?.transactionId || vault.selectedOutpoint?.transaction_id || vault.selectedOutpoint?.txId || vault.deployTxId || vault.vault?.address}-${vault.selectedOutpoint?.index ?? index}`,
    })),
  ];

  return (
    <main className="vaultPage">
      <header className="vaultHeader">
        <div>
          <button className="titleButton" type="button" onClick={() => window.location.reload()} data-darkreader-ignore>
            <img className="headerBrandLogo" src="/kascoven-logo.png" alt="" aria-hidden="true" />
            {recoveryMode ? "KasCoven Recovery Tool" : "KasCoven Vaults"}
          </button>
          <p>{recoveryMode ? "Connect a wallet, import recovery data and refresh the live Kaspa state" : "Time-locked covenant vaults on the Kaspa blockDAG"}</p>
        </div>
        <button
          className="mobileMenuButton"
          type="button"
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileMenuOpen}
          aria-controls="vault-mobile-menu"
          onClick={() => {
            setMobileMenuOpen((open) => !open);
            setWalletMenuOpen(false);
          }}
        >
          <span />
          <span />
          <span />
        </button>
        <nav
          id="vault-mobile-menu"
          className={`walletActions${mobileMenuOpen ? " isOpen" : ""}`}
          aria-label="Wallet actions"
        >
          <a className="recoveryNavLink" href="/recovery" onClick={() => setMobileMenuOpen(false)}>Recovery</a>
          <button className="vaultIconButton" type="button" onClick={() => { openMyVaults(); setMobileMenuOpen(false); }} title="My vaults" aria-label="My vaults">
            <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
              <rect className="vaultIconFrame" x="7" y="7" width="34" height="34" rx="7" />
              <circle className="vaultIconDial" cx="24" cy="24" r="9" />
              <path className="vaultIconSpoke" d="M24 15v5M24 28v5M15 24h5M28 24h5M18 18l3.5 3.5M30 30l-3.5-3.5M30 18l-3.5 3.5M18 30l3.5-3.5" />
              <path className="vaultIconLock" d="M19 26.5h10v7H19zM21 26.5v-2.2a3 3 0 0 1 6 0v2.2" />
            </svg>
          </button>
          <div className="walletConnectMenu">
            <button className="connectWalletButton" type="button" onClick={() => accountAddress ? null : setWalletMenuOpen((open) => !open)}>
              {accountAddress ? `${visibleReport.walletName || "Wallet"} · ${shortAddress(accountAddress)}` : "Connect Wallet"}
            </button>
            {walletMenuOpen && !accountAddress ? (
              <div className="walletConnectDropdown" role="menu">
                <button type="button" role="menuitem" onClick={() => { setMobileMenuOpen(false); connectWithKaspire(); }}>
                  <strong>Kaspire</strong><span>Mobile · WalletConnect</span>
                </button>
                <button type="button" role="menuitem" onClick={() => { setMobileMenuOpen(false); connectKasware(); }}>
                  <strong>Kasware</strong><span>Browser extension</span>
                </button>
              </div>
            ) : null}
          </div>

          <button className="disconnectButton" type="button" onClick={() => { setMobileMenuOpen(false); disconnect(); }} disabled={!accountAddress}>
            Disconnect
          </button>
        </nav>
      </header>

      <section className="vaultIntro">
        <p className="vaultEyebrow">KASPA L1 · NON-CUSTODIAL · COVENANT ENFORCED</p>
        <h1 className={recoveryMode ? undefined : "vaultSovereigntyTitle"}>{recoveryMode ? "Recover access. Keep control." : "Your money. Your rules."}</h1>
        <p className="vaultIntroLead">{recoveryMode ? "Restore vault context from portable records or Kaspa on-chain data, then authorize only the action the covenant permits." : "Programmable self-custody and true sovereignty. Secured by covenant logic and Kaspa consensus."}</p>
        <div className="vaultTrustRow" aria-label="Vault guarantees">
          <span><i />Your keys stay in your wallet</span>
          <span><i />Rules enforced on Kaspa L1</span>
          <span><i />Portable recovery path</span>
        </div>
      </section>

      {recoveryMode ? (
        <div className="topStatus">
          Recovery mode: connect Kaspire or Kasware, then import a recovery JSON file or scan the connected address. Wallet approval is requested only when the selected covenant path requires a signature.
        </div>
      ) : null}

      {status ? <div className="topStatus">{status}</div> : null}

      {kaspireAction ? (
        <aside className="kaspireActionPrompt" role="alert" aria-live="assertive">
          <strong>{kaspireAction.title}</strong>
          <p>{kaspireAction.message}</p>
          <a className="connectWalletButton" href={kaspireAction.launchUrl}>Open Kaspire</a>
          <span>This notice closes automatically after confirmation.</span>
        </aside>
      ) : null}

      {pairing ? (
        <div className="pairingOverlay" role="dialog" aria-modal="true" aria-label="Connect Kaspire">
          <div className="pairingCard">
            <button className="pairingClose" type="button" onClick={() => setPairing(null)} aria-label="Close">×</button>
            <h2>Connect Kaspire</h2>
            <p>Scan this QR code with Kaspire or open the verified app link on this device.</p>
            <img src={pairing.qrDataUrl} alt="Kaspire WalletConnect QR code" />
            <a className="connectWalletButton" href={/Android/i.test(window.navigator.userAgent) ? pairing.intentLink : pairing.appLink}>Open Kaspire</a>
          </div>
        </div>
      ) : null}

      {showMyVaults ? (
        <section className="myVaultsPanel">
          <div>
            <h2>My vaults</h2>
            <p>{accountAddress ? `Connected wallet: ${shortAddress(accountAddress)}` : "Connect a wallet to scan your vaults."}</p>
          </div>
          <div className="myVaultActions">
            <input ref={recoveryFileInputRef} type="file" accept="application/json,.json" hidden onChange={importRecoveryFile} />
            <button type="button" onClick={() => recoveryFileInputRef.current?.click()}>
              Import recovery file
            </button>
            <button type="button" onClick={() => scanDmsVaultsForBeneficiary(accountAddress)} disabled={!accountAddress}>
              Scan beneficiary vaults
            </button>
          </div>
          {ownedVaults.length ? (
            <div className="ownedVaultGrid">
              {ownedVaults.map((vault) => (
                <div className="ownedVault" key={vault.id}>
                  <strong>{vault.name}</strong>
                  <small>{vault.type}</small>
                  <span>{vault.amount}</span>
                  <code>{vault.address}</code>
                  {vault.beneficiary ? <small>Beneficiary: {shortAddress(vault.beneficiary)}</small> : null}
                  <small>{vault.ready ? "Ready to release" : "Still locked"}</small>
                  <small>{vault.unlock ? `Unlock estimate: ${new Date(vault.unlock).toLocaleString()}` : "Unlock time pending"}</small>
                  <button type="button" onClick={() => (vault.kind === "timeLock" ? selectTimeLockVault(vault.raw) : selectDmsVault(vault.raw))}>
                    {vault.kind === "timeLock" ? "Select to unlock" : "Select to claim"}
                  </button>
                  <button type="button" onClick={() => exportRawVaultRecovery(vault.kind, vault.raw)}>
                    Export recovery
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="emptyVaults">No active vaults found for this browser session or wallet scan yet.</p>
          )}
        </section>
      ) : null}

      <section className="vaultHeroCards" aria-label="Vault types">
        <article className={`vaultChoice ${selectedVault === "timeLock" ? "isSelected" : ""}`}>
          <img src="/timelockedvault.png" alt="Time-locked Kaspa covenant vault" />
          <div>
            <h2>Time-Locked Vault</h2>
            <p>Lock KAS until a chosen blockDAG time, then release it back to your connected wallet.</p>
            <button type="button" onClick={() => setSelectedVault("timeLock")}>
              Start time lock
            </button>
          </div>
        </article>

        <article className={`vaultChoice ${selectedVault === "dms" ? "isSelected" : ""}`}>
          <img src="/deadmansswitch.png" alt="Dead-man-switch Kaspa covenant vault" />
          <div>
            <h2>Dead Man's Switch</h2>
            <p>Lock KAS for a beneficiary. After the timer expires, the beneficiary can discover and claim it.</p>
            <button type="button" onClick={() => setSelectedVault("dms")}>
              Start dead man's switch
            </button>
          </div>
        </article>
      </section>

      {selectedVault === "timeLock" ? (
        <section className="processPanel">
          <div className="processHeader">
            <p className="vaultEyebrow">CREATE VAULT</p>
            <h2>Time-Locked Vault</h2>
            <p>Choose the amount and lock duration. The timer starts only after the connected wallet signs and the transaction is broadcast.</p>
          </div>

          <div className="formGrid">
            <label className="vaultField wide">
              Vault name
              <input value={timeLockVaultName} onChange={(event) => setTimeLockVaultName(event.target.value)} maxLength={64} />
            </label>
            <label className="vaultField">
              Amount to lock
              <input value={timeLockAmountKas} onChange={(event) => setTimeLockAmountKas(event.target.value)} inputMode="decimal" />
            </label>
            <label className="vaultField">
              Lock duration in seconds
              <input value={timeLockSeconds} onChange={(event) => setTimeLockSeconds(event.target.value)} inputMode="numeric" />
            </label>
          </div>

          <div className="stepGrid">
            <div className="stepCard">
              <span>1</span>
              <h3>Prepare</h3>
              <p>Review amount and duration before creating the on-chain vault transaction.</p>
              <button type="button" onClick={createTimeLockVaultTx}>Prepare vault</button>
            </div>
            <div className="stepCard">
              <span>2</span>
              <h3>Sign and broadcast</h3>
              <p>The connected wallet signs the funding transaction. The lock countdown starts after broadcast.</p>
              <button type="button" onClick={broadcastTimeLockVaultCreateTx} disabled={!timeLockCreateResult?.prepared}>
                Sign and broadcast
              </button>
            </div>
          </div>

          <StatusNotice
            result={timeLockCreateResult}
            loadingText="Preparing your time-locked vault..."
            successTitle={timeLockCreateResult?.ok ? "Vault is live" : "Vault is ready to sign"}
            errorTitle="Time-lock setup failed"
          >
            <InfoGrid
              items={[
                { label: "Name", value: timeLockCreateResult?.draft?.vaultName || timeLockCreateResult?.draft?.payload?.vaultName || timeLockVaultName },
                { label: "Amount", value: `${timeLockCreateResult?.draft?.lockAmountKas || timeLockAmountKas} KAS` },
                { label: "Duration", value: `${timeLockCreateResult?.draft?.lockSeconds || timeLockSeconds}s` },
                { label: "Vault", value: shortAddress(timeLockCreateResult?.draft?.vault?.address) },
                { label: "Unlock estimate", value: timeLockCreateResult?.draft?.estimatedUnlockTimeIso ? new Date(timeLockCreateResult.draft.estimatedUnlockTimeIso).toLocaleString() : "After broadcast" },
              ]}
            />
            <DebugDetails data={timeLockDebug} />
          </StatusNotice>

          <StatusNotice
            result={timeLockCreateBroadcastResult}
            loadingText="Broadcasting the vault transaction..."
            successTitle="Vault broadcast submitted"
            errorTitle="Vault broadcast failed"
          >
            <p>Your KAS is now locked by the covenant. Wait for the unlock time before creating the release transaction.</p>
            <DebugDetails data={timeLockCreateBroadcastResult} />
          </StatusNotice>

          <div className="releaseSection" ref={timeLockReleaseRef}>
            <div>
              <p className="vaultEyebrow">UNLOCK VAULT</p>
              <h3>{timeLockRemainingMs > 0 ? `Locked for ${formatDuration(timeLockRemainingMs)} more` : "Ready to unlock"}</h3>
              <p>Create the release transaction after the countdown. It can only return to the owner address pinned in the covenant.</p>
            </div>
            <div className="actionPair">
              {discoveredTimeLockVaults.length > 1 ? (
                <select className="vaultSelect" value={timeLockCreateResult?.draft?.vault?.address || ""} onChange={(event) => selectTimeLockVault(discoveredTimeLockVaults.find((vault) => vault.vault?.address === event.target.value))}>
                  <option value="">Choose vault</option>
                  {discoveredTimeLockVaults.map((vault, index) => (
                    <option value={vault.vault?.address} key={vault.vault?.address}>
                      {vault.vaultName || vault.payload?.vaultName || `Time lock ${index + 1}`} - {vault.lockAmountKas} KAS
                    </option>
                  ))}
                </select>
              ) : null}
              <button type="button" onClick={createTimeLockUnlockTx} disabled={!activeTimeLockBroadcasted}>
                Create unlock
              </button>
              <button type="button" onClick={broadcastTimeLockUnlockTx} disabled={!timeLockCanBroadcast}>
                Broadcast unlock
              </button>
              <button
                type="button"
                onClick={() => exportVaultRecovery("timeLock", timeLockCreateResult?.draft, timeLockCreateBroadcastResult?.data)}
                disabled={!timeLockCreateResult?.draft?.vault?.address}
              >
                Export recovery
              </button>
            </div>
          </div>

          <StatusNotice result={timeLockUnlockResult} loadingText="Creating unlock transaction..." successTitle="Unlock transaction ready" errorTitle="Unlock creation failed">
            <InfoGrid
              items={[
                { label: "Return amount", value: `${timeLockUnlockResult?.draft?.returnAmountKas || ""} KAS` },
                { label: "Estimated fee", value: `${timeLockUnlockResult?.draft?.estimatedFeeKas || ""} KAS` },
              ]}
            />
            <DebugDetails data={timeLockUnlockResult} />
          </StatusNotice>
          <StatusNotice result={timeLockUnlockBroadcastResult} loadingText="Broadcasting unlock..." successTitle="Unlock broadcast submitted" errorTitle="Unlock broadcast failed">
            <p>Your vault has been opened and funds will appear in your wallet now.</p>
            <DebugDetails data={timeLockUnlockBroadcastResult} />
          </StatusNotice>
        </section>
      ) : (
        <section className="processPanel">
          <div className="processHeader">
            <p className="vaultEyebrow">CREATE VAULT</p>
            <h2>Dead Man's Switch</h2>
            <p>Set a beneficiary address. A small notice output lets that address discover and claim the vault later.</p>
          </div>

          <div className="formGrid">
            <label className="vaultField wide">
              Vault name
              <input value={dmsVaultName} onChange={(event) => setDmsVaultName(event.target.value)} maxLength={64} />
            </label>
            <label className="vaultField">
              Amount to lock
              <input value={dmsAmountKas} onChange={(event) => setDmsAmountKas(event.target.value)} inputMode="decimal" />
            </label>
            <label className="vaultField">
              Inactivity timer in seconds
              <input value={dmsSeconds} onChange={(event) => setDmsSeconds(event.target.value)} inputMode="numeric" />
            </label>
            <label className="vaultField wide">
              Beneficiary address
              <input value={dmsBeneficiaryAddress} onChange={(event) => setDmsBeneficiaryAddress(event.target.value.trim())} placeholder="kaspa:..." spellCheck={false} />
            </label>
          </div>

          <div className="stepGrid">
            <div className="stepCard">
              <span>1</span>
              <h3>Prepare</h3>
              <p>Review amount, timer and beneficiary before creating the DMS vault.</p>
              <button type="button" onClick={createDmsVaultTx}>Prepare vault</button>
            </div>
            <div className="stepCard">
              <span>2</span>
              <h3>Sign and broadcast</h3>
              <p>Fund the vault and send the discoverable notice to the beneficiary.</p>
              <button type="button" onClick={broadcastDmsVaultCreateTx} disabled={!dmsCreateResult?.prepared}>
                Sign and broadcast
              </button>
            </div>
          </div>

          <StatusNotice result={dmsCreateResult} loadingText="Preparing dead-man-switch vault..." successTitle={dmsCreateResult?.ok ? "Dead-man-switch is live" : "Dead-man-switch is ready to sign"} errorTitle="Dead-man-switch setup failed">
            <InfoGrid
              items={[
                { label: "Name", value: dmsCreateResult?.draft?.vaultName || dmsCreateResult?.draft?.payload?.vaultName || dmsVaultName },
                { label: "Amount", value: `${dmsCreateResult?.draft?.lockAmountKas || dmsAmountKas} KAS` },
                { label: "Timer", value: `${dmsCreateResult?.draft?.lockSeconds || dmsSeconds}s` },
                { label: "Beneficiary", value: shortAddress(dmsCreateResult?.draft?.beneficiaryAddress || dmsCreateResult?.draft?.payload?.beneficiaryAddress || dmsBeneficiaryAddress) },
                { label: "Notice output", value: dmsCreateResult?.draft?.noticeKas ? `${dmsCreateResult.draft.noticeKas} KAS` : "Sent after broadcast" },
              ]}
            />
            <DebugDetails data={dmsDebug} />
          </StatusNotice>

          <StatusNotice result={dmsCreateBroadcastResult} loadingText="Broadcasting dead-man-switch vault..." successTitle="Dead-man-switch broadcast submitted" errorTitle="Dead-man-switch broadcast failed">
            <p>The beneficiary can now scan their own wallet history and claim after the inactivity timer expires.</p>
            <DebugDetails data={dmsCreateBroadcastResult} />
          </StatusNotice>

          <div className="releaseSection" ref={dmsReleaseRef}>
            <div>
              <p className="vaultEyebrow">CLAIM VAULT</p>
              <h3>{dmsRemainingMs > 0 ? `Claim opens in ${formatDuration(dmsRemainingMs)}` : "Beneficiary claim is available"}</h3>
              <p>The beneficiary scans their address, creates the keyless release transaction and broadcasts it.</p>
            </div>
            <div className="actionPair">
              {discoveredDmsVaults.length > 1 ? (
                <select className="vaultSelect" value={vaultSelectionKey(dmsCreateResult?.draft)} onChange={(event) => selectDmsVault(discoveredDmsVaults.find((vault) => vaultSelectionKey(vault) === event.target.value))}>
                  <option value="">Choose vault</option>
                  {discoveredDmsVaults.map((vault, index) => (
                    <option value={vaultSelectionKey(vault)} key={vaultSelectionKey(vault)}>
                      {vault.vaultName || vault.payload?.vaultName || `Dead man's switch ${index + 1}`} - {vault.lockAmountKas} KAS
                    </option>
                  ))}
                </select>
              ) : null}
              <button type="button" onClick={() => scanDmsVaultsForBeneficiary()}>
                Scan beneficiary vaults
              </button>
              {canSendDmsPulse ? (
                <button type="button" onClick={sendDmsPulse}>
                  Send owner pulse
                </button>
              ) : null}
              <button type="button" onClick={createDmsReleaseTx} disabled={!activeDmsBroadcasted || dmsRemainingMs > 0}>
                Create claim
              </button>
              <button type="button" onClick={broadcastDmsReleaseTx} disabled={!dmsCanBroadcastRelease}>
                Broadcast claim
              </button>
              <button
                type="button"
                onClick={() => exportVaultRecovery("dms", dmsCreateResult?.draft, dmsCreateBroadcastResult?.data)}
                disabled={!dmsCreateResult?.draft?.vault?.address}
              >
                Export recovery
              </button>
            </div>
          </div>

          <StatusNotice result={dmsScanResult} loadingText="Scanning beneficiary wallet history..." successTitle="Beneficiary scan complete" errorTitle="Beneficiary scan failed">
            <InfoGrid
              items={[
                { label: "Vaults found", value: dmsScanResult?.data?.count },
                { label: "First vault", value: shortAddress(dmsScanResult?.data?.vaults?.[0]?.vault?.address) },
                { label: "Ready", value: dmsScanResult?.data?.vaults?.[0]?.readyToBroadcast ? "Yes" : "Not yet" },
              ]}
            />
            <DebugDetails data={dmsScanResult} />
          </StatusNotice>
          <StatusNotice result={dmsPulseResult} loadingText="Sending owner pulse..." successTitle="Pulse broadcast submitted" errorTitle="Pulse failed">
            <p>The owner pulse notice was sent and the vault balance stays unchanged. Claim availability is still governed by the on-chain covenant sequence-lock.</p>
            <InfoGrid
              items={[
                { label: "Pulse notice", value: dmsPulseResult?.draft?.noticeKas ? `${dmsPulseResult.draft.noticeKas} KAS` : "" },
                { label: "Owner fee", value: dmsPulseResult?.draft?.estimatedFeeKas ? `${dmsPulseResult.draft.estimatedFeeKas} KAS` : "" },
              ]}
            />
            <DebugDetails data={dmsPulseResult} />
          </StatusNotice>
          <StatusNotice result={dmsReleaseResult} loadingText="Creating beneficiary claim..." successTitle="Claim transaction ready" errorTitle="Claim creation failed">
            <InfoGrid
              items={[
                { label: "Return amount", value: `${dmsReleaseResult?.draft?.returnAmountKas || ""} KAS` },
                { label: "Estimated fee", value: `${dmsReleaseResult?.draft?.estimatedFeeKas || ""} KAS` },
              ]}
            />
            <DebugDetails data={dmsReleaseResult} />
          </StatusNotice>
          <StatusNotice result={dmsReleaseBroadcastResult} loadingText="Broadcasting beneficiary claim..." successTitle="Beneficiary claim broadcast submitted" errorTitle="Beneficiary claim failed">
            <p>Your vault has been opened and funds will appear in your wallet now.</p>
            <DebugDetails data={dmsReleaseBroadcastResult} />
          </StatusNotice>
        </section>
      )}

      <footer className="footer-flow" data-darkreader-ignore>
        <a href="https://kaslab.space/" aria-label="Visit HUB21 at kaslab.space">Developed by HUB21</a>
      </footer>
    </main>
  );
}

export default function CovenantTestPage() {
  return <KasCovenVaults />;
}

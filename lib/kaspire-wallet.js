"use client";

const PROJECT_ID = "3dae39e7c46fbc79ee7bc33018184dd1";
const CHAIN_ID = "kaspa:mainnet";
const METHODS = ["kaspa_getAccounts", "kaspa_signPskt", "kaspa_signVaultTransaction"];
const EVENTS = ["accountsChanged"];
const CANONICAL_DAPP_URL = "https://vaults.kaslab.space";
function appMetadata() {
  const localOrigin = window.location.origin;
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const canonicalUrl = isLocal ? localOrigin : CANONICAL_DAPP_URL;
  const recoveryMode = window.location.pathname.startsWith("/recovery/tool");
  const wizardMode = window.location.pathname.startsWith("/wizard");
  const metadata = {
    name: "KasCoven Vaults",
    description: wizardMode
      ? "Permissionless Kaspa covenant prize vaults"
      : recoveryMode
        ? "Recover KasCoven vaults from Kaspa on-chain data"
        : "Programmable self-custody vaults secured by Kaspa consensus",
    url: canonicalUrl,
    icons: [`${canonicalUrl}/kascoven-logo.png`],
  };
  if (!isLocal) {
    metadata.redirect = { universal: CANONICAL_DAPP_URL };
  }
  return metadata;
}
const KASPIRE_FALLBACK_LINK = "https://kaspire.kaslab.space/kaspire/wc";
const KASPIRE_WAKE_LINK =
  "intent://dapp#Intent;scheme=kaspire;package=space.kaspire.wallet;" +
  `S.browser_fallback_url=${encodeURIComponent(KASPIRE_FALLBACK_LINK)};end`;

let clientPromise;
let activeSession;

function normalizeAccount(account) {
  const value = String(account || "");
  const prefix = `${CHAIN_ID}:`;
  if (value.startsWith(prefix) && value.length > prefix.length) {
    return `kaspa:${value.slice(prefix.length)}`;
  }
  return value.startsWith("kaspa:") ? value : "";
}

function sessionAddress(session) {
  return normalizeAccount(session?.namespaces?.kaspa?.accounts?.[0]);
}

function usableSession(session) {
  if (!session || Number(session.expiry || 0) <= Date.now() / 1000) return false;
  const namespace = session.namespaces?.kaspa;
  return Boolean(
    sessionAddress(session) &&
      namespace?.chains?.includes(CHAIN_ID) &&
      METHODS.every((method) => namespace.methods?.includes(method)),
  );
}

async function getClient() {
  if (typeof window === "undefined") {
    throw new Error("Kaspire WalletConnect is only available in the browser.");
  }
  if (!clientPromise) {
    clientPromise = import("@walletconnect/sign-client").then(async ({ default: SignClient }) => {
      const client = await SignClient.init({ projectId: PROJECT_ID, metadata: appMetadata() });
      const refresh = () => {
        activeSession = client.session.getAll().filter(usableSession).at(-1);
      };
      client.on("session_update", refresh);
      client.on("session_delete", refresh);
      client.on("session_expire", refresh);
      client.on("pairing_delete", refresh);
      client.on("pairing_expire", refresh);
      client.on("session_event", ({ params }) => {
        if (params?.event?.name === "accountsChanged") refresh();
      });
      refresh();
      return client;
    });
  }
  return clientPromise;
}

function showApprovalPrompt(active) {
  window.dispatchEvent(
    new CustomEvent("vaults:kaspireAction", {
      detail: active
        ? {
            active: true,
            title: "Kaspire confirmation required",
            message: "Open Kaspire, review and approve the vault transaction, then return to Vaults.",
            launchUrl: KASPIRE_WAKE_LINK,
          }
        : { active: false },
    }),
  );
}

async function requestKaspire(method, params = {}) {
  const client = await getClient();
  if (!usableSession(activeSession)) {
    activeSession = client.session.getAll().filter(usableSession).at(-1);
  }
  if (!activeSession) throw new Error("Kaspire is not connected.");
  if (!METHODS.includes(method)) throw new Error("Unsupported Kaspire request.");

  const needsApproval = method === "kaspa_signVaultTransaction" || method === "kaspa_signPskt";
  if (needsApproval) showApprovalPrompt(true);
  try {
    return await client.request({
      topic: activeSession.topic,
      chainId: CHAIN_ID,
      request: { method, params },
    });
  } finally {
    if (needsApproval) showApprovalPrompt(false);
  }
}

function vaultAction(txJsonString) {
  try {
    const tx = JSON.parse(txJsonString);
    const hex = String(tx.payload || "");
    if (!hex || hex.length % 2) return "";
    const bytes = Uint8Array.from(hex.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16));
    return JSON.parse(new TextDecoder().decode(bytes))?.action || "";
  } catch {
    return "";
  }
}

function createAdapter(address = sessionAddress(activeSession)) {
  const adapter = {
    walletName: "Kaspire",
    async requestAccounts() {
      return address ? [address] : [];
    },
    async getPublicKey() {
      const response = await fetch(`/api/address-public-key?address=${encodeURIComponent(address)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not derive the Kaspire public key.");
      return data.publicKey;
    },
    async signPskt({ txJsonString, options }) {
      const signInputIndexes = (options?.toSignInputs || []).map((input) => Number(input.index));
      const action = vaultAction(txJsonString);
      const isWalletFundedCreate = ["create", "dms-create", "wizard-create"].includes(action);
      const result = isWalletFundedCreate
        ? await requestKaspire("kaspa_signPskt", {
            txJsonString,
            options: { signInputs: signInputIndexes.map((index) => ({ index, sighashType: 1 })) },
          })
        : await requestKaspire("kaspa_signVaultTransaction", {
            txJsonString,
            signInputIndexes,
            redeemScript: options?.redeemScript || "",
          });
      const signed = typeof result === "string" ? result : result?.signedTxJson;
      if (!signed) throw new Error("Kaspire returned no signed vault transaction.");
      return signed;
    },
    async disconnect() {
      const client = await getClient();
      if (activeSession) {
        await client.disconnect({
          topic: activeSession.topic,
          reason: { code: 6000, message: "User disconnected KasCoven Vaults." },
        });
      }
      activeSession = undefined;
    },
  };
  return adapter;
}

export async function restoreKaspire() {
  await getClient();
  if (!usableSession(activeSession)) return null;
  return createAdapter(sessionAddress(activeSession));
}

export async function connectKaspire({ onDisplayUri } = {}) {
  const client = await getClient();
  let newlyPaired = false;
  if (!usableSession(activeSession)) {
    const { uri, approval } = await client.connect({
      requiredNamespaces: {
        kaspa: { chains: [CHAIN_ID], methods: METHODS, events: EVENTS },
      },
    });
    if (!uri) throw new Error("Kaspire pairing URI was not created.");

    const encodedUri = encodeURIComponent(uri);
    const appLink = `${KASPIRE_FALLBACK_LINK}?uri=${encodedUri}`;
    const intentLink =
      `intent://wc?uri=${encodedUri}` +
      "#Intent;scheme=kaspire;package=space.kaspire.wallet;" +
      `S.browser_fallback_url=${encodeURIComponent(appLink)};end`;
    onDisplayUri?.({ appLink, intentLink });
    activeSession = await approval();
    newlyPaired = true;
  }

  const address = sessionAddress(activeSession);
  if (!address) throw new Error("Kaspire returned no Kaspa Mainnet account.");
  if (newlyPaired) {
    const accounts = await requestKaspire("kaspa_getAccounts");
    const confirmedAddress = Array.isArray(accounts) ? normalizeAccount(accounts[0]) : "";
    if (confirmedAddress !== address) {
      throw new Error("Kaspire account response does not match the approved session.");
    }
  }
  return createAdapter(address);
}

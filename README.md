# KasCoven Vaults — Kaspa Covenant Vaults

KasCoven Vaults is a self-hostable web application for creating, discovering and releasing native KAS vaults enforced by Kaspa covenant scripts. The hosted instance is available at [vaults.kaslab.space](https://vaults.kaslab.space).

## What it provides

- **Time-Locked Vault:** locks KAS until a DAA-score based deadline, after which the owner can release the vault.
- **Dead Mans Switch:** locks KAS for a beneficiary. The owner can reset the inactivity period with an on-chain heartbeat; after expiry, the beneficiary can claim the current vault UTXO.
- **Wallet support:** Kaspire through WalletConnect and Kasware in supported browsers.
- **Vault discovery:** scans Kaspa transaction history and current UTXOs for vaults associated with an owner or beneficiary.
- **Portable recovery:** exports protocol metadata without private keys, imports single-vault files or CLI collection exports, and includes a standalone recovery CLI.
- **Self-hosting:** the website and API routes can run independently of the public KasLab deployment.

## How the vaults work

Vault creation transactions place KAS in a pay-to-script-hash output and include a versioned KasCoven recovery record in the transaction payload. The redeem script, pinned addresses, timing parameters and other reconstruction data are therefore discoverable from Kaspa history.

A time lock validates the intended owner and DAA-based unlock condition. A heartbeat-enabled dead mans switch has two release paths: an owner-authorized pulse recreates the vault output and restarts the relative inactivity window, while the beneficiary path becomes valid after the required sequence-lock period. Heartbeats are real on-chain transactions and require a small spendable owner UTXO for network fees; the locked vault amount is recreated unchanged.

The website prepares transactions, requests wallet review/signing where required, appends the covenant branch and redeem script, and submits the final transaction to a Kaspa node. Consensus remains authoritative; browser state and recovery files are only convenience data.

## Recovery model

The `/recovery` page documents independent recovery. After cloning and starting the repository, open `http://localhost:3000/recovery/tool`; it includes Kaspire and Kasware wallet connectivity and derives WalletConnect metadata from the local or mirror origin rather than the hosted Vaults domain. A recovery JSON file contains no seed phrase or private key, but it does reveal vault metadata and should still be stored privately.

Recovery has three distinct stages:

1. Discover the creation payload and current unspent vault output.
2. Prepare a release transaction using a compatible KasCoven API.
3. Review and sign wallet-controlled inputs, then broadcast through compatible Kaspa tooling.

Always refresh live chain state before acting. A saved record can reference an output that has already been spent or replaced by a heartbeat.

### Recovery CLI

```bash
pnpm recovery scan --address kaspa:YOUR_ADDRESS --mode all
pnpm recovery export --address kaspa:YOUR_ADDRESS --mode all --out recovery.json
pnpm recovery claim-draft --file recovery.json --vault 0 --api http://127.0.0.1:3000/api/timelock-vault
```

`scan` and `export` use public Kaspa history and UTXO APIs. `--mode` accepts `owner`, `beneficiary`, or `all`. Export files may contain several vault records; select one for `claim-draft` with the zero-based `--vault` index. `claim-draft` creates an unsigned draft and does not replace wallet review, signing or broadcast.

Configuration:

- `KASPA_API` — history/UTXO API base URL; default `https://api.kaspa.org`
- `KASCOVEN_API` — compatible vault API used by `claim-draft`
- `KASCOVEN_SCAN_PAGES` — maximum history pages to scan; default `10`

## Requirements

- Node.js 20 or newer
- pnpm via Corepack
- Internet access during installation for the Rusty Kaspa WASM SDK
- A compatible wallet for signing
- Network access to api.kaspa.org and a resolver-selected public Kaspa Mainnet wRPC node, or equivalent custom endpoints

## Install and run

```bash
git clone https://github.com/KaspaHUB21/KasCoven-Vaults---Kaspa-Covenant-Vaults.git
cd KasCoven-Vaults---Kaspa-Covenant-Vaults
corepack enable
pnpm install
pnpm build
pnpm start
```

`pnpm install` runs `scripts/install-toccata-sdk.mjs`, which installs the Rusty Kaspa WASM SDK v2.0.1 under `.toccata-mini-test/`. Reinstall it with:

```bash
pnpm run install:toccata
```

The production server defaults to Next.js port 3000. No own Kaspa node is required with the default public REST and resolver configuration. Recovery users open `http://localhost:3000/recovery/tool`, connect the matching Kaspire or Kasware wallet, import recovery JSON or scan their address, refresh UTXOs, and then review and authorize the available covenant action. The KasLab service uses its own service configuration and reverse proxy.

## Server configuration

The application works without node configuration:

- `KASPA_API` defaults to `https://api.kaspa.org` for history, UTXOs and network data.
- If `KASPA_WRPC` is unset, the bundled Kaspa Resolver selects a community-operated public Mainnet wRPC endpoint for broadcast.

Optional server-side overrides:

- `KASPA_API` — custom Kaspa REST API base URL
- `KASPA_WRPC` — own Kaspa wRPC WebSocket endpoint; attempted before the public resolver

Keep private infrastructure URLs and credentials in deployment environment configuration. Do not commit `.env*.local` files.

## Application routes

- `/` — wallet connection, vault creation, discovery, pulse and release interface
- `/recovery` — recovery explanation, wallet-enabled recovery entry point and CLI instructions
- `/recovery/tool` — complete Kaspire/Kasware recovery workspace for imports, chain refresh, signing and broadcast
- `/api/timelock-vault` — creates, scans and prepares time-lock and dead-mans-switch transactions
- `/api/covenant-broadcast` — validates/deserializes signed transaction JSON and submits it through Kaspa wRPC
- `/api/address-public-key` — public-key lookup support
- `/api/covenant-test` and `/api/covenant-unlock` — low-level covenant test routes

## Development

```bash
pnpm dev
pnpm build
node --check scripts/kascoven-recovery.mjs
pnpm recovery --help
```

The codebase uses Next.js App Router and React. API routes load the pinned Kaspa SDK from `.toccata-mini-test/sdk/`. Do not remove that directory on a deployed server unless you will reinstall the SDK before rebuilding.

## Security boundaries

- No private keys are stored by the website or recovery files.
- Wallet-controlled inputs must be approved and signed by the connected wallet.
- Dead-mans-switch beneficiary releases are covenant-authorized only after consensus timing conditions pass.
- Recovery metadata is not a substitute for current UTXO state.
- A successful UI preview is not proof that consensus will accept a transaction.
- Mainnet upgrades, fee policy and covenant semantics can change; test after every dependency or node upgrade.

## Repository

Development and issue tracking: [KaspaHUB21/KasCoven-Vaults---Kaspa-Covenant-Vaults](https://github.com/KaspaHUB21/KasCoven-Vaults---Kaspa-Covenant-Vaults)

Developed by [HUB21](https://kaslab.space/).

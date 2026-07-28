const GITHUB_REPO_URL = "https://github.com/KaspaHUB21/KasCoven-Vaults---Kaspa-Covenant-Vaults";

export const metadata = {
  title: "KasCoven Vaults Recovery",
  description: "How to recover and access KasCoven vaults from on-chain Kaspa data.",
};

export default function RecoveryPage() {
  return (
    <main className="recoveryPage">
      <header className="recoveryHeader">
        <a className="recoveryBrand" href="/">
          KasCoven Vaults
        </a>
        <a className="recoveryRepoLink" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
          GitHub repo
        </a>
      </header>

      <section className="recoveryHero">
        <p className="vaultEyebrow">DECENTRALIZED RECOVERY</p>
        <h1>Access your on-chain vaults without relying on this website</h1>
        <p>
          KasCoven vaults are designed so the important recovery data is written into Kaspa transaction payloads.
          The website is a convenient interface, but it should not be the only path to your funds.
        </p>
      </section>

      <section className="recoveryGrid" aria-label="Recovery basics">
        <article className="recoveryPanel">
          <span>01</span>
          <h2>What stays on-chain</h2>
          <p>
            Vault type, owner, beneficiary, vault address, timing data and redeem script are embedded in the
            vault creation transaction. A compatible scanner can find those records from the Kaspa blockDAG.
          </p>
        </article>
        <article className="recoveryPanel">
          <span>02</span>
          <h2>What the website does</h2>
          <p>
            This site scans your wallet history, reconstructs the vault state, prepares unlock or claim
            transactions and broadcasts them. Losing the site does not erase the vault UTXO.
          </p>
        </article>
        <article className="recoveryPanel">
          <span>03</span>
          <h2>What you should save</h2>
          <p>
            Export a recovery file after creating a vault. It contains no private keys, but keeps the exact
            protocol data close at hand if you later need another app, mirror or local CLI.
          </p>
        </article>
      </section>

      <section className="recoveryGuide">
        <div>
          <p className="vaultEyebrow">END USER GUIDE</p>
          <h2>If vaults.kaslab.space is unavailable</h2>
        </div>

        <ol className="recoverySteps">
          <li>
            <strong>Do not panic.</strong>
            <p>Your funds are not stored on the website. They remain in Kaspa vault UTXOs.</p>
          </li>
          <li>
            <strong>Open a trusted mirror or local copy.</strong>
            <p>Clone the official GitHub repository below to run the same interface on another server or your own computer.</p>
          </li>
          <li>
            <strong>Import your recovery file.</strong>
            <p>Use My vaults, then Import recovery file. The app restores the vault context and can refresh live chain data.</p>
          </li>
          <li>
            <strong>Or scan directly by address.</strong>
            <p>The CLI can scan public Kaspa transaction history for vault creation payloads associated with an owner or beneficiary address.</p>
          </li>
          <li>
            <strong>Create the unlock or claim transaction.</strong>
            <p>When the time lock or inactivity period has passed, create a transaction draft with a compatible KasCoven API, then review, sign and broadcast it with compatible wallet tooling.</p>
          </li>
        </ol>
      </section>

      <section className="cliSection">
        <div>
          <p className="vaultEyebrow">CLI RECOVERY</p>
          <h2>Run recovery without the hosted website</h2>
          <p>
            The CLI scans on-chain creation payloads through a Kaspa history API. It can export portable recovery
            JSON and request unsigned release drafts from a compatible KasCoven API. Wallet review and signing remain separate.
          </p>
        </div>

        <div className="terminalPanel" aria-label="CLI commands">
          <code>git clone https://github.com/KaspaHUB21/KasCoven-Vaults---Kaspa-Covenant-Vaults.git</code>
          <code>cd KasCoven-Vaults---Kaspa-Covenant-Vaults</code>
          <code>pnpm install</code>
          <code>pnpm recovery scan --address kaspa:YOUR_ADDRESS --mode all</code>
          <code>pnpm recovery export --address kaspa:YOUR_ADDRESS --mode all --out recovery.json</code>
          <code>pnpm recovery claim-draft --file recovery.json --vault 0 --api http://127.0.0.1:8110/api/timelock-vault</code>
        </div>
      </section>

      <section className="recoveryWarning">
        <h2>Important limits</h2>
        <p>
          Recovery files do not contain private keys and cannot steal funds by themselves, but they reveal vault
          metadata. Keep them somewhere you trust. A saved record is not proof that its referenced UTXO is still unspent.
          Always refresh live chain state before acting; covenant rules and the current unspent vault UTXO are authoritative.
        </p>
      </section>

      <footer className="vaultFooter" data-darkreader-ignore>
        <a className="vaultFooterLink" href="https://kaslab.space/">Developed by HUB21</a>
      </footer>
    </main>
  );
}

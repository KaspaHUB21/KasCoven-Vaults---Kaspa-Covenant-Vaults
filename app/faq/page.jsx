export const metadata = {
  title: "KasCoven Vaults FAQ",
  description: "Understand KasCoven vault addresses, covenant custody, recovery files, discovery and Kaspa timing.",
};

const faq = [
  ["What is a KasCoven Vault?", <>
    <p>A KasCoven Vault is a Kaspa UTXO protected by covenant logic.</p>
    <p>Instead of relying only on a wallet signature, the vault contains rules enforced by Kaspa consensus. These rules determine when the locked KAS may be spent, where it may be sent, and which authorization is required.</p>
    <p>The vault is non-custodial. KasCoven and any server involved cannot take ownership of the funds or bypass the covenant conditions.</p>
  </>],
  ["Is a vault address another wallet?", <>
    <p>No. A vault address is not a wallet. A normal wallet address is derived from a private key. A vault address is derived from the covenant script and represents its spending rules—not a new private key.</p>
    <div className="faqDiagram"><span>Wallet private key → wallet address</span><span>Covenant script → vault address</span></div>
    <p>Creating a vault does not generate another seed phrase, hidden wallet, private key, account or derivation path. The address can exist without its own private key because spending authority is defined by the covenant script.</p>
  </>],
  ["How is the vault linked to my wallet?", <>
    <p>The creation transaction provides the relationship. It spends KAS from your connected wallet into the covenant address and records the owner, beneficiary, vault address, covenant script, timing and permitted spending conditions.</p>
    <p>Where required, the covenant also demands a signature from the existing owner or beneficiary wallet when it is opened.</p>
    <div className="faqFlow"><span>Your existing wallet</span><b>↓</b><span>Vault creation transaction</span><b>↓</b><span>Covenant-controlled UTXO</span><b>↓</b><span>Permitted unlock or claim</span></div>
  </>],
  ["Does KasCoven know or store my private key?", <>
    <p>No. Wallet signing happens inside Kaspire or Kasware. KasCoven receives only the resulting signed transaction.</p>
    <p>KasCoven never needs your seed phrase, private key, wallet password or recovery phrase. Never enter these secrets into the website or recovery tool.</p>
  </>],
  ["What happens when the lock period expires?", <>
    <p>Expiration makes the vault spendable. It does not automatically create or broadcast a transaction. Kaspa validates submitted transactions; it does not autonomously move funds at a particular DAA score.</p>
    <ol><li>KasCoven locates the current vault UTXO.</li><li>It constructs the permitted opening transaction.</li><li>The connected wallet authorizes it when required.</li><li>The transaction is broadcast.</li><li>Kaspa verifies the covenant.</li><li>The KAS reaches the permitted address.</li></ol>
  </>],
  ["Why do the funds not return automatically?", <>
    <p>Some party must monitor the vault and broadcast a valid transaction. Fully automatic execution would require an external service, a continuously running wallet or a previously signed transaction.</p>
    <ul><li>A service without the private key cannot provide a required signature.</li><li>A service holding the key would undermine self-custody.</li><li>A long-lived pre-signed transaction can become unsuitable as fees and network conditions change.</li><li>A monitoring service introduces another infrastructure dependency.</li></ul>
    <p>KasCoven therefore keeps final authorization with the user’s wallet.</p>
  </>],
  ["Does opening a vault require additional KAS for fees?", <>
    <p>The network fee can generally be deducted from the KAS held by the vault. The relevant owner or beneficiary wallet authorizes the current fee, so the receiving amount is the vault balance minus the accepted network fee.</p>
  </>],
  ["What is the recovery file?", <>
    <p>The recovery file is a map to the vault—not a wallet backup. It contains public technical context such as vault type, name, address, owner or beneficiary, creation outpoint, redeem script, unlock conditions, DAA values and protocol version.</p>
    <p>It contains no seed phrase, private key, wallet credentials or control over the funds. Someone seeing it may learn vault details, but still cannot bypass the covenant or required wallet signatures.</p>
  </>],
  ["Why does every recovery file contain a different vault address?", <>
    <p>Each address is derived from its covenant configuration. Changing the beneficiary, owner key, unlock condition, inactivity period or protocol version can produce a different script and therefore a different address.</p>
    <div className="faqFlow"><span>Different covenant rules</span><b>↓</b><span>Different script</span><b>↓</b><span>Different vault address</span></div><p>This creates a new covenant—not a new wallet.</p>
  </>],
  ["What happens if I lose the recovery file?", <>
    <p>The vault and its KAS remain on Kaspa. Its context can be reconstructed when the creation transaction and current UTXO can be found.</p>
    <p>KasCoven uses browser records, the server-side vault index, public address history and current Kaspa UTXOs. Recovery without an export may be slower and more dependent on historical indexing, so the file remains a useful independent path.</p>
  </>],
  ["Are my vaults stored only in the browser?", <>
    <p>No. Browser storage is only a convenience cache. The actual KAS is held by a covenant UTXO on Kaspa.</p>
    <div className="faqLayers"><span><strong>Kaspa covenant UTXO</strong>Holds the KAS and enforces the rules.</span><span><strong>On-chain creation transaction</strong>Records creation metadata.</span><span><strong>Server-side vault index</strong>Helps locate vaults by owner or beneficiary.</span><span><strong>Browser storage</strong>Remembers discovered vaults.</span><span><strong>Recovery file</strong>Provides an independent portable record.</span></div>
  </>],
  ["What happens if I clear my browser data?", <>
    <p>Only local convenience records are removed. The on-chain vault, funds and conditions remain unchanged. Reconnect the same wallet and scan the index and available Kaspa history to rediscover active vaults.</p>
    <p>A recovery export is still recommended because it reduces reliance on one browser, deployment or history provider.</p>
  </>],
  ["What happens if I use another browser or device?", <>
    <p>Connect the same owner wallet or relevant beneficiary wallet. KasCoven can search for vaults associated with that address, or you can import the recovery file directly.</p>
    <p>A different account or derivation address is a different Kaspa address and cannot be assumed to represent the original participant.</p>
  </>],
  ["What happens if the KasCoven website disappears?", <>
    <p>The website does not hold the KAS and is not part of consensus. Clone the public repository, run it locally or deploy a mirror, open the recovery tool, connect Kaspire or Kasware, then import or scan and construct the permitted transaction.</p>
    <p>Recovery still requires access to a Kaspa node or API providing the necessary UTXO and transaction data.</p>
  </>],
  ["Can api.kaspa.org be used for recovery?", <>
    <p>Yes, when it provides the required endpoints and historical data. Users do not necessarily need their own node.</p>
    <p>Public services can have rate limits, outages, incomplete history, changing APIs or indexing delays. A private node and indexer offer greater independence but are not mandatory.</p>
  </>],
  ["What happens when a Kaspa node is pruned?", <>
    <p>Pruning does not delete an unspent vault UTXO from Kaspa consensus. Active UTXOs must remain available for validation.</p>
    <p>What may disappear is convenient access to old creation history and metadata. Persistent indexes, history APIs, browser records and recovery files provide alternative discovery paths. Pruning affects discoverability—not ownership or covenant validity.</p>
  </>],
  ["Can someone spend a vault just because they know its address?", <>
    <p>No. The address and recovery metadata are public, but a spend must satisfy every covenant rule.</p>
    <ul><li>the required DAA score or sequence lock;</li><li>the pinned destination and transaction structure;</li><li>the owner or beneficiary signature where required;</li><li>and the permitted covenant branch.</li></ul><p>Kaspa nodes execute the script and reject invalid transactions.</p>
  </>],
  ["What is a Time-Locked Vault?", <>
    <p>It holds KAS until a specified Kaspa DAA score. Before that score an opening transaction is invalid; afterwards the owner can authorize and broadcast the permitted transaction.</p><p>Displayed days, hours, minutes and seconds are estimates. The consensus DAA score is authoritative.</p>
  </>],
  ["What is a Dead Man’s Switch Vault?", <>
    <p>It has an owner and beneficiary. The owner may send a pulse that recreates the covenant and starts a new inactivity window. If no pulse arrives and the sequence lock expires, the beneficiary can claim through the beneficiary branch.</p><p>The beneficiary address is committed to the covenant and cannot simply be replaced.</p>
  </>],
  ["Why are DAA scores used instead of timestamps?", <>
    <p>Kaspa covenant timing is enforced using consensus values such as DAA scores and sequence locks. Wall-clock dates are estimates for human convenience. The browser clock is never authoritative.</p>
  </>],
  ["Can KasCoven change a vault after creation?", <>
    <p>No. Once accepted, the covenant commits its beneficiary, owner key, unlock condition, spending branch and destination constraints on Kaspa. The website cannot rewrite them.</p><p>Changing rules requires a new transaction that the existing covenant already permits.</p>
  </>],
  ["What should users back up?", <>
    <p>Protect the wallet recovery phrase according to the wallet’s instructions, and export each vault’s KasCoven recovery file separately.</p>
    <div className="faqLayers"><span><strong>Wallet seed phrase</strong>Restores wallet keys and addresses.</span><span><strong>KasCoven recovery file</strong>Restores the map and technical covenant context.</span></div><p>Neither backup replaces the other.</p>
  </>],
  ["What is the most important thing to understand?", <>
    <p>The vault is not stored inside the website, browser, recovery file or a hidden wallet. The KAS is stored in a covenant-controlled UTXO on Kaspa.</p><p>The website discovers the UTXO and constructs valid transactions. The wallet supplies authorization where required. Kaspa consensus makes the final decision.</p>
  </>],
];

export default function FaqPage() {
  return <main className="faqPage">
    <header className="faqHeader"><a className="recoveryBrand" href="/"><img src="/kascoven-logo.png" alt="" aria-hidden="true" />KasCoven Vaults</a><nav><a href="/">Vaults</a><a href="/recovery">Recovery</a></nav></header>
    <section className="faqHero"><p className="vaultEyebrow">KNOW YOUR VAULT</p><h1>KasCoven Vaults FAQ</h1><p>Clear answers about vault addresses, wallet keys, recovery, discovery, timing and self-custody.</p></section>
    <section className="faqList" aria-label="Frequently asked questions">{faq.map(([question, answer], index) => <details className="faqItem" key={question} open={index === 0}><summary><span>{String(index + 1).padStart(2, "0")}</span>{question}</summary><div className="faqAnswer">{answer}</div></details>)}</section>
    <footer className="footer-flow" data-darkreader-ignore><a href="https://kaslab.space/" aria-label="Visit HUB21 at kaslab.space">Developed by HUB21</a></footer>
  </main>;
}

import { KasCovenVaults } from "../../page";

export const metadata = {
  title: "KasCoven Wallet Recovery Tool",
  description: "Connect Kaspire or Kasware to recover KasCoven vaults from portable records and Kaspa on-chain data.",
};

export default function RecoveryToolPage() {
  return <KasCovenVaults recoveryMode />;
}

import path from "path";
import { createRequire } from "module";

function loadKaspa() {
  const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));
  return requireFromProject(path.join(process.cwd(), ".toccata-mini-test", "sdk", "kaspa-wasm32-sdk", "nodejs", "kaspa", "kaspa.js"));
}

export async function GET(request) {
  try {
    const address = new URL(request.url).searchParams.get("address");
    if (!address?.startsWith("kaspa:")) return Response.json({ error: "A Kaspa Mainnet address is required." }, { status: 400 });
    const kaspa = loadKaspa();
    const script = kaspa.payToAddressScript(address).toJSON().script;
    if (!/^20[0-9a-f]{64}ac$/i.test(script)) return Response.json({ error: "Kaspire requires a P2PK wallet address." }, { status: 400 });
    return Response.json({ address, publicKey: script.slice(2, 66).toLowerCase() });
  } catch {
    return Response.json({ error: "Invalid Kaspa address." }, { status: 400 });
  }
}

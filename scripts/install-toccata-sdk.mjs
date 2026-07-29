import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SDK_VERSION = "v2.0.1";
const SDK_URL = `https://github.com/kaspanet/rusty-kaspa/releases/download/${SDK_VERSION}/kaspa-wasm32-sdk-${SDK_VERSION}.zip`;
const SDK_SHA256 = "7eaffac9cd920ef2fdf540c6e10f2a2b7761170ebc62ec57dfa0f71c64567a71";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.join(root, ".toccata-mini-test");
const sdkFile = path.join(sdkRoot, `kaspa-wasm32-sdk-${SDK_VERSION}.zip`);
const sdkReadyFile = path.join(
  sdkRoot,
  "sdk",
  "kaspa-wasm32-sdk",
  "nodejs",
  "kaspa",
  "kaspa.js",
);

async function downloadFile(url, destination) {
  const response = await fetch(url, { headers: { "user-agent": "kascoven-vaults" } });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
  }

  await pipeline(response.body, createWriteStream(destination));
}

async function verifyArchive(zipPath) {
  const digest = createHash("sha256").update(await readFile(zipPath)).digest("hex");
  if (digest !== SDK_SHA256) {
    rmSync(zipPath, { force: true });
    throw new Error(`Toccata SDK checksum mismatch: expected ${SDK_SHA256}, received ${digest}`);
  }
}

function expandArchive(zipPath, destination) {
  const command = process.platform === "win32" ? "powershell.exe" : "unzip";
  const args =
    process.platform === "win32"
      ? ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destination}'`]
      : ["-o", zipPath, "-d", destination];

  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      process.platform === "win32"
        ? "PowerShell Expand-Archive failed while unpacking the Toccata SDK."
        : "unzip failed while unpacking the Toccata SDK. Install unzip and run pnpm install:toccata again.",
    );
  }
}

if (existsSync(sdkReadyFile)) {
  console.log(`Toccata SDK already installed at ${sdkReadyFile}`);
  process.exit(0);
}

mkdirSync(sdkRoot, { recursive: true });
rmSync(path.join(sdkRoot, "sdk"), { recursive: true, force: true });

console.log(`Downloading Rusty Kaspa Toccata SDK ${SDK_VERSION}...`);
await downloadFile(SDK_URL, sdkFile);
await verifyArchive(sdkFile);
expandArchive(sdkFile, path.join(sdkRoot, "sdk"));

if (!existsSync(sdkReadyFile)) {
  throw new Error(`Toccata SDK install did not create ${sdkReadyFile}`);
}

console.log(`Toccata SDK installed at ${sdkReadyFile}`);

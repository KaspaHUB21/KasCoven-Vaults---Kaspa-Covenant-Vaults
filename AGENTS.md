# Codex Notes

This is the KasCoven Vaults application for Kaspa covenant vaults.

Before running or changing the app, make sure dependencies and the Rusty Kaspa WASM SDK are installed:

```bash
pnpm install
```

The `postinstall` script downloads `kaspa-wasm32-sdk-v2.0.1.zip` from `kaspanet/rusty-kaspa` and extracts it to `.toccata-mini-test/sdk/`. The API routes load the SDK from that exact path.

Use tiny mainnet values only. Vault bugs can permanently lock funds or assets.

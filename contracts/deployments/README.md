# Deployments naming convention

- `base-sepolia.json` + `base-sepolia/` — Base Sepolia (84532), live testnet. Do not edit by hand.
- `base.json` + `base/` — Base mainnet (8453). Written by `make deploy-mainnet`
  (`Deploy.s.sol` picks `deployments/base.json` automatically when `block.chainid == 8453`).
  Per-market files go in `base/<slug>.json`, mirroring `base-sepolia/`.
  **Does not exist yet** — nothing has been deployed to mainnet; never create it with placeholder addresses.

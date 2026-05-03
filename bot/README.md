# Settlement Bot

This directory contains the settlement bot components. The Polymarket adapter is a **production-tested reference implementation** — adapt it for other sources or use it as-is for Polymarket bundles.

## Architecture

```
bot/
├── NonceManager.js                     # Shared — nonce tracking for sequential txs
├── ResolutionQueue.js                  # Shared — FIFO queue, one bundle at a time
└── polymarket/                         # Source-specific adapter
    ├── executionBot_Polymarket.js      # Main bot (event listener + trade + resolve)
    └── ConditionalTokensRedeemer.js    # CTF redemption (Gnosis Conditional Tokens)
```

### Shared components (source-agnostic)

**NonceManager.js** — Centralized nonce tracking. Prevents nonce conflicts when sending multiple transactions sequentially. Auto-resets on nonce errors.

**ResolutionQueue.js** — FIFO queue for bundle resolution. Ensures bundles are processed one at a time without race conditions. Tracks stats, deduplicates, supports monitoring.

### Polymarket adapter

**executionBot_Polymarket.js** — The full bot:
- Listens for `BundleCreated` events
- Calls `transferFundsToBot` to receive USDC from bundle
- Swaps USDC → USDCe via Uniswap V3 (Polymarket uses USDCe on Polygon)
- Places market buy orders via Polymarket CLOB API
- Monitors market resolution via CTF oracle
- Redeems winning positions via Conditional Tokens Framework
- Swaps USDCe → USDC and transfers gains back to bundle
- Calls `resolveMarket` for each market with actual gains
- Handles failures: returns funds to bundle if trading fails

**ConditionalTokensRedeemer.js** — Gnosis CTF integration:
- Standard CTF redemption via `redeemPositions`
- NegRisk market redemption via NegRiskAdapter
- On-chain balance verification (prevents phantom positions)
- Batch redemption for full bundles

## How to Adapt for Another Source

To support a new source (e.g., Azuro, Overtime), create a new adapter directory:

```
bot/
├── NonceManager.js          # Reuse as-is
├── ResolutionQueue.js       # Reuse as-is
├── polymarket/              # Existing
└── azuro/                   # New adapter
    ├── executionBot_Azuro.js
    └── AzuroResolver.js
```

Your adapter needs to implement these steps:

### 1. Place bets (replace `executePolymarketTrades`)

```javascript
async executeSourceTrades(bundleAddress, capital, markets) {
    // Source-specific: place bets on the prediction market
    // Store position data for later resolution
    // Return true if successful, false if failed
}
```

### 2. Check resolution (replace CTF oracle checks)

```javascript
async checkMarketResolved(marketId) {
    // Source-specific: query oracle/API for market outcome
    // Return { resolved: boolean, won: boolean, gains: bigint }
}
```

### 3. Redeem positions (replace `redeemPositions`)

```javascript
async redeemPositions(bundleData) {
    // Source-specific: redeem winning positions for USDC
    // Transfer USDC back to bundle address
    // Return array of gains per market index
}
```

The core loop (`checkExistingBundles` → `processQueue` → `resolveBundle` → `resolveMarket`) stays the same. Only the trade execution and redemption logic changes per source.

## Configuration

```env
# Required
RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
BOT_PRIVATE_KEY=0x...
FACTORY_ADDRESS=0x...
USDC_ADDRESS=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359

# Polymarket-specific
POLYMARKET_CHAIN_ID=137

# Optional
WEBHOOK_URL=https://your-webhook.com/notify
```

## Running

```bash
cd bot/polymarket
node executionBot_Polymarket.js
```

The bot polls every 5 minutes, processes new bundles immediately, and queues expired bundles for resolution.

## Dependencies

The bot requires `polymarketClient.js` (not included) — this is the Polymarket CLOB API client for placing orders. You can build this using the [Polymarket CLOB API docs](https://docs.polymarket.com/).

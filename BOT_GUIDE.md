# Settlement Bot Integration Guide

Your bot is the bridge between prediction market results and the PolyCombo contracts. This guide explains exactly what the bot must do, regardless of which market source you integrate.

---

## What the Bot Does

The settlement bot has two jobs:

1. **Transfer funds** — Move USDC from a Bundle to the bot wallet so the bot can place bets on the actual prediction markets
2. **Resolve markets** — Report each market's outcome (win/loss + actual gains) back to the Bundle contract

The bot wallet is set in the BundleFactory and has exclusive access to both functions via the `onlyBot` modifier.

---

## Bot Lifecycle (per Bundle)

```
Bundle Created (event: BundleCreated)
    │
    ▼
1. transferFundsToBot(bundleAddress)
    │  Bot receives USDC from the bundle
    │  Bot places bets on actual prediction markets
    │
    ▼
2. Wait for markets to resolve (poll source APIs/oracles)
    │
    ▼
3. resolveMarket(bundleAddress, marketIndex, won, actualGains)
    │  Call once per market in the bundle
    │  Order doesn't matter, but all must be resolved
    │
    ▼
4. When all markets resolved → Bundle auto-settles
    │  If all won → _handleSuccess (vault pays bonus, user can claim)
    │  If any lost → _handleFailure (residual goes to vault)
    │
    ▼
5. Return remaining USDC to bundle (if won)
    │  Bot must transfer actualGains back to bundle address
    │  before calling resolveMarket for winning markets
```

---

## Contract Interface

```solidity
// Called via BundleFactory (onlyBot)
function transferFundsToBot(address bundleAddress) external;
function resolveMarket(address bundleAddress, uint256 marketIndex, bool won, uint256 actualGains) external;
```

### resolveMarket Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `bundleAddress` | address | The Bundle contract |
| `marketIndex` | uint256 | Index in the bundle's markets array (0-based) |
| `won` | bool | Did this market outcome win? |
| `actualGains` | uint256 | USDC amount (6 decimals). Must be 0 if lost. If won, must be > 0 and ≤ max theoretical gains |

### Constraints enforced on-chain

- `block.timestamp >= market.endTime` — Can't resolve before the market ends
- If `won=true`: `actualGains > 0`, `actualGains >= amountPerMarket`, `actualGains <= maxPossibleGains`
- If `won=false`: `actualGains == 0`
- Each market can only be resolved once

---

## Source-Specific Integration

### Polymarket

**Resolution data:** UMA Optimistic Oracle resolves markets. Query the Polymarket API or listen to UMA oracle events.

```
API: https://clob.polymarket.com/
Endpoint: GET /markets/{marketId}
Resolution: Check market.resolved and market.outcome
```

**Placing bets:** Use the Polymarket CLOB API to buy conditional tokens (ERC-1155). The bot needs to interact with the CTF Exchange contract.

**Getting gains:** Redeem winning conditional tokens for USDC via the ConditionalTokens contract.

### Azuro

**Resolution data:** Azuro data providers resolve via oracle. Listen to `ConditionResolved` events on the Azuro Core contract.

```
Subgraph: https://thegraph.com/hosted-service/subgraph/azuro-protocol/azuro-api-{chain}
Query: conditions(where: {conditionId: "..."}) { status, wonOutcomes }
```

**Placing bets:** Call `bet()` on the Azuro LP contract with the condition ID and outcome.

**Getting gains:** Call `withdrawPayout()` on the LP contract for winning bets.

### Overtime / Thales

**Resolution data:** Chainlink oracles resolve sports markets. Listen to `MarketResolved` events.

```
API: https://overtimemarkets.xyz/api/
Subgraph available on Optimism, Arbitrum, Base
```

**Placing bets:** Call `buyFromAMM()` on the SportsAMM contract.

**Getting gains:** Call `exerciseOptions()` on the market contract after resolution.

### SX Bet

**Resolution data:** SX validator network reports outcomes. Query the SX API.

```
API: https://api.sx.bet/
Endpoint: GET /markets/{marketHash}
```

**Placing bets:** Place orders via the SX order book API, settled on-chain.

**Getting gains:** Winning positions auto-settle via the SX escrow contract.

### Custom Source

For any source not listed above, your bot needs to:

1. Know when the market has ended (timestamp or oracle event)
2. Determine the outcome (win/loss for the chosen position)
3. Calculate actual gains in USDC
4. Transfer gains back to the Bundle contract
5. Call `resolveMarket` with the correct parameters

---

## Bot Architecture (Recommended)

```
┌─────────────────────┐
│   Event Listener     │  Listen for BundleCreated events
│   (ethers.js)        │  from BundleFactory
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   Source Router      │  Read market source from metadata
│                      │  Route to correct adapter
└──────────┬──────────┘
           │
     ┌─────┼─────┬──────┬──────┐
     ▼     ▼     ▼      ▼      ▼
  ┌─────┐┌─────┐┌──────┐┌────┐┌──────┐
  │Poly ││Azuro││Over  ││SX  ││Custom│  Source adapters
  │market│     ││time  ││Bet │      │  (you build these)
  └─────┘└─────┘└──────┘└────┘└──────┘
           │
           ▼
┌─────────────────────┐
│   Settlement Engine  │  transferFundsToBot → place bets
│                      │  wait → resolveMarket per market
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   On-Chain Caller    │  Call Factory.resolveMarket()
│   (bot wallet signer)│  with results
└─────────────────────┘
```

### Minimal Bot (pseudocode)

```javascript
const factory = new ethers.Contract(FACTORY_ADDRESS, factoryABI, botSigner);

// Listen for new bundles
factory.on("BundleCreated", async (bundleAddr, user, capital, odds) => {
    console.log(`New bundle: ${bundleAddr}`);
    
    // 1. Transfer funds to bot
    await factory.transferFundsToBot(bundleAddr);
    
    // 2. Get bundle markets
    const bundle = new ethers.Contract(bundleAddr, bundleABI, botSigner);
    const markets = await bundle.getMarkets();
    
    // 3. Place bets on each market (source-specific)
    for (const market of markets) {
        await placeBet(market); // Your implementation
    }
    
    // 4. Wait for resolution
    for (let i = 0; i < markets.length; i++) {
        const market = markets[i];
        
        // Wait until market.endTime
        await waitUntil(Number(market.endTime));
        
        // Check result (source-specific)
        const result = await checkResult(market); // Your implementation
        
        // 5. If won, transfer gains back to bundle
        if (result.won) {
            await usdc.transfer(bundleAddr, result.gains);
        }
        
        // 6. Resolve on-chain
        await factory.resolveMarket(
            bundleAddr,
            i,                    // marketIndex
            result.won,           // bool
            result.won ? result.gains : 0  // actualGains (6 decimals)
        );
    }
    
    // Bundle auto-settles when all markets are resolved
});
```

---

## Important Notes

- The bot wallet private key must be kept secure — it controls fund movement
- Always transfer gains back to the Bundle address BEFORE calling `resolveMarket` with `won=true`
- The contract validates that `actualGains` doesn't exceed the theoretical maximum based on the odds
- If your bot crashes mid-settlement, it can resume — markets are resolved individually and idempotently
- Monitor gas costs — each `resolveMarket` call costs gas. Batch if your chain supports it
- Set up alerts for bundles that haven't been resolved within a reasonable time after `endTime`

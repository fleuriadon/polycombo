# PolyCombo — On-Chain Parlay Engine for Prediction Markets

Source-agnostic parlay infrastructure for on-chain prediction markets. Combine 3–15 positions from Polymarket, Azuro, Overtime, SX Bet, Drift BET — or any custom source — into a single high-odds bundle with automated settlement and liquidity vault backing.

**Built in production. Exploited. Patched. Open sourced.**

---

## How It Works

A user selects 3–15 prediction market outcomes from any supported source, stakes USDC, and the system creates an on-chain "bundle" — a parlay bet. If all outcomes hit, the user receives the combined payout. If any single outcome fails, the staked capital goes to the liquidity vault.

```
User stakes 100 USDC on 3 markets at 2x each
→ Markets can come from Polymarket + Azuro + Overtime (mixed sources OK)
→ Combined odds: 8x
→ All 3 win: user gets ~780 USDC (protocol + deployer fees deducted)
→ Any loss: vault keeps the capital (LP profit)
```

### Supported Sources

| Source | Chain | Settlement | Status |
|--------|-------|------------|--------|
| Polymarket | Polygon | UMA Optimistic Oracle | ✅ Integrated |
| Azuro | Polygon, Gnosis, Arbitrum, Base | Azuro Oracle | 🔌 Compatible |
| Overtime / Thales | Optimism, Arbitrum, Base | Chainlink | 🔌 Compatible |
| SX Bet | SX Network, Arbitrum | SX Validators | 🔌 Compatible |
| Drift BET | Solana | Drift Oracle | 🔌 Compatible |
| Custom | Any | User-defined | 🔌 Compatible |

The engine is source-agnostic: any market that resolves to win/loss with verifiable odds can be bundled. The settlement bot handles resolution per source.

### Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Frontend   │────▶│  BundleFactory   │────▶│   Bundle    │
│  (any UI)    │     │  (EIP-712 auth)  │     │  (per-bet)  │
└─────────────┘     └──────────────────┘     └─────────────┘
                           │                        │
                     0.5% protocol fee         settlement
                     2% deployer fee            by bot
                           │                        │
                    ┌──────▼──────┐          ┌──────▼──────┐
                    │  Protocol   │          │  Liquidity  │
                    │  Treasury   │          │   Vault     │
                    │ (immutable) │          │  (LP pool)  │
                    └─────────────┘          └─────────────┘
```

### Contracts

| Contract | Purpose |
|----------|---------|
| `BundleFactory.sol` | Creates bundles, validates EIP-712 signatures, collects fees, manages bot access |
| `Bundle.sol` | Individual parlay bet — holds capital, tracks market outcomes, handles settlement |
| `LiquidityVault.sol` | LP pool that backs parlay payouts and collects residuals from lost bets |
| `MockUSDC.sol` | Test token for local development |

---

## Protocol Fee Model

PolyCombo includes an **immutable 0.5% protocol fee** hardcoded into the BundleFactory. Every deployment of this codebase automatically sends 0.5% of each bundle's capital to the protocol treasury address.

```solidity
address public immutable protocolTreasury;          // Cannot be changed
uint256 public constant PROTOCOL_FEE_PPM = 5000;    // 0.5% — cannot be changed
```

**Why immutable?** The protocol fee address and rate are set at deployment and burned into the bytecode. No admin function can modify them. A deployer who wants to remove it must fork and modify the source — at which point they lose compatibility with the official SDK, updates, and audit trail.

### Fee Breakdown (per bundle creation)

| Fee | Default | Range | Recipient | Mutable? |
|-----|---------|-------|-----------|----------|
| Protocol fee | 0.5% | 0.5% fixed | Protocol treasury | **No** — immutable constant |
| Entry fee | 2.0% | 0–5% | Deployer's fee collector | Yes — `setEntryFee()` |
| Exit fee | 2.0% | 0–5% (on profit) | Deployer's fee collector | Yes — `setExitFee()` |

The protocol fee is hardcoded at 0.5% — immutable `constant` and `immutable` address. Deployers can set entry and exit fees from 0% to 5% via `setEntryFee(ppm)` and `setExitFee(ppm)`. A deployer who wants zero fees can set both to 0 — the protocol still gets its 0.5%.

---

## Security

### Post-Mortem: The Exploit That Led to This Release

This codebase was deployed in production and exploited for 5,000 USDC. Here's what happened and what was fixed.

#### The Vulnerability (V4 — pre-patch)

```solidity
// BundleFactory V4 — VULNERABLE
function createBundle(
    address user,     // ← Anyone could pass ANY address here
    uint256 userCapital,
    ...
) external {
    // No signature check. No msg.sender check. Nothing.
    usdc.safeTransferFrom(user, address(this), totalFromUser);  // ← Drains user
}
```

The `createBundle` function accepted a `user` parameter for Gelato Relay compatibility but **never verified that the user authorized the call**. Any wallet that had approved USDC spending on the BundleFactory could be drained by anyone calling `createBundle` with the victim's address.

#### The Attack Flow

1. Attacker identifies wallet with USDC approval to BundleFactory
2. Calls `createBundle(victimAddress, 5000e6, ...)` with garbage market params
3. Factory executes `transferFrom` — victim's 5,000 USDC pulled without consent
4. Funds routed through the system and bridged out via LI.FI

#### Second Vulnerability: Open `notifyResidual`

```solidity
// LiquidityVault V3 — VULNERABLE
function notifyResidual(uint256 amount) external {
    // No access control. Anyone can inflate vault liquidity.
    availableLiquidity += amount;
    totalLiquidity += amount;
}
```

Anyone could call `notifyResidual` without sending tokens, inflating the vault's accounting and enabling share manipulation to steal LP funds.

### Fixes Applied (V6)

**BundleFactory:**
- EIP-712 signature required — user must sign exact bundle parameters off-chain
- Nonce-based replay protection
- Deadline enforcement
- `SignatureChecker` (not `ECDSA.recover`) for Safe/EIP-1271 wallet compatibility

**LiquidityVault:**
- `notifyResidual` restricted to `onlyValidBundle`
- Balance verification before crediting liquidity

### Remaining Recommendations

- [ ] Professional audit before mainnet deployment with real funds
- [ ] Consider Permit2 integration to eliminate standing approvals
- [ ] Add event monitoring / alerting for unusual `createBundle` patterns
- [ ] Timelock on admin functions (`setBotWallet`, `setVaultAddress`)

---

## REST API

The API is source-agnostic. Each market in a bundle carries a `source` field — the engine doesn't care where the market comes from as long as the settlement bot can resolve it.

### Flow: Create a Bundle

```
1. POST /api/bundles/validate    → Check odds, fees, sources
2. POST /api/bundles/prepare     → Get EIP-712 typed data
3. User signs typedData in wallet (MetaMask, Safe, WalletConnect)
4. POST /api/bundles/submit      → Submit with signature (direct tx)
   — OR —
   POST /api/gelato/create-bundle → Submit via Gelato relay (gasless)
```

### Endpoints

**`GET /health`** — API status, supported sources, fee structure

**`GET /api/sources`** — List all supported market sources with chain and settlement info

**`POST /api/bundles/validate`** — Validate a bundle before creation
```json
{
  "capital": 100,
  "markets": [
    { "source": "polymarket", "marketId": "0x...", "currentOdds": 1.8, "outcome": "YES" },
    { "source": "azuro",      "marketId": "123",   "currentOdds": 2.1, "outcome": "YES" },
    { "source": "overtime",   "marketId": "456",   "currentOdds": 1.5, "outcome": "NO"  }
  ]
}
```
Returns combined odds, fee breakdown (protocol 0.5% + entry 2% + exit 2%), warnings for multi-source bundles.

**`POST /api/bundles/prepare`** — Build EIP-712 signature request
```json
{
  "userAddress": "0x...",
  "capital": 100,
  "markets": [
    { "source": "polymarket", "marketId": "0x...", "tokenId": "123...", "currentOdds": 1.8, "outcome": "YES", "endTime": 1735689600 }
  ]
}
```
Returns `typedData` (pass to `wallet.signTypedData()`), `bundleParams` (pass back with signature), and `nonce`.

**`POST /api/bundles/submit`** — Submit signed bundle
```json
{
  "userAddress": "0x...",
  "capital": 100,
  "bundleParams": { ... },
  "signature": "0x..."
}
```
Returns encoded transaction `{ to, data, value }` ready for `sendTransaction`.

**`POST /api/gelato/create-bundle`** — Same as submit but gasless via Gelato relay. Same body. Returns `taskId`.

**`GET /api/gelato/status/:taskId`** — Check Gelato relay task status

**`GET /api/bundles/:address`** — Get bundle details (status, markets, payout, fees)

**`GET /api/bundles?limit=20&offset=0&status=ACTIVE`** — List bundles with pagination

**`GET /api/users/:address/bundles`** — User's bundles with stats

**`GET /api/users/:address/stats`** — Win rate, ROI, total wagered

**`GET /api/vault/stats`** — TVL, APY, utilization, performance

**`GET /api/vault/shares/:address`** — LP position details

**`GET /api/vault/withdraw/preview?address=0x...&amount=100`** — Preview withdrawal

---

## Deploy Your Own

### Prerequisites

- Node.js 18+
- Hardhat or Foundry
- Polygon RPC endpoint
- USDC contract address for target chain

### Deployment Steps

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/polycombo.git
cd polycombo

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit: RPC_URL, DEPLOYER_PRIVATE_KEY, USDC_ADDRESS

# 4. Deploy (Foundry example)
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

### Constructor Parameters

```solidity
BundleFactory(
    address _usdc,              // USDC on your chain
    address _vaultAddress,      // Your LiquidityVault
    address _feeCollector,      // Your fee wallet (gets 2% entry)
    address _botWallet,         // Your settlement bot
    address _protocolTreasury   // PolyCombo protocol address (provided)
)
```

### Off-Chain Integration

See `eip712-helper.js` for the complete signing and submission flow. Compatible with MetaMask, Safe SDK, and WalletConnect.

---

## For Deployers / Builders

You deploy the full stack (Factory, Vault, Bundles), provide your own liquidity, run your own settlement bot, build your own frontend. You keep 2% entry + 2% exit fees. The protocol takes 0.5% — no setup, no permission needed.

**What you get:**
- Battle-tested parlay contracts (yes, literally battle-tested)
- EIP-712 signature flow with Safe wallet support
- Liquidity vault with share-based LP system
- REST API with source-agnostic bundle management
- Polymarket settlement bot (1300-line production reference implementation)
- NonceManager + ResolutionQueue (reusable for any source)
- Settlement bot integration guide for other sources
- This post-mortem, so you don't repeat our mistakes

**What you build:**
- Frontend (your UI, your brand)
- Source adapters for non-Polymarket markets (use the Polymarket bot as reference)
- Your own liquidity
- Your own audit (recommended before mainnet)

---

## Grant Opportunities

This project is a strong candidate for ecosystem grants. Below are relevant programs:

### Polygon

- **Polygon Village** — Infrastructure grants for DeFi protocols on Polygon
- Relevant angle: on-chain parlay infrastructure expanding Polygon DeFi use cases
- https://polygon.technology/village

### Polymarket

- Developer ecosystem grants for tooling built on Polymarket's CLOB
- Relevant angle: first open-source parlay layer on top of Polymarket positions

### UMA / Optimistic Oracle

- Grants for prediction market infrastructure
- Relevant angle: settlement oracle integration, market resolution tooling

### Gnosis / Conditional Tokens

- Grants for conditional token framework extensions
- Relevant angle: bundle/parlay primitive using conditional token positions

### General Web3 Grants

- **Gitcoin Grants** — Community-funded public goods rounds
- **Questbook** — DeFi infrastructure grants across multiple chains
- **Optimism RPGF** — Retroactive public goods funding (if deployed on OP)

### Grant Application Tips

1. Lead with the post-mortem — it shows real production experience
2. Emphasize the "public goods" angle — open-source infra anyone can deploy
3. Highlight the protocol fee model — sustainable without token or VC funding
4. Include deployment metrics if you have them (bundles created, volume, TVL)
5. Mention Safe wallet / EIP-1271 support — signals enterprise readiness

---

## License

MIT — deploy it, fork it, build on it. The 0.5% protocol fee is the only ask.

---

## Contributing

Issues and PRs welcome. If you find a vulnerability, please disclose responsibly via [security contact] before opening a public issue.

# Kreopoly Lens

A PayBox marketplace plugin that gives AI agents on-chain Polymarket intelligence and copy-trade signal detection. Built for the MoonPay Hackathon Chapter 1: "Agents & PayBox".

## What it does

- **Track Polymarket wallets** — monitor any wallet's trading activity in real-time
- **Detect copy signals** — stateless signal detection with funnel diagnostics
- **Read live CLOB order books** — bids, asks, spread, depth via Polymarket's CLOB API
- **Prepare copy trades** — full execution plan with EIP-712 signing intent for PayBox
- **Propose transactions** — EVM transaction proposals via `io.paybox/transactionProposal`
- **Non-custodial** — PayBox handles all wallet custody and signing

## Quick start

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/paybox-kreopoly-lens.git
cd paybox-kreopoly-lens

# Install
npm install

# Build
npm run build

# The output is dist/plugin.mjs — upload this to the PayBox developer portal
```

## 17 MCP tools

| # | Tool | Purpose |
|---|---|---|
| 1 | `kreopoly_list_categories` | 13 Polymarket categories (static) |
| 2 | `kreopoly_track_wallet` | Manage tracked wallets (stateless) |
| 3 | `kreopoly_get_positions` | Read open positions with P&L |
| 4 | `kreopoly_get_wallet_activity` | Read on-chain activity with funnel |
| 5 | `kreopoly_check_copy_signals` | Stateless signal detection with cursor |
| 6 | `kreopoly_resolve_market` | conditionId → market metadata |
| 7 | `kreopoly_copy_latest_open_trade` | Manual test mode copy plan |
| 8 | `kreopoly_read_market_book` | Live CLOB order book |
| 9 | `kreopoly_copy_one_trade` | One-shot copy execution plan |
| 10 | `kreopoly_prepare_clob_auth` | ClobAuth EIP-712 payload for PayBox |
| 11 | `kreopoly_complete_clob_auth` | Complete Polymarket connection |
| 12 | `kreopoly_submit_signed_order` | Submit signed order to CLOB |
| 13 | `kreopoly_verify_order` | Poll order status |
| 14 | `kreopoly_execution_diagnostics` | Test all upstream APIs |
| 15 | `kreopoly_prepare_copy_trade` | High-level copy preparation |
| 16 | `kreopoly_place_bet` | EVM transaction proposal (CTF Exchange) |
| 17 | `kreopoly_settle_position` | EVM transaction proposal (ConditionalTokens) |

## Configuration

### PayBox network hosts (add in developer portal)

```
data-api.polymarket.com
gamma-api.polymarket.com
clob.polymarket.com
```

### PayBox Variables & Secrets

| Name | Type | Purpose |
|---|---|---|
| `POLY_SIGNATURE` | Secret (host: clob.polymarket.com) | One-time ClobAuth signature (brokered header) |
| `POLY_API_KEY` | Secret (host: clob.polymarket.com) | L2 CLOB API key |
| `POLY_API_SECRET` | Secret (host: clob.polymarket.com) | L2 CLOB API secret |
| `POLY_PASSPHRASE` | Secret (host: clob.polymarket.com) | L2 CLOB passphrase |
| `POLY_ORDER_SIG` | Environment variable | Per-trade order signature |

## Tech stack

- **Runtime:** Node.js 24, TypeScript
- **MCP SDK:** @modelcontextprotocol/server v2.0.0
- **Schema:** Zod v4
- **Bundler:** esbuild (single `dist/plugin.mjs`, 455 KB)
- **Protocol:** MCP 2026-07-28

## Architecture

```
AI Agent (ChatGPT/Claude/Grok)
    ↓ MCP
PayBox (non-custodial wallet + signing)
    ↓ plugin.mjs (sandboxed)
Kreopoly Lens
    ↓ HTTPS
Polymarket APIs:
  ├── Data API (positions, activity)
  ├── Gamma API (market metadata)
  └── CLOB API (order books, trading)
```

## Copy-trade pipeline

```
Track source wallet
→ Detect fresh BUY trade
→ Candidate selection (skip closed markets, skip no-book tokens)
→ Resolve exact market + outcome + tokenId
→ Fetch live CLOB order book
→ Calculate order (decimal-safe BigInt arithmetic)
→ Enforce budget / price-deviation / slippage limits
→ Build EIP-712 Order struct
→ PayBox signs via request_wallet_sign (op: "typedData")
→ Submit to CLOB POST /order
→ Verify order status
→ Report fill result
```

## License

MIT

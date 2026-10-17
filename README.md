# paybox-kreopoly-lens

> A PayBox marketplace plugin that gives AI agents on-chain Polymarket intelligence and the ability to place bets — without ever holding the user's private key.

Built for the **MoonPay Hackathon — Chapter 1: "Agents & PayBox"**. Submission category: **Predictions**.

Inspired by [Kreopoly](https://kreopoly.app), a Telegram bot for copy-trading on Polymarket. Kreopoly has no public API, so this plugin reproduces its intelligence layer using public on-chain data and routes any money-moving operation through PayBox's non-custodial signing layer.

---

## What it does

An AI agent (Grok, Claude, ChatGPT, or any MCP-speaking host) connected to PayBox can install this plugin and ask:

- *"What are my open Polymarket positions and P&L?"* → `kreopoly_get_positions`
- *"Track this wallet for me."* → `kreopoly_track_wallet`
- *"What have my tracked wallets been doing?"* → `kreopoly_get_tracked_activity`
- *"Buy $20 of YES on 'Will BTC hit $100k' at max 0.65."* → `kreopoly_place_bet`

The plugin **never** sees the private key. `kreopoly_place_bet` returns a `signing_request` that the agent forwards to PayBox's native `request_wallet_sign` MCP tool. PayBox signs inside its MPC enclave (key never leaves), broadcasts, and the trade settles.

## Plugin architecture

```
┌────────────────────────────┐
│  AI agent (Claude/Grok/…)  │
└──────────┬─────────────────┘
           │ MCP
           ▼
┌────────────────────────────┐         ┌──────────────────────┐
│   PayBox                   │  OAuth  │  paybox-kreopoly-lens│
│   - list_credentials       │◀───────▶│  (this plugin)       │
│   - request_wallet_sign    │         │                      │
│   - request_payment        │         │  4 MCP tools:        │
└──────────┬─────────────────┘         │   - get_positions    │
           │                           │   - track_wallet     │
           │ signing_request           │   - get_tracked_     │
           ▼                           │     activity         │
┌────────────────────────────┐         │   - place_bet        │
│  PayBox MPC enclave        │         │                      │
│  - signs tx (key never     │         │  Reads:              │
│    leaves)                 │         │   - Polygon RPC      │
│  - broadcasts              │         │   - Polymarket Gamma │
└──────────┬─────────────────┘         │   - Polygonscan API  │
           │                           └──────────────────────┘
           ▼
┌────────────────────────────┐
│  Polymarket CTF Exchange   │
│  (Polygon)                 │
└────────────────────────────┘
```

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `kreopoly_get_positions` | Free | List user's open Polymarket positions with live P&L. Sort by profit / size / expiry / recent (Kreopoly parity). Filter by category. |
| `kreopoly_track_wallet` | Free | Add/remove/list wallets on the watchlist |
| `kreopoly_get_tracked_activity` | Free | Recent on-chain Polymarket trades from tracked wallets |
| `kreopoly_place_bet` | Paid (by user) | Construct a Polymarket bet, return as `signing_request` for PayBox |
| `kreopoly_copy_trade` | Free | Manage copy-trade tasks: create, list, pause, resume, delete, update. Full Kreopoly config: 4 sizing methods, 5 directions, filters (max/min buy, daily cap, price range, one-entry-per-market, 13 category filters), stop loss, take profit, market/limit entry, **limit order expiration** |
| `kreopoly_check_copy_signals` | Free | Poll copy tasks for new source-wallet activity, return pending mirror trades |
| `kreopoly_settle_position` | Paid (by user) | Redeem winning Polymarket shares after market resolution |
| `kreopoly_list_categories` | Free | Returns the 13 turnkey Polymarket categories Kreopoly uses as toggleable filters |

## Quickstart

The plugin supports **two transports**:

| Transport | Use case | Entry point |
|---|---|---|
| **stdio** | Claude Desktop, PayBox Desktop, any MCP host that spawns a child process | `node dist/index.js` |
| **HTTP** (Streamable HTTP) | ChatGPT (Custom Connectors / Developer Mode), remote MCP clients, Render/Railway deployment | `node dist/http.js --port=3000` |

Both expose the same 8 tools — pick the one your AI client supports.

### Client setup guides

Step-by-step instructions for each AI client:

- **[clients/CLAUDE_DESKTOP.md](./clients/CLAUDE_DESKTOP.md)** — Claude Desktop config (stdio)
- **[clients/CHATGPT.md](./clients/CHATGPT.md)** — ChatGPT setup with ngrok or Render (HTTP)
- **[clients/claude_desktop_config.json](./clients/claude_desktop_config.json)** — ready-to-edit config file for Claude Desktop
- **[render.yaml](./render.yaml)** — one-click deploy to Render for permanent ChatGPT-compatible hosting

### 1. Install

```bash
git clone <your-fork-url> paybox-kreopoly-lens
cd paybox-kreopoly-lens
npm install
npm run build
```

### 2. Configure

Create `.env`:

```bash
# Optional but recommended — lifts Polygonscan rate limits (free, 5 req/s)
POLYGONSCAN_API_KEY=your_key_here

# Optional — public Polygon RPC used if unset
POLYGON_RPC_URL=https://polygon-rpc.com

# Optional — where to store the watchlist (default: ./.data/watchlist.json)
WATCHLIST_PATH=./.data/watchlist.json
```

### 3. Test locally with the MCP inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

This opens a web UI where you can call each tool and verify responses.

### 4. Register with PayBox

Once you have a PayBox account and an agent client, add this plugin to your `.mcp.json` (PayBox reads it on agent connect):

```json
{
  "mcpServers": {
    "kreopoly-lens": {
      "command": "node",
      "args": ["/absolute/path/to/paybox-kreopoly-lens/dist/index.js"],
      "env": {
        "POLYGON_RPC_URL": "https://polygon-rpc.com",
        "POLYGONSCAN_API_KEY": "your_key_here"
      }
    }
  }
}
```

In PayBox, grant the plugin access to your Polygon wallet. Pick an approval mode:

| Mode | Use when |
|---|---|
| `autonomous` | You trust the agent within your spend threshold — fast demo flow |
| `iframe` | You want in-context approval prompts — good middle ground |
| `always_approve` | Every trade requires a passkey — safest |

### 5. Demo flow

In your MCP-connected agent (Grok, Claude, ChatGPT, etc.):

#### Read flow

```
You:     What are my Polymarket positions?
Agent:   [calls kreopoly_get_positions]
         You have 3 open positions worth $42.50 total:
           - "Will BTC hit $100k by Dec 31?" — 20 YES @ 0.62 = $12.40
           - ...

You:     Track this wallet for me: 0x9e1f...a33c, label "Whale #1"
Agent:   [calls kreopoly_track_wallet {action: "add", ...}]
         Now tracking 0x9e1f...a33c (Whale #1).

You:     What's Whale #1 been up to?
Agent:   [calls kreopoly_get_tracked_activity]
         Whale #1 made 2 trades in the last 24h:
           - Bought $4,200 of YES on "US election outcome" @ 0.71
           - ...
```

#### Copy-trading flow (Kreopoly's headline feature)

```
You:     Copy trades from 0x9e1f...a33c. Label it "Whale #1 mirror".
Agent:   Got it. Let me walk you through the config.

         Sizing: how much per mirror trade?
           - fixed: same $ amount each time (e.g. $20)
           - percent: % of your wallet (e.g. 5%)
           - exact: mirror their $ amount exactly
           - portfolio_weighted: scale by bankroll ratio

You:     Fixed, $20.

Agent:   Direction?
           - follow_buys (recommended)
           - copy_sells, buy_on_sells, counter_trade, copy_sides

You:     Follow buys.

Agent:   Risk limits? I recommend:
           - dailyCapUsd: $100
           - maxBuyUsd: $5,000
           - stopLoss: 0.40
           - takeProfit: 0.85

You:     Looks good.

Agent:   Entry mode: market or limit?

You:     Market.

Agent:   Confirm: copy Whale #1's buys, $20 fixed, daily cap $100,
         SL 0.40, TP 0.85, market entry. Activate?

You:     Yes.

Agent:   [calls kreopoly_copy_trade {action: "create", ...}]
         Now copying Whale #1 mirror. Say "stop" to pause.

         [30s later, agent calls kreopoly_check_copy_signals]
         Whale #1 just bought $4,200 of YES on "Will BTC hit $100k".
         Mirroring: 40 shares @ max 0.65 = ~$26.00.
         Cost breakdown: $26.00 shares + $0.39 fee + $0.01 gas = $26.40.
         Sign to proceed?

You:     Yes.

Agent:   [calls kreopoly_place_bet → gets signing_request]
         [forwards to PayBox request_wallet_sign]
         Done. Tx hash: 0xabc...123

You:     Stop copying.
Agent:   [calls kreopoly_copy_trade {action: "pause", ...}]
         Paused. Say "resume" to restart.
```

#### Settlement flow (redeem winnings)

```
You:     Did any of my markets resolve? Redeem my winnings.

Agent:   [calls kreopoly_get_positions, identifies resolved markets]
         "Will BTC hit $100k by Dec 31?" resolved YES.
         You have 40 winning shares = $40.00.
         Gas: $0.01. Net: $39.99.
         Sign to redeem?

You:     Yes.

Agent:   [calls kreopoly_settle_position → gets signing_request]
         [forwards to PayBox request_wallet_sign]
         Redeemed. $39.99 USDC.e now in your wallet.
```

## Project layout

```
paybox-kreopoly-lens/
├── manifest.json            # PayBox plugin manifest (displayName, logo, capabilities)
├── .mcp.json                # MCP server config (consumed by PayBox)
├── package.json
├── tsconfig.json
├── README.md
├── demo-script.md           # 60–90s video script for the X post
├── LICENSE                  # MIT
├── assets/
│   └── logo.svg             # 128×128 plugin logo
├── skills/
│   ├── kreopoly-overview.md       # What the plugin does, when to reach for it
│   ├── kreopoly-cost-checks.md    # How to estimate cost before spending
│   └── kreopoly-copy-trading.md   # Copy-trade setup, monitoring, settlement
└── src/
    ├── index.ts             # MCP server entry (stdio transport)
    ├── lib/
    │   ├── polygon.ts       # On-chain reads (RPC, Gamma API, Polygonscan)
    │   ├── store.ts         # Local JSON watchlist persistence
    │   ├── copyTasks.ts     # Copy-task store + signal detection + limit expiration
    │   ├── categories.ts    # 13 hardcoded Polymarket categories
    │   └── zodToJsonSchema.ts
    └── tools/
        ├── getPositions.ts          # + sortBy + category filter
        ├── trackWallet.ts
        ├── getTrackedActivity.ts
        ├── placeBet.ts
        ├── copyTrade.ts             # create/list/pause/resume/delete/update + limitExpiresAt
        ├── checkCopySignals.ts      # poll source wallets + respect limit expiration
        ├── settlePosition.ts        # redeem winning shares post-resolution
        └── listCategories.ts        # 13 turnkey category slugs
```

## Design decisions

### Why no direct Kreopoly integration?

Kreopoly has no public API. It's a Telegram bot — every action goes through chat commands. Wrapping the bot would mean scraping Telegram, which is fragile and against ToS.

But Kreopoly's actual value lives **on-chain**. Polymarket runs on Polygon. Every position, every wallet move, every P&L number is publicly readable from the Polymarket CTF Exchange contract and the user's wallet address. So this plugin replicates Kreopoly's intelligence layer using public data — no Kreopoly API required.

### Why does `place_bet` return a `signing_request` instead of signing?

Three reasons:

1. **Non-custodial ethos.** PayBox's whole pitch is that the agent never holds the key. If this plugin signed the tx itself, it would need the key — defeating the purpose.
2. **Hackathon compliance.** The judging criteria explicitly call out "compliance" and "usefulness." Routing through PayBox's `request_wallet_sign` demonstrates the correct agent → PayBox flow and respects the user's approval mode.
3. **Forward compatibility.** When PayBox adds new chains or new wallet types, this plugin doesn't need to change — PayBox handles signing.

### Why TypeScript/Node?

- The official `moonpay/paybox-plugin` reference is TypeScript/Node.
- The PayBox SDK is a typed Node SDK.
- MCP SDK has first-class TypeScript support.
- One language across the whole stack — fewer build/runtime surprises.

### What's the v0.1 limitation?

1. **`place_bet` calldata** — returns a stub `fillOrder` calldata placeholder. To actually fill an order on Polymarket's CLOB, you need to fetch an order from Polymarket's CLOB API and sign it EIP-712. Production wiring is documented in `src/tools/placeBet.ts` — replace `buildOrderIntent` with `@polymarket/order-utils`'s `encodeOrder`.

2. **Source trade decoding in copy signals** — the plugin detects that a tracked wallet made a Polymarket transaction, but cannot decode the conditionId / outcome / size from raw Polygonscan data alone. The agent must use the Polymarket Data API (`https://data-api.polymarket.com/positions?user=<source>`) to look up the source wallet's latest position. This is one extra call per actionable signal.

3. **Stop loss / take profit — STORED, MANUAL TRIGGER** — these are stored on each copy task and surfaced to the agent, but the plugin does NOT automatically execute SL/TP sells. The agent must:
   - Periodically call `kreopoly_get_positions` for the user's wallet
   - For each position, compare current price against the originating task's `stopLoss` / `takeProfit`
   - If hit, call `kreopoly_place_bet` with the opposite outcome (sell) to close the position
   - This keeps custody with PayBox (no auto-selling without a signing_request) and matches Kreopoly's "per-execution SL/TP" semantics, where SL/TP applies to the mirrored shares specifically.
   - See `skills/kreopoly-copy-trading.md` for the agent-side SL/TP check pattern.

4. **No background polling** — the agent must initiate `check_copy_signals` calls. There's no push from the plugin to the agent.

5. **Crypto Price Entry mode not implemented** — Kreopoly exposes a second auto-trade entry mode that triggers entries based on BTC/ETH price movements, distinct from market/limit. This is on the roadmap; not in v0.1.

6. **5m/15m crypto price auto-trade** — Kreopoly's preset strategies for Polymarket's crypto price prediction markets are not implemented. Niche feature, low judging impact.

## Error semantics & layer attribution

All tool responses follow a standardized error structure:

```json
{
  "ok": false,
  "error": {
    "code": "ACTIVITY_FETCH_FAILED",
    "message": "Activity provider returned HTML instead of JSON.",
    "retryable": true,
    "layer": "activity_provider",
    "upstreamStatus": 200,
    "upstreamProvider": "polygonscan",
    "upstreamContentType": "text/html",
    "upstreamPreview": "<!DOCTYPE html>..."
  }
}
```

### Error layers

| Layer | What it means |
|---|---|
| `client_input` | Bad args from the agent (schema validation, invalid address) |
| `activity_provider` | Upstream API failure (Polygonscan / Polymarket Data API) — HTML, rate limit, WAF, timeout |
| `market_provider` | Polymarket Gamma API failure (market not found, market closed) |
| `watchlist_store` | Local watchlist persistence failed (write → verify → return success) |
| `copytask_store` | Local copy-task persistence failed |
| `construction` | Building the order_intent / redeem_intent failed |
| `signing` | PayBox signing layer (forwarded via separate MCP tool) |
| `execution` | Blockchain / Polymarket execution (broadcast, revert, insufficient balance) |
| `internal` | Unhandled / unexpected |

### Error codes (full list in `src/lib/errors.ts`)

| Code | Layer | Meaning |
|---|---|---|
| `UPSTREAM_TIMEOUT` | activity_provider | Network timeout fetching from Polygonscan / Polymarket |
| `UPSTREAM_RATE_LIMITED` | activity_provider | HTTP 429 or Polygonscan "Max calls" |
| `UPSTREAM_INVALID_RESPONSE` | activity_provider | JSON parse failed |
| `UPSTREAM_HTML_RESPONSE` | activity_provider | Got HTML where JSON expected (WAF / Cloudflare) |
| `UPSTREAM_HTTP_ERROR` | activity_provider | Other HTTP 4xx/5xx |
| `UPSTREAM_BLOCKED` | activity_provider | WAF challenge page detected |
| `ACTIVITY_FETCH_FAILED` | activity_provider | Generic activity-fetch failure (any of the above) |
| `INVALID_PARAMETERS` | client_input | Zod schema validation failed |
| `WALLET_INVALID_FORMAT` | client_input | Address not 40-hex / 0x-prefixed |
| `WATCHLIST_PERSISTENCE_FAILED` | watchlist_store | write → verify failed |
| `COPYTASK_PERSISTENCE_FAILED` | copytask_store | write → verify failed |
| `MARKET_NOT_FOUND` | market_provider | conditionId does not match any Polymarket market |
| `MARKET_CLOSED` | market_provider | Market is no longer active |
| `MARKET_NOT_RESOLVED` | market_provider | Market exists but has not resolved yet |
| `NO_SHARES_TO_REDEEM` | market_provider | Reference account has no shares in this market |
| `BET_CONSTRUCTION_FAILED` | construction | Order intent build failed |
| `SETTLEMENT_CONSTRUCTION_FAILED` | construction | Redeem intent build failed |
| `SIGNING_REQUIRED` | signing | PayBox signing prompt is needed |
| `SIGNING_FAILED` | signing | PayBox signing layer failed |
| `INSUFFICIENT_BALANCE` | execution | Wallet has insufficient USDC.e |
| `TRANSACTION_REVERTED` | execution | On-chain execution reverted |
| `NO_ACTIVITY` | internal | Upstream OK but no new trades (genuine zero) |
| `NO_MATCHING_TRADES` | internal | Upstream OK, filters rejected all trades |
| `NO_ACTIONABLE_SIGNAL` | internal | Upstream OK, no actionable mirror suggestion |
| `TASK_NOT_FOUND` | internal | Copy-task ID does not exist |
| `INTERNAL_ERROR` | internal | Unhandled exception |

### Critical distinction: `NO_ACTIVITY` ≠ `ACTIVITY_FETCH_FAILED`

These MUST NOT be conflated:

- `NO_ACTIVITY` (ok=true) — upstream confirmed OK, no trades found. Genuine zero.
- `ACTIVITY_FETCH_FAILED` (ok=false) — upstream failed. Do NOT treat as "no trades".

The signal-check response always includes a `funnel` object that shows exactly what happened at each filter stage:

```json
{
  "ok": true,
  "results": [{
    "task": { "id": "...", "label": "...", "sourceWallet": "..." },
    "ok": true,
    "funnel": {
      "upstreamProvider": "polymarket-data-api-activity",
      "upstreamStatus": 200,
      "rawTradesDetected": 15,
      "polymarketTradesDetected": 15,
      "newTradesDetected": 4,
      "afterDirectionFilter": 3,
      "afterCategoryFilter": 2,
      "afterSizeFilter": 1,
      "afterDuplicateMarketFilter": 1,
      "actionableSignals": 1,
      "rejectionReasons": [
        "tx 0xabcd: follow_buys requires tx.type=buy, got sell",
        "tx 0x1234: $8.00 above max_buy $5"
      ]
    }
  }]
}
```

If `ok=false`, the funnel shows `upstreamProvider`, `upstreamStatus`, and a `rejectionReasons` array containing the upstream error message — never silently converted to "no activity".

## Submitting to the hackathon

Two deliverables required:

1. **Working plugin** — this repo, with a live demo via an MCP-connected agent
2. **Demo video on X** — 60–90s showing the plugin working end-to-end

See `demo-script.md` for the scripted demo flow used in the video.

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

- [MoonPay PayBox](https://docs.paybox.sh/) — the non-custodial credential vault this plugin targets
- [Kreopoly](https://kreopoly.app) — the Telegram bot that inspired the intelligence layer
- [Polymarket](https://polymarket.com) — the underlying prediction market on Polygon
- [x402](https://x402.org) — the open payment protocol PayBox speaks natively

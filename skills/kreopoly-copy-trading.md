---
name: kreopoly-copy-trading
description: How to set up, monitor, and stop a copy-trade task. One-time confirmation at setup, then autonomous within policy. How to settle winning positions.
---

# Kreopoly Lens — Copy Trading & Settlement

## The mental model

A copy-trade task is a per-user rule that says:

> "When wallet X makes a Polymarket trade matching filters F, suggest a mirror trade using sizing method S, subject to risk R."

The plugin **does not auto-execute** mirror trades. It surfaces them as "signals" via `kreopoly_check_copy_signals`. The agent then:

1. Reads the suggested mirror trade
2. Resolves the source trade's market (conditionId) via the Polymarket Data API
3. Presents the cost to the user
4. Calls `kreopoly_place_bet` to get a `signing_request`
5. Forwards it to PayBox's `request_wallet_sign`

This satisfies "ask for confirmation first" at two layers:
- **At setup**: agent walks user through config and confirms before creating the task
- **At each mirror trade**: flows through PayBox's standard signing path, which respects the user's approval mode (autonomous / iframe / always_approve) and per-credential spend threshold

## Setting up a copy task — the conversation flow

The agent should follow this pattern when the user says "copy trades from wallet 0x...":

1. **Confirm the source wallet** — show the address back to the user, ask if it's correct
2. **Walk through sizing** — explain the four methods and recommend one:
   - `fixed` — same $ amount per trade (simplest, safest)
   - `exact` — mirror source USD amount exactly (highest fidelity, highest risk)
   - `percent` — % of user's wallet balance per trade (scales with bankroll)
   - `portfolio_weighted` — scale source trade by user/source bankroll ratio (most sophisticated)
3. **Walk through direction** — recommend `follow_buys` for beginners:
   - `follow_buys` — copy source's buys only
   - `copy_sells` — close positions when source does
   - `buy_on_sells` — contrarian: buy when source sells
   - `counter_trade` — opposite direction of every source trade
   - `copy_sides` — mirror both buys and sells
4. **Set risk limits** — strongly recommend at minimum:
   - `dailyCapUsd` — typically 10–20% of wallet balance
   - `maxBuyUsd` — cap on any single mirrored trade
   - `stopLoss` + `takeProfit` — 0.4 and 0.85 are sensible defaults
5. **Confirm entry mode**:
   - `market` — fill at current price (fast, slippage risk)
   - `limit` — only fill at or below `limitMaxPrice` (slippage protection, may not fill)
   - For `limit` mode, optionally set `limitExpiresAt` (Unix seconds) — after this time, the limit order stops triggering. Mirrors Kreopoly's "Limit order expiration (by time or exact Unix timestamp)".
6. **Optionally filter by category** — call `kreopoly_list_categories` to get the 13 turnkey Polymarket categories (Politics, Crypto, Sports, Pop Culture, Business, Economics, Geopolitics, Science, Tech, AI, Climate, Entertainment, Legal). Pass desired slugs to `filters.categories`.
7. **State the full config back to the user and ask: "Confirm?"**
8. Only on confirmation, call `kreopoly_copy_trade action='create'` with `enabled: true`
9. Tell the user: *"Now copying [label]. Say 'stop' to pause."*

## Monitoring — the polling loop

Once a task is active, the agent should periodically call `kreopoly_check_copy_signals`:

- During an interactive session: every 30–60 seconds
- On user prompt: "Any new copies?" / "What's Whale #1 been up to?"
- Background polling (if the host supports it): every 5 minutes

Each call returns signals — actionable or not. For actionable signals:

```
[agent]: Whale #1 just made a trade:
  - Type: buy
  - Amount: $4,200
  - Suggested mirror: 40 shares YES @ max 0.65 = ~$26.00
  - Source: 0x1234...abcd

I need to resolve which market they traded. Looking it up...

[agent calls Polymarket Data API for source wallet's latest position]
[agent resolves conditionId]

[agent]: They bought YES on "Will BTC hit $100k by Dec 31?" at 0.62.
This will cost approximately $26.40:
  - Shares: $26.00
  - Polymarket fee: $0.39
  - Gas: $0.01

Sign to proceed? (You can also say "skip" or "stop copying")

[user]: yes

[agent calls kreopoly_place_bet → gets signing_request]
[agent forwards signing_request to PayBox request_wallet_sign]
[agent]: Done. Tx hash: 0xabc...123
```

## Stopping

Two ways to stop:

1. **Pause** (keeps config, can resume): `kreopoly_copy_trade action='pause'`
2. **Delete** (removes config entirely): `kreopoly_copy_trade action='delete'`

The user can also say "stop copying" or "pause" in natural language — the agent should map that to `pause`. If the user says "remove" or "delete this copy task", use `delete`.

## Updating

You can update any field on a live task via `kreopoly_copy_trade action='update'`. Common updates:

- Tighten the daily cap after a losing streak
- Switch from `market` to `limit` entry mode after bad slippage
- Add a stop loss that wasn't set initially

## Settling winning positions

After a market resolves, winning shares are worth $1 USDC.e each. To redeem:

```
[user]: Did any of my markets resolve? Redeem my winnings.

[agent]: Let me check your positions for resolved markets.
[agent calls kreopoly_get_positions, identifies resolved markets]
[agent calls kreopoly_settle_position for each]

[agent]: "Will BTC hit $100k by Dec 31?" resolved YES.
You have 40 winning shares = $40.00 USDC.e.
Gas: $0.01. Net: $39.99.
Sign to redeem?

[user]: yes

[agent forwards signing_request to PayBox]
[agent]: Redeemed. $39.99 USDC.e now in your wallet.
```

If the market is not yet resolved, `settle_position` returns the resolution date and a clear "try again later" message — no signing request is generated.

## Stop loss / take profit — IMPORTANT: MANUAL TRIGGER

Stop loss and take profit are **stored on each copy task** but **NOT automatically executed** by the plugin. The agent must do this:

1. Periodically (every 30–60s during an active session), call `kreopoly_get_positions` for the user's wallet
2. For each position, look up the originating task (by matching the market's conditionId against the task's `enteredMarkets`)
3. Compare the position's `currentPrice` against the task's `stopLoss` and `takeProfit`
4. If `currentPrice <= task.stopLoss` → trigger a sell:
   - Call `kreopoly_place_bet` with `outcome` flipped (if user holds YES, sell YES = buy NO) or use Polymarket's CLOB sell path
   - Present the cost (which will be negative — proceeds) to the user
   - On confirmation, forward the signing_request to PayBox
5. If `currentPrice >= task.takeProfit` → same flow as stop loss
6. After closing, remove the conditionId from `task.filters.enteredMarkets` so the task can re-enter if the source trades again

This matches Kreopoly's "Stop loss and take profit settings that apply **per execution** — not per position" semantics: SL/TP applies to the specific mirrored shares, not the user's whole position in that market.

**Why not auto-execute?** Because every sell needs a `signing_request` that flows through PayBox's MPC signing. The plugin can't initiate signing on its own — that would require holding the key, breaking the non-custodial model.

## v0.1 limitations (be honest with the user)

1. **Source trade decoding**: the plugin can detect that a tracked wallet made a Polymarket transaction, but cannot decode the conditionId / outcome / size from raw Polygonscan data alone. The agent must use the Polymarket Data API (`https://data-api.polymarket.com/positions?user=<source>`) to look up the source wallet's latest position. This is one extra call per actionable signal.

2. **Place_bet calldata**: the actual `fillOrder` calldata is a stub. Production wiring requires fetching an order from Polymarket's CLOB API and signing it EIP-712. See `src/tools/placeBet.ts` comments for the production path.

3. **Stop loss / take profit**: STORED, MANUAL TRIGGER. See the section above for the agent-side pattern.

4. **No background polling**: the agent must initiate `check_copy_signals` calls. There's no push from the plugin to the agent.

5. **Crypto Price Entry mode**: not implemented (Kreopoly's second entry mode based on BTC/ETH price triggers). Market and limit only in v0.1.

6. **5m/15m crypto price auto-trade**: Kreopoly's preset strategies for Polymarket's crypto price prediction markets are not implemented.

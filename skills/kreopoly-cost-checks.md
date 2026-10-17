---
name: kreopoly-cost-checks
description: How to estimate cost before spending, what a 402/403 means, and how to fail gracefully on Polymarket bets.
---

# Kreopoly Lens — Cost Checks & Failure Modes

## The golden rule

**Always tell the user the cost before calling `place_bet`.** This is a PayBox marketplace requirement and a judging criterion for the MoonPay Hackathon.

A well-behaved agent using this plugin:

1. Calls `get_positions` or `get_tracked_activity` (free reads)
2. Computes the trade cost in USD (shares × price + gas estimate)
3. States the cost to the user in plain language
4. Only then calls `place_bet` — and only if the user has agreed

## What costs money

| Operation | Cost | Who pays |
|---|---|---|
| `get_positions` | Free (Polygon RPC public endpoint) | No one |
| `track_wallet` | Free (local storage) | No one |
| `get_tracked_activity` | Free (public Polygonscan API, rate-limited) | No one |
| `place_bet` | `shares × price` USDC.e + ~$0.01 Polygon gas + Polymarket fee | User's Polygon wallet |

The Polymarket fee formula: `max(0.003, 0.07 × price × (1 − price))` per share, paid by the taker.

## Pre-spend pattern

Before `place_bet`, the agent should run:

```
cost_usd = shares × price
gas_usd  = 0.01   // approximate Polygon gas in USDC
fee_usd  = shares × max(0.003, 0.07 × price × (1 − price))
total    = cost_usd + gas_usd + fee_usd
```

State this to the user as: *"This will cost approximately $X.XX (shares: $A, fees: $B, gas: $C). Sign to proceed?"*

## Failing listings gracefully

### `403 insufficient_grant`
The user has not granted a Polygon wallet to this plugin. **Do not retry.** Tell the user to open PayBox and grant the credential, then retry.

### `402 payment_required`
PayBox returned a payment challenge (rare for wallet signing, common for x402 services). For `place_bet`, this should not occur — the wallet signing path is OAuth/MPC, not x402. If it does, surface the challenge to the user.

### `429 rate_limit`
The Polygonscan free tier (5 calls/sec, 100k/day) was hit. Wait 1 second and retry once. If it persists, tell the user to set `POLYGONSCAN_API_KEY`.

### `market_closed` / `market_not_found`
The Polymarket market ID is invalid or the market has resolved. Do not retry. Tell the user the market is closed and suggest checking current open markets at polymarket.com.

### `insufficient_balance`
The user's Polygon wallet does not have enough USDC.e for `shares × price`. Tell the user the shortfall and suggest funding via PayBox's `get_buy_link` or `request_swap`.

## What a card authorization does NOT do

This plugin does **not** use cards. All trades settle from the user's Polygon wallet in USDC.e. If the user asks "can I pay with my card?", route them to PayBox's `get_buy_link` to onramp USDC to Polygon first, then retry `place_bet`.

## When to refuse a trade

Refuse `place_bet` and explain to the user if:

- The market price is `< 0.05` or `> 0.95` (extreme odds — usually low-liquidity or near-resolution)
- The position size exceeds 10% of the user's visible Polygon wallet balance
- The market has `< 1 hour` to resolution (slippage risk)
- The user is on a sanctions list (PayBox will reject upstream — but mention it proactively)

These are not hard blocks; they are advisory. The user can override by re-confirming.

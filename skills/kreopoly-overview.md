---
name: kreopoly-overview
description: What the Kreopoly Lens plugin does, when to reach for it, and how it differs from PayBox's native wallet tools.
---

# Kreopoly Lens — Overview

## What this plugin is

Kreopoly Lens is a PayBox marketplace plugin that gives an AI agent on-chain intelligence about **Polymarket** prediction markets on Polygon — plus the ability to actually place a bet through PayBox's non-custodial signing layer.

It is inspired by [Kreopoly](https://kreopoly.app), a Telegram bot for copy-trading on Polymarket and Kalshi. Kreopoly has no public API. This plugin reproduces its core intelligence layer using public on-chain data (Polygon RPC + the Polymarket CTF Exchange contract) and routes any money-moving operation through PayBox.

## When to reach for this plugin

Use Kreopoly Lens when the user wants to:

- See their **open Polymarket positions** and live P&L
- **Track** a Polymarket wallet's recent activity (smart-money watching)
- **Place a bet** on a Polymarket market (buy YES or NO shares)
- Get a **pre-trade cost estimate** before signing

Do NOT use this plugin for:

- Kalshi trading (not supported — Kalshi is CFTC-regulated and not on-chain)
- Copy-trading automation (this plugin surfaces data; the agent decides)
- Withdrawals, transfers, or anything outside Polymarket's CTF Exchange

## How it differs from PayBox's native tools

| PayBox native | Kreopoly Lens |
|---|---|
| `request_payment` — generic card / wallet payment | `place_bet` — constructs a Polymarket CTF Exchange order, returns it for `request_wallet_sign` |
| `get_portfolio` — wallet balances across chains | `get_positions` — Polymarket positions with current price + P&L |
| — | `track_wallet` + `get_tracked_activity` — Polymarket-specific wallet watching |

## Chain & asset scope

- **Chain:** Polygon (chainId 137)
- **Asset:** USDC.e (Polymarket's settlement token)
- **Contract scope:** Polymarket CTF Exchange + ERC-1155 position tokens
- **Wallet requirement:** A Polygon wallet granted to this plugin via PayBox

## The non-custodial model

This plugin **never** sees the user's private key. The flow for `place_bet` is:

1. The plugin constructs an unsigned Polymarket CTF Exchange transaction
2. Returns it to the agent as a `signing_request`
3. The agent forwards it to PayBox's native `request_wallet_sign` MCP tool
4. PayBox signs inside its MPC enclave (key never leaves)
5. PayBox broadcasts — or returns the signed tx for the plugin to broadcast

If the user's credential is in `autonomous` mode and the trade is under their threshold, this completes silently. Otherwise the user gets a passkey prompt. Either way, **the plugin never holds custody**.

## Approval mode expectations

| Mode | Behavior |
|---|---|
| `autonomous` | Reads always work. Trades complete silently if under threshold. |
| `iframe` | Trades prompt in an embedded approval frame. |
| `always_approve` | Trades prompt every time, even reads are uninterrupted. |

If the agent gets a `403 insufficient_grant` from PayBox, it means the user has not granted the Polygon wallet to this plugin. Tell the user to open PayBox and grant the credential.

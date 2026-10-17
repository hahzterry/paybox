# Demo video script (75–90s for X post)

## Setup before recording

1. PayBox open in a browser tab, connected to Claude (or Grok)
2. Kreopoly Lens plugin installed and granted a Polygon wallet (autonomous mode, low threshold)
3. Wallet funded with ~$50 USDC.e on Polygon
4. A second wallet in the watchlist (use a known active Polymarket whale for visible activity)
5. Pre-create a copy task pointing at the whale, paused — so you can "resume" on camera

## Script

**[0:00 — 0:08]** Screen shows Claude with PayBox connector active.

> Voiceover: "Built a PayBox marketplace plugin for the MoonPay Hackathon: Kreopoly Lens. It gives an AI agent on-chain Polymarket intelligence — read positions, track wallets, copy trades, and settle winners — without ever holding the key."

**[0:08 — 0:18]** Type in Claude: "What are my Polymarket positions?"

> Agent calls `kreopoly_get_positions`. Returns 3 positions with live P&L.
>
> Voiceover: "First — read mode. The agent pulls my open positions straight from Polygon. Zero cost, zero custody."

**[0:18 — 0:35]** Type: "Set up a copy trade from this wallet: 0x9e1f…a33c, label 'Whale #1'. Fixed $20 per trade, follow buys, daily cap $100, stop loss 0.40, take profit 0.85."

> Agent walks through confirmation, then calls `kreopoly_copy_trade {action: "create"}`.
> Returns: "Now copying Whale #1 mirror. Say 'stop' to pause."
>
> Voiceover: "Now — copy trading. One-time setup confirmation. Sizing, filters, risk limits — all configurable. After this, the agent polls for new source trades automatically."

**[0:35 — 0:55]** Wait ~10s, then type: "Any new copy signals?"

> Agent calls `kreopoly_check_copy_signals`. Returns: "Whale #1 just bought $4,200 of YES on 'Will BTC hit $100k by Dec 31?'. Mirroring: 40 shares @ max 0.65. Cost: $26.40. Sign to proceed?"
>
> Voiceover: "When the source wallet trades, the plugin suggests a mirror — with full cost breakdown. The agent forwards it to PayBox's signing layer."

**[0:55 — 1:10]** Type: "Yes."

> Agent calls `kreopoly_place_bet`, gets `signing_request`, forwards to PayBox's `request_wallet_sign`. Returns tx hash.
>
> Voiceover: "PayBox signs inside the MPC enclave — the key never leaves. The agent never holds it. The plugin never holds it."

**[1:10 — 1:20]** Type: "Stop copying."

> Agent calls `kreopoly_copy_trade {action: "pause"}`.
>
> Voiceover: "User can stop any time. One word."

**[1:20 — 1:30]** End card: "MoonPay Hackathon Chapter 1 — Predictions category. 7 MCP tools. Built with PayBox + MCP + Polymarket. Non-custodial, end-to-end."

## Hashtags for X post

`#MoonPayHackathon #PayBox #AI #MCP #Polymarket #Agents #x402 #PredictionMarkets #CopyTrading`

## Tips for the recording

- Use Loom or QuickTime screen recording — 1280×720 is fine for X
- Speak clearly and not too fast — agents move slower than you think
- Pre-stage the copy task so you don't have to wait for real whale activity
- If the `place_bet` step takes >10s, cut to the tx on Polygonscan instead of waiting
- Pin the tweet with the demo link in your hackathon submission
- Optional: include a 3-second shot of the `manifest.json` to show it's a real PayBox plugin

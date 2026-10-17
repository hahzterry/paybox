# Claude Desktop — MCP Client Setup

## How Claude Desktop launches MCP plugins

Claude Desktop reads a config file on startup that lists MCP servers to spawn as child processes. Your plugin runs via **stdio** — Claude sends JSON-RPC requests to the plugin's stdin and reads responses from stdout.

## Step 1 — Install Claude Desktop

If you don't already have it:
- Download from https://claude.ai/download (Mac, Windows, Linux)
- Sign in with your Anthropic account (free tier works)

## Step 2 — Edit the config file

**macOS:**
```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Windows (PowerShell):**
```powershell
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

**Linux:**
```bash
nano ~/.config/Claude/claude_desktop_config.json
```

If the file doesn't exist yet, create it.

## Step 3 — Paste this config

```json
{
  "mcpServers": {
    "kreopoly-lens": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/paybox-kreopoly-lens/dist/index.js"],
      "env": {
        "POLYGON_RPC_URL": "https://polygon-rpc.com",
        "POLYGONSCAN_API_KEY": "YOUR_POLYGONSCAN_API_KEY",
        "WATCHLIST_PATH": "/ABSOLUTE/PATH/TO/paybox-kreopoly-lens/.data/watchlist.json",
        "COPYTASKS_PATH": "/ABSOLUTE/PATH/TO/paybox-kreopoly-lens/.data/copytasks.json"
      }
    }
  }
}
```

**Replace:**
- `/ABSOLUTE/PATH/TO/paybox-kreopoly-lens/` — the real path to your plugin folder
  - Mac example: `/Users/yourname/code/paybox-kreopoly-lens`
  - Windows example: `C:\\Users\\yourname\\code\\paybox-kreopoly-lens` (use double backslashes in JSON)
  - Linux example: `/home/yourname/code/paybox-kreopoly-lens`
- `YOUR_POLYGONSCAN_API_KEY` — get a free key at https://polygonscan.com/apis (sign up → API Keys → Add)

A ready-to-edit template is at `clients/claude_desktop_config.json` in this repo.

## Step 4 — Make sure the plugin is built

```bash
cd /path/to/paybox-kreopoly-lens
npm install
npm run build

# Verify it boots:
node dist/index.js
# Should print: "[paybox-kreopoly-lens] MCP stdio server ready. Tools: ..."
# Press Ctrl+C to exit
```

## Step 5 — Restart Claude Desktop

Fully quit Claude Desktop (not just close the window) and reopen it.

## Step 6 — Verify the plugin is loaded

1. Open a new chat in Claude Desktop
2. Look for the **hammer icon** (🔨) in the chat input area
3. Click it — you should see all 8 `kreopoly_*` tools listed:
   - kreopoly_get_positions
   - kreopoly_track_wallet
   - kreopoly_get_tracked_activity
   - kreopoly_place_bet
   - kreopoly_copy_trade
   - kreopoly_check_copy_signals
   - kreopoly_settle_position
   - kreopoly_list_categories

## Step 7 — Test with natural language

Try these prompts (Claude will pick the right tool automatically):

```
You:   List the available Polymarket categories.

You:   Add this wallet to my watchlist: 0x9e1f5fCE0a83ec92A93b22BcA9f5aE4F4a9b0a33
       Label it "Whale #1".

You:   What are my tracked wallets?

You:   Set up a copy task from 0x9e1f5fCE0a83ec92A93b22BcA9f5aE4F4a9b0a33:
       - Fixed $20 per mirror trade
       - Follow buys
       - Daily cap $100
       - Stop loss 0.4, take profit 0.85
       - Market entry

You:   Any new copy signals?

You:   Show me my Polymarket positions, sorted by expiry.
```

## Troubleshooting

**Plugin doesn't appear in the tools list:**
- Check Claude Desktop's developer logs:
  - Mac: `~/Library/Logs/Claude/mcp*.log`
  - Windows: `%APPDATA%\Claude\logs\mcp*.log`
- Common issues:
  - Wrong absolute path in `args`
  - `dist/index.js` doesn't exist (forgot to run `npm run build`)
  - Node not on PATH (use full path: `/usr/local/bin/node` on Mac, `C:\\Program Files\\nodejs\\node.exe` on Windows)

**"Invalid arguments" error when calling a tool:**
- The agent passed bad args — this is normal Zod validation. Tell Claude what went wrong and it'll retry.

**Polygonscan rate limit (429):**
- Get a free API key and put it in the env config
- Free tier: 5 calls/sec, 100k/day — plenty for testing

**Need to test the signing flow (place_bet, settle_position):**
- These need a real PayBox wallet connected — install PayBox Desktop
- See https://support.moonpay.com/en/articles/824491-paybox-desktop-install-and-connect-your-ai-agent
- Without PayBox, all 6 read-only and config tools still work

# ChatGPT — MCP Client Setup

## How ChatGPT connects to MCP servers

Unlike Claude Desktop (which spawns plugins as local child processes via stdio), **ChatGPT only supports remote MCP servers over HTTP**. So you need to:

1. Run your plugin's HTTP transport (`node dist/http.js`)
2. Expose it publicly via a tunnel (ngrok) or deploy it (Render, Railway, Fly.io)
3. Add the URL as a Custom MCP Server in ChatGPT

## Step 1 — Get your plugin running over HTTP

```bash
cd /path/to/paybox-kreopoly-lens
npm install
npm run build

# Start the HTTP server
node dist/http.js --port=3000
# Or via env: PORT=3000 node dist/http.js
```

You should see:
```
[paybox-kreopoly-lens] MCP HTTP server ready.
  Health:  http://localhost:3000/
  MCP:     http://localhost:3000/mcp
  Tools:   kreopoly_get_positions, ...
  CORS:    *
```

Test the health check in another terminal:
```bash
curl http://localhost:3000/
# Should return JSON with "ok": true and a list of tools
```

## Step 2 — Expose it publicly with ngrok

ChatGPT's servers can't reach `localhost:3000` — you need a public URL.

### Install ngrok
- Mac: `brew install ngrok`
- Windows: download from https://ngrok.com/download
- Or via npm: `npm install -g ngrok`

### Sign up + authenticate (free)
1. Create a free account at https://ngrok.com
2. Get your auth token: https://dashboard.ngrok.com/get-started/your-authtoken
3. Configure: `ngrok config add-authtoken YOUR_TOKEN`

### Start the tunnel
```bash
ngrok http 3000
```

You'll see output like:
```
Session Status                online
Forwarding                    https://abc123.ngrok.app -> http://localhost:3000
```

Copy the `https://abc123.ngrok.app` URL — this is your public MCP endpoint.

**The full MCP URL you'll give to ChatGPT is:** `https://abc123.ngrok.app/mcp`

⚠️ **Keep ngrok running** in its own terminal window. If you close it, the tunnel dies and ChatGPT can't reach your plugin.

## Step 3 — Enable Developer Mode in ChatGPT

As of late 2025, ChatGPT's full MCP support (including write tools, which you need for `place_bet`) is gated behind Developer Mode.

1. Go to https://chatgpt.com
2. Click your profile picture → **Settings**
3. **Security and login** → enable **Developer mode**
4. Confirm

## Step 4 — Add your plugin as a Custom MCP Server

1. In ChatGPT, click the **+** next to the chat input
2. Choose **Plugins** (or "Connectors" — naming varies)
3. Click **Add custom MCP server** (the **+** icon at top right of the plugins directory)
4. Fill in:
   - **Name:** `Kreopoly Lens`
   - **Server URL:** `https://abc123.ngrok.app/mcp` (your ngrok URL + `/mcp`)
   - **Authentication:** `No Auth`
5. Click **Create** / **Save**

## Step 5 — Activate the plugin in a chat

1. Start a new chat
2. Click the **+** icon next to the input
3. Search for "Kreopoly Lens" and toggle it **ON**
4. You'll see a splash screen confirming the tools are available

## Step 6 — Test with natural language

```
You:   List the available Polymarket categories.

You:   Add this wallet to my watchlist: 0x9e1f5fCE0a83ec92A93b22BcA9f5aE4F4a9b0a33
       Label it "Whale #1".

You:   Set up a copy task from 0x9e1f...a33c:
       - Fixed $20 per mirror trade
       - Follow buys
       - Daily cap $100
       - Stop loss 0.4, take profit 0.85
       - Market entry

You:   Any new copy signals?

You:   Show me my Polymarket positions, sorted by profit.
```

## Alternative: deploy to Render instead of ngrok

Ngrok tunnels die when you close your laptop. For a permanent deployment (recommended for the hackathon demo video):

### Option A — Render (free tier works)

1. Push your plugin to GitHub (see README.md)
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `node dist/http.js`
   - **Environment variables:**
     - `POLYGON_RPC_URL` = `https://polygon-rpc.com`
     - `POLYGONSCAN_API_KEY` = your key
     - `PORT` = `3000` (Render sets this automatically — leave blank if Render provides it)
5. Deploy

Render gives you a URL like `https://paybox-kreopoly-lens.onrender.com`. Use `https://paybox-kreopoly-lens.onrender.com/mcp` as your ChatGPT MCP server URL.

### Option B — Railway / Fly.io

Same pattern. Both have free tiers that work for hackathon demos.

## Troubleshooting

**"Connection refused" or HTTP 000 from ChatGPT:**
- Your local plugin isn't running, OR
- ngrok tunnel died (restart it), OR
- Wrong URL in ChatGPT (must end with `/mcp`, not just `/`)

**Tools list is empty in ChatGPT:**
- Make sure the plugin is running (`curl https://your-url/mcp -X POST -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'`)
- Check the plugin's console for errors

**Tool call returns "No valid session":**
- ChatGPT must send `initialize` first — happens automatically on plugin activation
- Restart the plugin and re-add it in ChatGPT

**"424 unhandled errors" (known ChatGPT quirk):**
- ChatGPT sometimes chokes on complex structured tool responses
- The plugin already returns both `text` (JSON string) and `structuredContent` — should work, but if it fails, simplify the response in the tool handler

**ChatGPT can't reach your local plugin:**
- ChatGPT runs in your browser but the MCP call goes through OpenAI's servers
- You MUST use a public URL (ngrok or Render), not localhost

**ngrok URL changed after restart:**
- Free ngrok gives you a new random URL each time
- Either: re-add it in ChatGPT every time, OR
- Upgrade to ngrok personal ($8/mo) for a stable subdomain, OR
- Deploy to Render for a permanent URL

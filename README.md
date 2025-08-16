# cg-alpha-mcp

An MCP server that connects **Elfa** (crypto news & twitter sentiment data) and works alongside the **CoinGecko MCP**.
Includes a tiny **TA module** (RSI + Bollinger Bands) to quickly inform users of token performance in various timeframes.
Ideally used with CoinGecko feature *top gainers/losers*, which can be called directly from the LLM with CoinGecko Pro.
Users can also connect the Nansen MCP for additional context in their token alpha searches.

---

## Features

- **ELFA integrations**
  - `/v2/aggregations/trending-tokens`
  - `/v2/data/token-news`
  - `/v2/data/keyword-mentions`
- **Generic ELFA proxy**: call any ELFA path with `elfa_query`
- **Auth from `.env`** (no key pasting into the chat)
- **TA utilities**: RSI (Wilder) and Bollinger Bands (SMA + population stdev)
- Designed to run with any MCP client (Claude Desktop, Cursor, etc. - n.b. designed with Claude desktop)

## Prompt and responses
![Claude response example](promts_responses_images/example.png)
--------------------

## Quick Start

### 1) Requirements
- **Node.js 20+** (works on 22 as well)
- A modern MCP client (e.g., **Claude Desktop** or **Cursor**)

### 2) Install
```bash
git clone https://github.com/<you>/cg-alpha-mcp.git
cd cg-alpha-mcp
npm install   # installs dependencies (node_modules is ignored in Git)
```

### 3) Configure environment
`cp .env.example .env`
- Edit `.env` and set `ELFA_API_KEY` (and `COINGECKO_API_KEY` if you use the CoinGecko MCP with a key)
- Keep `.env` private — it’s already in `.gitignore`.

### 4) Hook into your MCP client
Most MCP clients let you add a custom server command. Use:
- Command: `node`
- Args: `C:/Users/YOUR-FILE-NAME/cg-alpha-mcp/mcp-server.js` (or `./mcp-server.js` on macOS/Linux)
- Working directory: the repo root
On Windows, paths often look like:
```C:\Users\YOUR-FILE-NAME\cg-alpha-mcp\mcp-server.js```

### 5) Once added, your client should show tools like:
- `elfa_status`
- `elfa_reload_env`
- `elfa_trending / elfa_trending_tokens`
- `elfa_token_news`
- `elfa_keyword_mentions`
- `elfa_query`

### 6) Environment Variables
See `.env.example` for all options.
- ELFA_API_KEY (required for ELFA calls)
- Get from ELFA (https://www.elfa.ai/api).
- COINGECKO_API_KEY - add to Claude config file.

Advanced (optional):
- `ELFA_HEADER`: header name for auth (defaults to `x-elfa-api-key`)
- `ELFA_AUTH_TYPE`: set to `x-elfa-api-key` (default) or bearer
- `ELFA_BASE: ELFA` base URL (defaults to `https://api.elfa.ai`)

### 7) Claude config file - structure at bottom of README

### 8) (Optional) - Nansen paid users can download .dxt file to install
- Either drag and drop into Extensions or
- Extensions > Advanced Setting > Install Extension > Choose `.dxt` file > Enter your API key
--------------------

### 9) Troubleshooting:
401 “API key is required”
- Check `.env` has `ELFA_API_KEY=...`
- Run `elfa_reload_env` (no restart needed)
- Verify header style: ELFA expects `x-elfa-api-key` (the server auto-tries both)

404 “Cannot GET …/data/trending”
- Use `/v2/aggregations/trending-tokens` (the server’s `elfa_trending` already points here)
- `.env` in the right place?
- Put `.env` in the same folder as `mcp-server.js` (repo root)

Windows path issues
- Use absolute paths in the MCP client if needed, e.g.
```C:\Users\YOUR-FILE-NAME\cg-alpha-mcp\mcp-server.js```

Security
- `.env` is ignored by git.
- Include a public, safe `.env.example` so others can configure their own keys.

--------------------

## Useful Tools & What They Do
- elfa_status - Shows current base URL and masked auth status.
- elfa_reload_env - Reloads .env at runtime (no restart). Use this after editing the `.env`.
- elfa_set_auth - Manually sets the API key and header style if needed:
```{ "key": "sk-...", "headerName": "x-elfa-api-key", "scheme": "" }```
- elfa_trending / elfa_trending_tokens - Wrapper around /v2/aggregations/trending-tokens:
```{ "timeframe": "24h", "limit": 10, "chain": "all" }```
- elfa_token_news - Token news:
```{ "symbols": "BTC,ETH", "limit": 20, "start": "2025-08-01", "end": "2025-08-16" }```
- elfa_keyword_mentions - Multi-keyword mentions:
```{ "keywords": ["bitcoin","halving"], "limit": 50 }```
- elfa_query - Generic ELFA proxy for any path:
```{ "path": "/v2/aggregations/trending-tokens", "method": "GET", "query": { "timeframe": "24h", "limit": 10 } }```

### Technical Analysis (TA)
We provide a tiny pure JS TA module in `services/ta.js`:
- `rsi(values, period=14)` → last RSI value (0–100)
- `bollinger(values, period=20, mult=2)` → `{ mean, upper, lower, last, percentB, bandwidth }`
Inputs are arrays of numeric closes in order oldest → newest.
Your MCP orchestration fetches price series (e.g., via CoinGecko MCP) and then calls TA.

### Intended Prompt Workflow:
"Show me the top 15 trending tokens on coingecko via their mcp, and the top 10 trending tokens on Elfa."
(- Nansen users can ask for the recent smart money flows and activity.)
"Show me the top 10 gainers and top 10 losers over the past 7 days in USD (specify timeframe: 24hours, 7days, 30days, specify token range: top 1000 or all tokens)."
(- Goingecko Pro API users can call this from the MCP. Demo API users can ask Claude to determine this manually - *tokens with 24hr volume over 50k.)

### User Chooses Specific Coins/Tokens of Interest from above lists:
"For (selected coins/tokens), show me the token news from Elfa AI, the trends in mentions and mentions delta from Elfa, and give me the RSI and Bollinger Bands for each."
(- Nansen users can also ask for smart money data/comparison for these tokens - who is buying (selected coins/tokens)?)

### Other prompts:
Built-in timeframe (fast):
"Show me the top 10 gainers and top 10 losers over the past 7 days in USD, and give me the RSI and Bollinger Bands for each."
Custom timeframe (computed):
"Find the best and worst performing coins over the past 12 hours, limited to the top 200 by market cap. Add RSI and Bollinger Bands."
Specific coins/tokens:
"For BTC, ETH, and SOL, calculate the percentage change over the last 72 hours and display RSI(14) and Bollinger Bands(20,2)."
Multi-window snapshot:
"Create a snapshot: "top 5 gainers and losers for 24h, 7d, and 30d, with RSI and Bollinger for each result."
Latest Trending Tokens (ELFA)
"Show me the top trending tokens from ELFA."
RSI Calculation
"Fetch Bitcoin's last 50 closing prices from CoinGecko and calculate RSI."
Bollinger Bands
"Get ETH’s last 30 days of prices and calculate Bollinger Bands."
Gainers & Losers
"Find the top 5 gainers and losers in the last 24h and calculate their RSI."

--------------------

## Claude config file structure:
```
{
  "mcpServers": {
    "cg-alpha-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/cg-alpha-mcp/mcp-server.js"
      ]
    },
    "coingecko_mcp_local": {
      "command": "npx",
      "args": [
        "-y",
        "@coingecko/coingecko-mcp"
      ],
      "env": {
        "COINGECKO_DEMO_API_KEY": "YOUR_DEMO_KEY",
        "COINGECKO_ENVIRONMENT": "demo"
      }
    }
  }
}
```

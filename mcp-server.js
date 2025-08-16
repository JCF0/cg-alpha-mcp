// mcp-server.js — ELFA MCP server + TA tools (RSI, Bollinger)
// Valid tool names: ^[a-zA-Z0-9_-]{1,64}$
// Tools: elfa_set_auth, elfa_set_base, elfa_reload_env, elfa_status,
//        elfa_query, elfa_trending (-> aggregations/trending-tokens),
//        elfa_trending_tokens, elfa_token_news, elfa_keyword_mentions,
//        ta_rsi, ta_bollinger, ta_summary

// ----- STDERR logging only (STDOUT reserved for JSON-RPC) -----
{ const toErr = (...args) => {
    const line = args.map(a => typeof a === "string" ? a : (()=>{try{return JSON.stringify(a)}catch{return String(a)}})()).join(" ") + "\n";
    process.stderr.write(line);
  };
  console.log = toErr; console.info = toErr; console.warn = toErr; console.error = toErr;
}
process.on("unhandledRejection", e => console.error("[unhandledRejection]", e && (e.stack || e)));
process.on("uncaughtException",  e => console.error("[uncaughtException]",  e && (e.stack || e)));

const JSONRPC_VERSION = "2.0";

// ----- ESM-friendly path utils -----
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// TA: RSI & Bollinger (pure math, no I/O)
import { rsi as taRSI, bollinger as taBoll } from "./services/ta.js";

// ----- dotenv loader (multi-path, debuggable) -----
import dotenv from "dotenv";
let ENV_INFO = { loaded: false, from: [], vars: [] };

function loadEnvMulti() {
  ENV_INFO = { loaded: false, from: [], vars: [] };
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = path.dirname(__filename);
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(__dirname, ".env"),
    path.join(path.dirname(__dirname), ".env"),       // one level up
    path.join(path.dirname(path.dirname(__dirname)), ".env") // two up
  ];
  const seen = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    if (seen.has(p)) continue; seen.add(p);
    if (fs.existsSync(p)) {
      dotenv.config({ path: p, override: false });
      ENV_INFO.loaded = true;
      ENV_INFO.from.push(p);
    }
  }
  // Capture which ELFA_* we actually have
  const known = ["ELFA_API_KEY","ELFA_HEADER","ELFA_AUTH_TYPE","ELFA_BASE"];
  for (let i = 0; i < known.length; i++) {
    if (process.env[known[i]] !== undefined) ENV_INFO.vars.push(known[i]);
  }
  console.info(`[dotenv] loaded=${ENV_INFO.loaded} from=${JSON.stringify(ENV_INFO.from)} vars=${JSON.stringify(ENV_INFO.vars)}`);
}
loadEnvMulti();

// ----- Runtime config (mutable) -----
let ELFA_BASE = (process.env.ELFA_BASE || "https://api.elfa.ai").replace(/\/+$/,"");

// Always prefer x-elfa-api-key for ELFA unless explicitly set to Authorization
function buildAuthFromEnv() {
  const envKey = process.env.ELFA_API_KEY || "";
  let header = (process.env.ELFA_HEADER || "x-elfa-api-key").toLowerCase(); // default to x-elfa-api-key
  if (header !== "x-elfa-api-key" && header !== "authorization") {
    header = "x-elfa-api-key";
  }
  if (header === "authorization") {
    return { headerName: "Authorization", scheme: "Bearer", key: envKey };
  }
  return { headerName: "x-elfa-api-key", scheme: "", key: envKey };
}
let ELFA_AUTH = buildAuthFromEnv();

// ----- Helpers -----
function jrpcResult(id, result){ return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result }); }
function jrpcError(id, code, message, data){ return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error: { code, message, data } }); }
function textContent(payload){ return [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }]; }
function progressNotify(token, progress, total, message){
  if (!token) return;
  process.stdout.write(JSON.stringify({ jsonrpc: JSONRPC_VERSION, method: "notifications/progress",
    params: { progressToken: token, progress, total, message } }) + "\n");
}
function maskKey(k){ if(!k) return ""; const s=String(k); return s.length<=8 ? "*".repeat(Math.max(0,s.length-2))+s.slice(-2) : s.slice(0,4)+"…"+s.slice(-4); }

function applyAuth(headers){
  const h = ELFA_AUTH || {};
  if (!h.key) return headers;
  const name = (h.headerName || "x-elfa-api-key");
  headers[name] = h.scheme ? `${h.scheme} ${h.key}` : h.key; // empty scheme for ELFA
  return headers;
}

// ----- ELFA fetch (single attempt; ELFA expects x-elfa-api-key) -----
async function elfaFetch(pathname, options){
  const o = options || {};
  const method = (o.method || "GET").toUpperCase();
  const query = o.query || null;
  const body  = o.body  || null;

  const url = new URL(pathname, ELFA_BASE);
  if (query && typeof query === "object") {
    for (const k of Object.keys(query)) {
      const v = query[k];
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers = { "Accept": "application/json" };
  applyAuth(headers);
  if (body && method !== "GET") headers["Content-Type"] = "application/json";

  const res = await fetch(url, { method, headers, body: body && method !== "GET" ? JSON.stringify(body) : undefined });
  const raw = await res.text();
  let data; try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
  return { ok: res.ok, status: res.status, data };
}

// ----- Tool handlers -----
const toolHandlers = {
  // Admin: set auth
  "elfa_set_auth": async (args) => {
    const key = args && args.key;
    const headerName = args && args.headerName;
    const scheme = args && args.scheme;
    if (!key || typeof key !== "string") return { content: textContent({ ok:false, message:"Missing 'key' (string)" }), isError:true };
    if (headerName && typeof headerName === "string") ELFA_AUTH.headerName = headerName;
    if (scheme !== undefined && typeof scheme === "string") ELFA_AUTH.scheme = scheme;
    ELFA_AUTH.key = key;
    return { content: textContent({ ok:true, headerName: ELFA_AUTH.headerName || "", scheme: ELFA_AUTH.scheme || "", key: maskKey(ELFA_AUTH.key) }) };
  },

  // Admin: set base URL
  "elfa_set_base": async (args) => {
    const base = args && args.base;
    try { const u = new URL(base); ELFA_BASE = u.toString().replace(/\/+$/,""); return { content: textContent({ ok:true, base: ELFA_BASE }) }; }
    catch { return { content: textContent({ ok:false, message:"Invalid URL for 'base'" }), isError:true }; }
  },

  // Admin: reload .env (no restart)
  "elfa_reload_env": async () => {
    loadEnvMulti();
    ELFA_AUTH = buildAuthFromEnv();
    ELFA_BASE = (process.env.ELFA_BASE || ELFA_BASE).replace(/\/+$/,"");
    return { content: textContent({
      ok: true,
      base: ELFA_BASE,
      loaded: ENV_INFO.loaded,
      from: ENV_INFO.from,
      vars: ENV_INFO.vars,
      auth: { headerName: ELFA_AUTH.headerName || "", scheme: ELFA_AUTH.scheme || "", key: maskKey(ELFA_AUTH.key) }
    }) };
  },

  // Admin: status
  "elfa_status": async () => {
    return { content: textContent({
      base: ELFA_BASE,
      loaded: ENV_INFO.loaded,
      from: ENV_INFO.from,
      vars: ENV_INFO.vars,
      auth: { headerName: ELFA_AUTH.headerName || "", scheme: ELFA_AUTH.scheme || "", key: maskKey(ELFA_AUTH.key) }
    }) };
  },

  // Generic proxy
  "elfa_query": async (args, meta) => {
    const path = args && args.path;
    if (!path || typeof path !== "string") return { content: textContent({ error:true, message:"Missing required 'path' (string)" }), isError:true };
    const method = (args.method || "GET").toUpperCase();
    const query  = args.query || undefined;
    const body   = args.body  || undefined;
    progressNotify(meta && meta.progressToken, 1, 3, "Calling ELFA");
    const { ok, status, data } = await elfaFetch(path, { method, query, body });
    progressNotify(meta && meta.progressToken, 2, 3, "Formatting result");
    if (!ok) return { content: textContent({ error:true, status, data }), isError:true, _meta:{ status } };
    progressNotify(meta && meta.progressToken, 3, 3, "Done");
    return { content: textContent({ ok:true, status, data }) };
  },

  // /v2/aggregations/trending-tokens  (this replaces the old /v2/data/trending)
  "elfa_trending": async (args, meta) => {
    return toolHandlers["elfa_trending_tokens"](args, meta);
  },

  "elfa_trending_tokens": async (args, meta) => {
    const query = {};
    if (args && args.timeframe !== undefined) query.timeframe = args.timeframe; // "24h","7d","30d"
    if (args && args.chain     !== undefined) query.chain     = args.chain;
    if (args && args.limit     !== undefined) query.limit     = args.limit;
    if (args && args.cursor    !== undefined) query.cursor    = args.cursor;
    return toolHandlers["elfa_query"]({ path: "/v2/aggregations/trending-tokens", method: "GET", query }, meta);
  },

  // /v2/data/token-news
  "elfa_token_news": async (args, meta) => {
    const query = {};
    if (args && args.symbols !== undefined) query.symbols = args.symbols; // "ETH,BTC"
    if (args && args.chain   !== undefined) query.chain   = args.chain;
    if (args && args.start   !== undefined) query.start   = args.start;
    if (args && args.end     !== undefined) query.end     = args.end;
    if (args && args.limit   !== undefined) query.limit   = args.limit;
    if (args && args.cursor  !== undefined) query.cursor  = args.cursor;
    if (args && args.sources !== undefined) query.sources = args.sources;
    return toolHandlers["elfa_query"]({ path: "/v2/data/token-news", method: "GET", query }, meta);
  },

  // /v2/data/keyword-mentions
  "elfa_keyword_mentions": async (args, meta) => {
    const query = {};
    if (args && args.keywords !== undefined) query.keywords = Array.isArray(args.keywords) ? args.keywords.join(",") : String(args.keywords);
    if (args && args.start   !== undefined) query.start   = args.start;
    if (args && args.end     !== undefined) query.end     = args.end;
    if (args && args.chain   !== undefined) query.chain   = args.chain;
    if (args && args.limit   !== undefined) query.limit   = args.limit;
    if (args && args.cursor  !== undefined) query.cursor  = args.cursor;
    if (args && args.sources !== undefined) query.sources = args.sources;
    return toolHandlers["elfa_query"]({ path: "/v2/data/keyword-mentions", method: "GET", query }, meta);
  },

  // ----- TA tools -----

  // Compute RSI on an array of closes (oldest → newest)
  "ta_rsi": async (args) => {
    const values = Array.isArray(args?.values) ? args.values : null;
    const period = Number.isFinite(Number(args?.period)) ? Number(args.period) : 14;
    if (!values || values.length === 0) {
      return { content: textContent({ error:true, message:"'values' must be a non-empty array of numbers (oldest → newest)" }), isError:true };
    }
    const out = taRSI(values, period);
    return { content: textContent({ ok:true, rsi: out, period }) };
  },

  // Compute Bollinger Bands on an array of closes (oldest → newest)
  "ta_bollinger": async (args) => {
    const values = Array.isArray(args?.values) ? args.values : null;
    const period = Number.isFinite(Number(args?.period)) ? Number(args.period) : 20;
    const mult   = Number.isFinite(Number(args?.mult))   ? Number(args.mult)   : 2;
    if (!values || values.length === 0) {
      return { content: textContent({ error:true, message:"'values' must be a non-empty array of numbers (oldest → newest)" }), isError:true };
    }
    const out = taBoll(values, period, mult);
    return { content: textContent({ ok:true, ...out, period, mult }) };
  },

  // Convenience: return both indicators in one call
  "ta_summary": async (args) => {
    const values = Array.isArray(args?.values) ? args.values : null;
    const rsiPeriod = Number.isFinite(Number(args?.rsiPeriod)) ? Number(args.rsiPeriod) : 14;
    const bbPeriod  = Number.isFinite(Number(args?.bbPeriod))  ? Number(args.bbPeriod)  : 20;
    const bbMult    = Number.isFinite(Number(args?.bbMult))    ? Number(args.bbMult)    : 2;
    if (!values || values.length === 0) {
      return { content: textContent({ error:true, message:"'values' must be a non-empty array of numbers (oldest → newest)" }), isError:true };
    }
    const rsiVal = taRSI(values, rsiPeriod);
    const bbVal  = taBoll(values, bbPeriod, bbMult);
    return { content: textContent({ ok:true, rsi: rsiVal, bollinger: bbVal, rsiPeriod, bbPeriod, bbMult }) };
  }
};

// ----- Tool definitions -----
const tools = [
  { name:"elfa_set_auth",
    description:"Set ELFA API auth. Params: key (string), headerName (Authorization|x-elfa-api-key), scheme (e.g., Bearer).",
    inputSchema:{ type:"object", properties:{ key:{type:"string"}, headerName:{type:"string"}, scheme:{type:"string"} }, required:["key"] },
    annotations:{ title:"ELFA: Set Auth", readOnlyHint:false, openWorldHint:false }
  },
  { name:"elfa_set_base",
    description:"Set ELFA base URL (e.g., https://api.elfa.ai).",
    inputSchema:{ type:"object", properties:{ base:{type:"string"} }, required:["base"] },
    annotations:{ title:"ELFA: Set Base URL", readOnlyHint:false, openWorldHint:false }
  },
  { name:"elfa_reload_env",
    description:"Reload .env files from common locations.",
    inputSchema:{ type:"object", properties:{} },
    annotations:{ title:"ELFA: Reload .env", readOnlyHint:false, openWorldHint:false }
  },
  { name:"elfa_status",
    description:"Show current ELFA config (key masked) and .env load info.",
    inputSchema:{ type:"object", properties:{} },
    annotations:{ title:"ELFA: Status", readOnlyHint:true, openWorldHint:false }
  },
  { name:"elfa_query",
    description:"Generic ELFA proxy. Call any ELFA path with method/query/body. Returns JSON.",
    inputSchema:{ type:"object", properties:{
      path:{type:"string", description:"ELFA path like /v2/..."},
      method:{type:"string", description:"HTTP method"},
      query:{type:"object", description:"Query params map"},
      body:{type:"object", description:"JSON body for non-GET"}
    }, required:["path"] },
    annotations:{ title:"ELFA: Generic Query", readOnlyHint:true, openWorldHint:true }
  },
  { name:"elfa_trending",
    description:"Alias to /v2/aggregations/trending-tokens (timeframe, chain, limit, cursor).",
    inputSchema:{ type:"object", properties:{
      timeframe:{type:"string"}, chain:{type:"string"}, limit:{type:"number"}, cursor:{type:"string"}
    }},
    annotations:{ title:"ELFA: Trending (Alias)", readOnlyHint:true, openWorldHint:true }
  },
  { name:"elfa_trending_tokens",
    description:"Trending tokens aggregation. Params: timeframe, chain, limit, cursor.",
    inputSchema:{ type:"object", properties:{
      timeframe:{type:"string"}, chain:{type:"string"}, limit:{type:"number"}, cursor:{type:"string"}
    }},
    annotations:{ title:"ELFA: Trending Tokens", readOnlyHint:true, openWorldHint:true }
  },
  { name:"elfa_token_news",
    description:"Token news. Params: symbols (comma), chain, start, end, limit, cursor, sources.",
    inputSchema:{ type:"object", properties:{
      symbols:{type:"string"}, chain:{type:"string"}, start:{type:"string"}, end:{type:"string"},
      limit:{type:"number"}, cursor:{type:"string"}, sources:{type:"string"}
    }},
    annotations:{ title:"ELFA: Token News", readOnlyHint:true, openWorldHint:true }
  },
  { name:"elfa_keyword_mentions",
    description:"Multi-keyword mentions. Params: keywords (array|string), start, end, chain, limit, cursor, sources.",
    inputSchema:{ type:"object", properties:{
      keywords:{type:"array", items:{type:"string"}}, start:{type:"string"}, end:{type:"string"},
      chain:{type:"string"}, limit:{type:"number"}, cursor:{type:"string"}, sources:{type:"string"}
    }},
    annotations:{ title:"ELFA: Keyword Mentions", readOnlyHint:true, openWorldHint:true }
  },

  // TA definitions
  { name:"ta_rsi",
    description:"Compute RSI (Wilder). Inputs: values:number[] (oldest→newest), period?:number(14). Returns latest RSI.",
    inputSchema:{ type:"object", properties:{
      values:{ type:"array", items:{ type:"number" } },
      period:{ type:"number" }
    }, required:["values"] },
    annotations:{ title:"TA: RSI", readOnlyHint:true, openWorldHint:false }
  },
  { name:"ta_bollinger",
    description:"Compute Bollinger Bands (SMA + population stdev). Inputs: values:number[] (oldest→newest), period?:number(20), mult?:number(2).",
    inputSchema:{ type:"object", properties:{
      values:{ type:"array", items:{ type:"number" } },
      period:{ type:"number" },
      mult:{ type:"number" }
    }, required:["values"] },
    annotations:{ title:"TA: Bollinger Bands", readOnlyHint:true, openWorldHint:false }
  },
  { name:"ta_summary",
    description:"Return both RSI and Bollinger in one call. Inputs: values:number[] (oldest→newest), rsiPeriod?:number(14), bbPeriod?:number(20), bbMult?:number(2).",
    inputSchema:{ type:"object", properties:{
      values:{ type:"array", items:{ type:"number" } },
      rsiPeriod:{ type:"number" },
      bbPeriod:{ type:"number" },
      bbMult:{ type:"number" }
    }, required:["values"] },
    annotations:{ title:"TA: Summary", readOnlyHint:true, openWorldHint:false }
  }
];

// ----- JSON-RPC router -----
async function handleRequest(msg){
  const id = msg && msg.id, method = msg && msg.method, params = msg && msg.params;
  if (id === undefined) { // notifications -> no response
    if (method === "notifications/initialized") console.info("[notice] client initialized");
    else if (method === "notifications/cancelled") console.info("[notice] client cancelled", params && params.requestId);
    return null;
  }
  if (method === "ping") return jrpcResult(id, {});
  if (method === "initialize") {
    const clientVer = params && params.protocolVersion;
    return jrpcResult(id, {
      protocolVersion: clientVer || "2025-03-26",
      capabilities: { logging:{}, prompts:{listChanged:false}, resources:{subscribe:false, listChanged:false}, tools:{listChanged:false} },
      serverInfo: { name:"elfa-mcp-server", version:"1.5.0" },
      instructions: "Use elfa_* for ELFA data (requires x-elfa-api-key). Use ta_* to compute RSI/Bollinger on price arrays."
    });
  }
  if (method === "resources/list")           return jrpcResult(id, { resources: [] });
  if (method === "resources/templates/list") return jrpcResult(id, { resourceTemplates: [] });
  if (method === "resources/read")           return jrpcResult(id, { contents: [] });
  if (method === "prompts/list")             return jrpcResult(id, { prompts: [] });
  if (method === "prompts/get")              return jrpcResult(id, { description:"Prompt not available", messages: [] });
  if (method === "tools/list")               return jrpcResult(id, { tools });
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const meta = (params && params._meta) || {};
    const fn = name && toolHandlers[name];
    if (!fn) return jrpcError(id, -32601, "Tool not found", { name });
    try {
      const res = await fn(args, meta);
      return jrpcResult(id, { content: (res && res.content) || textContent({ ok:true }), isError: !!(res && res.isError), _meta: res && res._meta ? res._meta : undefined });
    } catch (e) {
      return jrpcResult(id, { content: textContent({ error:true, message: (e && e.message) || String(e) }), isError: true });
    }
  }
  if (method === "logging/setLevel")         return jrpcResult(id, {});
  if (method === "completion/complete")      return jrpcResult(id, { completion: { values: [], total: 0, hasMore: false } });
  return jrpcError(id, -32601, "Method not found", { method });
}

// ----- Line-delimited JSON over stdio -----
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) { nl = buf.indexOf("\n"); continue; }
    let msg; try { msg = JSON.parse(line); } catch { console.error("[parse error] dropped non-JSON line from host"); nl = buf.indexOf("\n"); continue; }
    try {
      if (Array.isArray(msg)) {
        for (let i = 0; i < msg.length; i++) { const r = await handleRequest(msg[i]); if (r) process.stdout.write(r + "\n"); }
      } else {
        const reply = await handleRequest(msg); if (reply) process.stdout.write(reply + "\n");
      }
    } catch (e) {
      const rid = msg && msg.id;
      if (typeof rid === "string" || typeof rid === "number") process.stdout.write(jrpcError(rid, -32603, "Internal error", { message: (e && e.message) || String(e) }) + "\n");
      else console.error("[internal error]", e && (e.stack || e));
    }
    nl = buf.indexOf("\n");
  }
});

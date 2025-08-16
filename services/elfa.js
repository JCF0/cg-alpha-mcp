// services/elfa.js — ELFA v2 client (data + aggregations)
import axios from 'axios';

const ELFA_BASE = (process.env.ELFA_BASE || 'https://api.elfa.ai').replace(/\/+$/, '');
const ELFA_KEY  = (process.env.ELFA_API_KEY ?? process.env.ELFA_KEY ?? '').trim();

export const elfa = axios.create({
  baseURL: ELFA_BASE,
  timeout: 30_000,
  headers: {
    Accept: 'application/json',
    'User-Agent': 'cg-alpha-mcp/1.0',         // harmless, helps some gateways
    ...(ELFA_KEY ? { 'x-elfa-api-key': ELFA_KEY } : {})
  }
});

elfa.interceptors.request.use((cfg) => {
  cfg.headers = cfg.headers || {};
  cfg.headers['Accept'] = 'application/json';
  cfg.headers['User-Agent'] = cfg.headers['User-Agent'] || 'cg-alpha-mcp/1.0';
  if (ELFA_KEY) cfg.headers['x-elfa-api-key'] = ELFA_KEY;
  return cfg;
});

const safeGet = async (path, params) => {
  try {
    const r = await elfa.get(path, { params });
    return r.data;
  } catch (e) {
    const status = e?.response?.status;
    const data   = e?.response?.data;
    const msg    = data?.error || data?.message || e?.message || 'request failed';
    console.warn(`[ELFA] ${status || '?'} ${path}`, { params, msg });
    return { ok: false, status: status || 500, error: msg, sent: { path, params } };
  }
};

// ✅ Include timeWindow so aggregations does not 400
export const elfaKeyStatus = async () => {
  if (!ELFA_KEY) return { ok:false, status:401, error:'Missing ELFA_API_KEY' };
  // cheap ping to a real v2 endpoint (use an always-available, lightweight call)
  const ping = await safeGet('/v2/aggregations/trending-tokens', { page: 1, pageSize: 1, timeWindow: '24h' });
  if (ping?.ok === false) return ping;
  return { ok:true, base: ELFA_BASE, keyLen: ELFA_KEY.length };
};

export const elfaTrendingTokens = async ({ timeWindow='7d', page=1, pageSize=50, minMentions=5, from=null, to=null }) => {
  const params = { page, pageSize, minMentions };
  if (from != null && to != null) { params.from = from; params.to = to; }
  else { params.timeWindow = timeWindow; }
  return safeGet('/v2/aggregations/trending-tokens', params);
};

export const elfaTokenNews = async (opts) => {
  const { coinIds, page = 1, pageSize = 20, reposts = false } = opts;
  const params = { coinIds, page, pageSize, reposts };
  if ('from' in opts && 'to' in opts && opts.from != null && opts.to != null) {
    params.from = opts.from; params.to = opts.to;
  } else {
    params.timeWindow = opts.timeWindow || '7d';
  }
  return safeGet('/v2/data/token-news', params);
};

export const elfaKeywordMentions = async (opts) => {
  const {
    keywords,
    accountName,
    timeWindow = '7d',
    limit = 20,
    searchType = 'or',
    cursor = null,
    reposts = false
  } = opts;

  const params = { limit, searchType, reposts };
  if (keywords) params.keywords = keywords;
  if (accountName) params.accountName = accountName;

  if ('from' in opts && 'to' in opts && opts.from != null && opts.to != null) {
    params.from = opts.from; params.to = opts.to;
  } else {
    params.timeWindow = timeWindow;
  }
  if (cursor) params.cursor = cursor;

  return safeGet('/v2/data/keyword-mentions', params);
};

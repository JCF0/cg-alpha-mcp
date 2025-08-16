// index.js — Lean HTTP health + ELFA v2 debug endpoints (centralised via services/elfa.js)

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env that sits next to this file (works even if cwd is different)
loadEnv({ path: resolve(__dirname, '.env') });

import express from 'express';
import { elfaKeyStatus } from './services/elfa.js';

import {
  elfaTrendingTokens,
  elfaTokenNews,
  elfaKeywordMentions
} from './services/elfa.js';

const app = express();
app.use(express.json());

// ───────── Health
const ELFA_BASE = (process.env.ELFA_BASE || 'https://api.elfa.ai').replace(/\/+$/, '');
const ELFA_KEY = (process.env.ELFA_API_KEY ?? process.env.ELFA_KEY ?? '').trim();

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'cg-alpha-mcp',
    elfaBase: ELFA_BASE,
    hasKey: !!ELFA_KEY,
  });
});

// ───────── ELFA debug: trending tokens (uses wrapper)
app.get('/debug/elfa/trending', async (req, res) => {
  try {
    const data = await elfaTrendingTokens({
      timeWindow: String(req.query.timeWindow || '7d'),
      page: Number(req.query.page || 1),
      pageSize: Math.min(Number(req.query.pageSize || 50), 100),
      minMentions: Number(req.query.minMentions || 5),
      from: req.query.from ? Number(req.query.from) : null,
      to: req.query.to ? Number(req.query.to) : null
    });
    res.json(data ?? { ok: false, error: 'debug trending failed' });
  } catch (e) {
    console.error('debug/trending error', e);
    res.status(500).json({ ok: false, error: e?.message || 'debug trending exception' });
  }
});

// ───────── ELFA debug: token news (uses wrapper)
app.get('/debug/elfa/token-news', async (req, res) => {
  try {
    const coinIds = String(req.query.coinIds || '');
    const page = Number(req.query.page || 1);
    const pageSize = Math.min(Number(req.query.pageSize || 20), 100);
    const reposts = String(req.query.reposts || 'false') === 'true';

    const data = await elfaTokenNews(
      req.query.from && req.query.to
        ? {
            coinIds,
            page,
            pageSize,
            reposts,
            from: Number(req.query.from),
            to: Number(req.query.to)
          }
        : {
            coinIds,
            page,
            pageSize,
            reposts,
            timeWindow: String(req.query.timeWindow || '30d')
          }
    );
    res.json(data ?? { ok: false, error: 'debug token-news failed' });
  } catch (e) {
    console.error('debug/token-news error', e);
    res.status(500).json({ ok: false, error: e?.message || 'debug token-news exception' });
  }
});

// ───────── ELFA debug: keyword mentions (uses wrapper)
app.get('/debug/elfa/keyword-mentions', async (req, res) => {
  try {
    const keywords = req.query.keywords ? String(req.query.keywords) : undefined;
    const accountName = req.query.accountName ? String(req.query.accountName) : undefined;
    if (!keywords && !accountName) {
      return res.status(400).json({ ok: false, error: 'Provide keywords or accountName' });
    }

    const base = {
      limit: Math.min(Number(req.query.limit || 20), 30),
      searchType: String(req.query.searchType || 'or'),
      cursor: req.query.cursor ? String(req.query.cursor) : null,
      reposts: String(req.query.reposts || 'false') === 'true'
    };

    const windowParams =
      req.query.from && req.query.to
        ? { from: Number(req.query.from), to: Number(req.query.to) }
        : { timeWindow: String(req.query.timeWindow || '30d') };

    const data = await elfaKeywordMentions({
      keywords,
      accountName,
      ...base,
      ...windowParams
    });

    res.json(data ?? { ok: false, error: 'debug keyword-mentions failed' });
  } catch (e) {
    console.error('debug/keyword-mentions error', e);
    res.status(500).json({ ok: false, error: e?.message || 'debug keyword-mentions exception' });
  }
});

app.get('/debug/elfa/key', async (_req, res) => {
  const data = await elfaKeyStatus();
  res.json(data ?? { ok: false, error: 'key status failed' });
});

// ───────── Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.error(`cg-alpha-mcp (health+debug) on http://127.0.0.1:${PORT}`);
});

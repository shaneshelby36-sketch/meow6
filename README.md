'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { CandleSeries, fetchHistoricalRange } = require('./candles');
const { OrderBook } = require('./orderBook');
const { CoinbaseFeed } = require('./coinbaseFeed');
const { buildPredictions } = require('./prediction');
const { PredictionTracker } = require('./tracker');
const { KalshiClient } = require('./kalshiClient');
const { TradingBot } = require('./bot');
const { backtestSymbol } = require('./backtest');

const tracker = new PredictionTracker();

// ---------- Kalshi bot setup ----------
// SAFETY: two separate switches must both be set for real orders to ever be
// placed. Missing either one (or misconfigured credentials) means the bot
// runs in paper mode against live Kalshi prices — no real money moves.
const KALSHI_ENABLED = (process.env.KALSHI_ENABLED || 'false').toLowerCase() === 'true';
const LIVE_TRADING_REQUESTED = (process.env.KALSHI_LIVE_TRADING || 'false').toLowerCase() === 'true';
const LIVE_TRADING_CONFIRMED = process.env.KALSHI_LIVE_TRADING_CONFIRM === 'I_UNDERSTAND_THE_RISK';

const kalshiClient = new KalshiClient({
  baseUrl: process.env.KALSHI_BASE_URL,
  keyId: process.env.KALSHI_API_KEY_ID,
  privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
});

const wantsLive = LIVE_TRADING_REQUESTED && LIVE_TRADING_CONFIRMED && kalshiClient.hasCredentials;
if (LIVE_TRADING_REQUESTED && !wantsLive) {
  console.warn(
    '[bot] KALSHI_LIVE_TRADING=true but live trading is NOT active — ' +
      'requires KALSHI_LIVE_TRADING_CONFIRM=I_UNDERSTAND_THE_RISK and valid API credentials. Running in paper mode.'
  );
}

const bot = KALSHI_ENABLED
  ? new TradingBot({
      kalshiClient,
      config: {
        symbol: (process.env.KALSHI_SYMBOL || 'BTC').toUpperCase(),
        edgeThresholdPct: parseFloat(process.env.KALSHI_EDGE_THRESHOLD_PCT || '8'),
        minConfidence: parseFloat(process.env.KALSHI_MIN_CONFIDENCE || '55'),
        stopLossCents: parseInt(process.env.KALSHI_STOP_LOSS_CENTS || '35', 10),
        contractsPerTrade: parseInt(process.env.KALSHI_CONTRACTS_PER_TRADE || '1', 10),
        maxOpenPositions: parseInt(process.env.KALSHI_MAX_OPEN_POSITIONS || '1', 10),
        skimMode: process.env.KALSHI_SKIM_MODE || 'fixed',
        skimFixedCents: parseInt(process.env.KALSHI_SKIM_FIXED_CENTS || '500', 10),
        skimPercent: parseFloat(process.env.KALSHI_SKIM_PERCENT || '20'),
        mode: wantsLive ? 'live' : 'paper',
      },
    })
  : null;

if (KALSHI_ENABLED) {
  console.log(`[bot] Kalshi bot enabled in ${wantsLive ? 'LIVE' : 'paper'} mode, trading ${(process.env.KALSHI_SYMBOL || 'BTC').toUpperCase()}`);
}

const PORT = parseInt(process.env.PORT || '4000', 10);
const PRODUCTS = (process.env.PRODUCTS || 'BTC-USD,XRP-USD').split(',').map((s) => s.trim());
const COMPUTE_INTERVAL_MS = parseInt(process.env.COMPUTE_INTERVAL_MS || '5000', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const SYMBOL_OF = { 'BTC-USD': 'BTC', 'XRP-USD': 'XRP' };

const state = {}; // e.g. state.BTC = { productId, series, book, lastTradeAt }
for (const productId of PRODUCTS) {
  const symbol = SYMBOL_OF[productId] || productId;
  state[symbol] = {
    productId,
    series: new CandleSeries(productId),
    book: new OrderBook(productId),
    lastTradeAt: null,
    feedStatus: 'connecting',
  };
}

let latestPrediction = { ready: false, message: 'Seeding historical data, please wait…' };
let lastComputeError = null;

async function seedAll() {
  await Promise.all(Object.values(state).map((s) => s.series.seed()));
}

function wireFeed() {
  const feed = new CoinbaseFeed(PRODUCTS);

  feed.on('connected', () => {
    console.log('[feed] connected to Coinbase WebSocket');
    for (const s of Object.values(state)) s.feedStatus = 'live';
  });

  feed.on('disconnected', () => {
    console.warn('[feed] disconnected — will retry with backoff');
    for (const s of Object.values(state)) s.feedStatus = 'reconnecting';
  });

  feed.on('error', (err) => {
    console.error('[feed] error:', err.message);
  });

  feed.on('trade', (trade) => {
    const symbol = SYMBOL_OF[trade.productId] || trade.productId;
    const s = state[symbol];
    if (!s) return;
    s.series.addTrade(trade.price, trade.size, trade.time);
    s.lastTradeAt = trade.time;
  });

  feed.on('l2snapshot', (snap) => {
    const symbol = SYMBOL_OF[snap.productId] || snap.productId;
    const s = state[symbol];
    if (!s) return;
    s.book.loadSnapshot(snap.bids, snap.asks);
  });

  feed.on('l2update', (upd) => {
    const symbol = SYMBOL_OF[upd.productId] || upd.productId;
    const s = state[symbol];
    if (!s) return;
    for (const [side, price, size] of upd.changes) {
      s.book.applyChange(side, price, size);
    }
  });

  feed.connect();
  return feed;
}

function recompute() {
  try {
    const input = {};
    for (const [symbol, s] of Object.entries(state)) {
      input[symbol] = { series: s.series, book: s.book };
    }
    const result = buildPredictions(input);
    result.feedStatus = Object.fromEntries(
      Object.entries(state).map(([sym, s]) => [sym, s.feedStatus])
    );

    // Feed each ready window through the tracker so predictions resolve
    // over time (countdown + settled over/under), like an expiring market.
    const now = Date.now();
    for (const [symbol, assetResult] of Object.entries(result)) {
      if (!assetResult || !assetResult.ready || !assetResult.windows) continue;
      for (const [windowKey, w] of Object.entries(assetResult.windows)) {
        const trackerOutput = tracker.update(symbol, windowKey, {
          currentPrice: assetResult.price,
          predictedDirection: w.probabilityUp >= 50 ? 'UP' : 'DOWN',
          predictedPrice: w.predictedPrice,
          minutes: w.minutes,
          now,
        });
        w.tracking = trackerOutput.tracking;
        w.lastResult = trackerOutput.lastResult;
        w.accuracy = trackerOutput.accuracy;
        w.history = trackerOutput.history;
      }
    }

    latestPrediction = result;
    lastComputeError = null;

    if (bot) {
      bot.runCycle(result).catch((err) => {
        console.error('[bot] cycle error:', err.message);
      });
    }
  } catch (err) {
    lastComputeError = err.message;
    console.error('[predict] compute failed:', err);
  }
}

async function main() {
  console.log('[startup] seeding historical candles from Coinbase REST API…');
  await seedAll();
  for (const [symbol, s] of Object.entries(state)) {
    console.log(`[startup] ${symbol}: seeded ${s.series.candles.length} candles`);
  }

  wireFeed();

  // First compute as soon as we have enough seeded history; then on an interval.
  recompute();
  setInterval(recompute, COMPUTE_INTERVAL_MS);

  const app = express();
  app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
  app.use(express.json());

  app.get('/api/latest', (req, res) => {
    res.json(latestPrediction);
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      lastComputeError,
      feedStatus: Object.fromEntries(Object.entries(state).map(([sym, s]) => [sym, s.feedStatus])),
      candleCounts: Object.fromEntries(Object.entries(state).map(([sym, s]) => [sym, s.series.candles.length])),
      computeIntervalMs: COMPUTE_INTERVAL_MS,
      botEnabled: !!bot,
      time: new Date().toISOString(),
    });
  });

  app.get('/api/bot/status', (req, res) => {
    if (!bot) {
      res.json({ enabled: false, message: 'Set KALSHI_ENABLED=true to turn on the trading bot (paper mode by default).' });
      return;
    }
    res.json({ enabled: true, ...bot.status() });
  });

  app.get('/api/bot/config', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    res.json({ config: bot.config });
  });

  app.post('/api/bot/config', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const result = bot.updateConfig(req.body || {});
    res.json(result);
  });

  const SYMBOL_TO_PRODUCT = { BTC: 'BTC-USD', XRP: 'XRP-USD' };
  const MAX_BACKTEST_HOURS = 72;

  app.get('/api/backtest', async (req, res) => {
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    let hours = parseFloat(req.query.hours || '24');
    if (!SYMBOL_TO_PRODUCT[symbol]) {
      res.status(400).json({ error: `Unknown symbol '${symbol}'. Use BTC or XRP.` });
      return;
    }
    if (!hours || hours <= 0) hours = 24;
    if (hours > MAX_BACKTEST_HOURS) hours = MAX_BACKTEST_HOURS;

    try {
      console.log(`[backtest] fetching ${hours}h of ${symbol} history…`);
      const candles = await fetchHistoricalRange(SYMBOL_TO_PRODUCT[symbol], hours);
      console.log(`[backtest] running walk-forward backtest over ${candles.length} candles…`);
      const results = backtestSymbol(candles, { stepMinutes: 1 });
      res.json({
        symbol,
        hoursRequested: hours,
        candleCount: candles.length,
        note: 'Order book imbalance/spread/liquidity signals are not included — no historical order-book data exists to replay them.',
        windows: results,
      });
    } catch (err) {
      console.error('[backtest] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`[startup] prediction engine API listening on http://0.0.0.0:${PORT}`);
    console.log(`[startup] dashboard should poll GET /api/latest every ${COMPUTE_INTERVAL_MS / 1000}-${(COMPUTE_INTERVAL_MS / 1000) * 2}s`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

'use strict';

const { gatherIndicators, directionalScore, WINDOWS } = require('./prediction');

const LOOKBACK_MIN = 210; // matches the EMA200 + buffer requirement in gatherIndicators

/**
 * Walk-forward backtest: for each historical minute (once enough lookback
 * history exists), computes the same directional score used live, then
 * checks what BTC/XRP actually did `minutes` later to see if the call was
 * right. This reuses prediction.js's real scoring functions — it is not a
 * separate re-implementation — so backtest results reflect the same logic
 * that runs live.
 *
 * IMPORTANT LIMITATION: order book imbalance, spread, and liquidity signals
 * cannot be backtested — Coinbase doesn't provide historical order-book
 * snapshots, only historical trade candles. Those signals are simply absent
 * here (passed as null, same as gatherIndicators does when no live book is
 * available), so backtest accuracy reflects only the indicator/trend/
 * momentum/pattern portion of the model, not the full live signal set.
 *
 * candles: full historical OHLCV array, oldest -> newest, 1-minute bars.
 * stepMinutes: how many minutes to advance between each simulated
 * prediction (1 = check every minute, slower but thorough; higher values
 * sample less densely and run faster).
 */
function backtestSymbol(candles, { stepMinutes = 1 } = {}) {
  const perWindow = {};
  for (const w of WINDOWS) {
    perWindow[w.key] = { label: w.label, minutes: w.minutes, correct: 0, total: 0 };
  }

  const maxHorizon = Math.max(...WINDOWS.map((w) => w.minutes));
  const lastUsableIndex = candles.length - maxHorizon - 1;

  for (let i = LOOKBACK_MIN; i <= lastUsableIndex; i += stepMinutes) {
    const historySlice = candles.slice(0, i + 1); // only data available "at the time"
    const series = {
      candles: historySlice,
      closes: () => historySlice.map((c) => c.close),
      volumes: () => historySlice.map((c) => c.volume),
      latestClose: () => historySlice[historySlice.length - 1].close,
      ready: (n) => historySlice.length >= n,
    };

    const ind = gatherIndicators(series, null); // null book: no historical order-book data exists
    if (!ind) continue;

    const currentPrice = candles[i].close;

    for (const w of WINDOWS) {
      const { score } = directionalScore(ind, w.key);
      const predictedUp = score > 0;
      const futureIndex = i + w.minutes;
      if (futureIndex >= candles.length) continue;
      const actualUp = candles[futureIndex].close >= currentPrice;

      perWindow[w.key].total += 1;
      if (predictedUp === actualUp) perWindow[w.key].correct += 1;
    }
  }

  const summary = {};
  for (const key of Object.keys(perWindow)) {
    const { label, minutes, correct, total } = perWindow[key];
    summary[key] = {
      window: label,
      minutes,
      sampleSize: total,
      correctCount: correct,
      accuracyPct: total ? +((correct / total) * 100).toFixed(1) : null,
    };
  }
  return summary;
}

module.exports = { backtestSymbol, LOOKBACK_MIN };

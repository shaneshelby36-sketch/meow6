'use strict';

const MAX_HISTORY = 40;

/**
 * For each (symbol, window) pair, keeps one "pending" prediction — the price
 * at the moment it was made, its predicted direction, and when it resolves —
 * plus a rolling history of settled outcomes. This mirrors how a Kalshi-style
 * market works: a prediction is made against a reference price, and some
 * time later it settles as over/under that same reference, win or lose.
 *
 * A new pending prediction is only opened once the previous one for that
 * same (symbol, window) has settled, so each window behaves like a
 * continuously-renewing market rather than re-baselining every 5 seconds.
 */
class PredictionTracker {
  constructor() {
    this.slots = new Map(); // key `${symbol}:${windowKey}` -> { pending, history: [] }
  }

  _slot(symbol, windowKey) {
    const key = `${symbol}:${windowKey}`;
    if (!this.slots.has(key)) {
      this.slots.set(key, { pending: null, history: [] });
    }
    return this.slots.get(key);
  }

  /**
   * Call once per compute cycle for each (symbol, window).
   * currentPrice: the live price right now
   * predictedDirection: 'UP' | 'DOWN' from this cycle's fresh prediction
   * predictedPrice: this cycle's fresh target price
   * minutes: window length in minutes
   * now: Date.now()
   *
   * Returns { tracking, history, accuracy } to attach to the API response.
   */
  update(symbol, windowKey, { currentPrice, predictedDirection, predictedPrice, minutes, now }) {
    const slot = this._slot(symbol, windowKey);

    // Resolve a pending prediction whose window has elapsed.
    if (slot.pending && now >= slot.pending.targetTime) {
      const actualPrice = currentPrice;
      const actualDirection = actualPrice >= slot.pending.baselinePrice ? 'UP' : 'DOWN';
      const correct = actualDirection === slot.pending.predictedDirection;
      const changePct =
        ((actualPrice - slot.pending.baselinePrice) / slot.pending.baselinePrice) * 100;

      slot.history.unshift({
        madeAt: slot.pending.madeAt,
        resolvedAt: now,
        windowMinutes: minutes,
        baselinePrice: slot.pending.baselinePrice,
        predictedDirection: slot.pending.predictedDirection,
        predictedPrice: slot.pending.predictedPrice,
        actualPrice,
        actualDirection,
        changePct: +changePct.toFixed(4),
        correct,
      });
      if (slot.history.length > MAX_HISTORY) slot.history.length = MAX_HISTORY;
      slot.pending = null;
    }

    // Open a new pending prediction if none is active.
    if (!slot.pending) {
      slot.pending = {
        madeAt: now,
        targetTime: now + minutes * 60 * 1000,
        baselinePrice: currentPrice,
        predictedDirection,
        predictedPrice,
      };
    }

    const secondsRemaining = Math.max(0, Math.round((slot.pending.targetTime - now) / 1000));
    const resolvedCount = slot.history.length;
    const correctCount = slot.history.filter((h) => h.correct).length;

    return {
      tracking: {
        madeAt: slot.pending.madeAt,
        targetTime: slot.pending.targetTime,
        secondsRemaining,
        baselinePrice: slot.pending.baselinePrice,
        predictedDirection: slot.pending.predictedDirection,
      },
      lastResult: slot.history[0] || null,
      accuracy: {
        sampleSize: resolvedCount,
        correctCount,
        accuracyPct: resolvedCount ? +((correctCount / resolvedCount) * 100).toFixed(1) : null,
      },
      history: slot.history.slice(0, 10),
    };
  }
}

module.exports = { PredictionTracker };

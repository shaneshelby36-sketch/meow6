'use strict';

const {
  rsi,
  macd,
  atr,
  momentum,
  volatility,
  correlation,
  trendStrength,
  volumeSpike,
  candlePattern,
} = require('./indicators');

const WINDOWS = [
  { key: 'w5', label: '0-5 min', minutes: 5 },
  { key: 'w10', label: '5-10 min', minutes: 10 },
  { key: 'w15', label: '10-15 min', minutes: 15 },
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Logistic squash: turns an unbounded score into a 0..1 probability
function logistic(x, k = 2.2) {
  return 1 / (1 + Math.exp(-k * x));
}

/**
 * Gathers every raw indicator reading for one product's candle/orderbook state.
 * Returns null if there isn't enough history yet to compute reliably.
 */
function gatherIndicators(series, book) {
  if (!series.ready(210)) return null;
  const closes = series.closes();
  const volumes = series.volumes();
  const candles = series.candles;

  const trend = trendStrength(closes);
  const rsiVal = rsi(closes, 14);
  const macdVal = macd(closes);
  const atrVal = atr(candles, 14);
  const mom3 = momentum(closes, 3);
  const mom10 = momentum(closes, 10);
  const vol = volatility(closes, 20);
  const volSpike = volumeSpike(volumes, 20);
  const pattern = candlePattern(candles);
  const price = series.latestClose();

  const imbalance = book && book.ready ? book.imbalance(0.5) : null;
  const spread = book && book.ready ? book.spread() : null;
  const liquidity = book && book.ready ? book.liquidity(0.5) : null;

  if (!trend || rsiVal == null || !macdVal || atrVal == null) return null;

  return {
    price,
    trend,
    rsi: rsiVal,
    macd: macdVal,
    atr: atrVal,
    atrPct: (atrVal / price) * 100,
    momentumShort: mom3,
    momentumLong: mom10,
    volatility: vol,
    volumeSpike: volSpike,
    pattern,
    imbalance,
    spread,
    liquidity,
  };
}

// Per-window weight profiles: how much each signal contributes to the
// composite directional score. Short windows lean on order-flow/momentum;
// long windows lean on trend/oscillators.
const WEIGHT_PROFILES = {
  w5: { trend: 0.6, slope: 0.5, rsi: 0.6, macd: 0.5, momentum: 1.3, pattern: 0.9, imbalance: 1.6 },
  w10: { trend: 1.0, slope: 0.8, rsi: 0.8, macd: 1.0, momentum: 1.0, pattern: 0.5, imbalance: 1.0 },
  w15: { trend: 1.5, slope: 1.2, rsi: 0.9, macd: 1.2, momentum: 0.7, pattern: 0.25, imbalance: 0.5 },
};

function directionalScore(ind, windowKey) {
  const w = WEIGHT_PROFILES[windowKey];
  let score = 0;
  const contributions = [];

  // Trend alignment (-2..2 -> -1..1)
  const alignmentNorm = ind.trend.alignment / 2;
  score += alignmentNorm * w.trend;
  if (Math.abs(alignmentNorm) > 0.4) {
    contributions.push({
      text:
        alignmentNorm > 0
          ? 'EMA20/50/200 stacked bullish'
          : 'EMA20/50/200 stacked bearish',
      weight: Math.abs(alignmentNorm * w.trend),
    });
  }

  // EMA50 slope
  const slopeNorm = clamp(ind.trend.slope / 0.5, -1, 1); // 0.5% slope over 10 candles ~ full scale
  score += slopeNorm * w.slope;

  // RSI: centered momentum-direction signal, tempered by overbought/oversold
  const rsiNorm = clamp((ind.rsi - 50) / 25, -1, 1);
  score += rsiNorm * w.rsi;
  if (ind.rsi >= 70) contributions.push({ text: `RSI ${ind.rsi.toFixed(0)} (overbought)`, weight: 0.5 });
  if (ind.rsi <= 30) contributions.push({ text: `RSI ${ind.rsi.toFixed(0)} (oversold)`, weight: 0.5 });

  // MACD histogram + acceleration
  const histNorm = clamp(ind.macd.histogram / (ind.price * 0.0015), -1, 1);
  score += histNorm * w.macd;
  const accelerating =
    ind.macd.prevHistogram != null &&
    Math.sign(ind.macd.histogram) === Math.sign(ind.macd.histogram - ind.macd.prevHistogram) &&
    ind.macd.histogram !== 0;
  if (Math.abs(histNorm) > 0.3) {
    contributions.push({
      text: `MACD histogram ${histNorm > 0 ? 'positive' : 'negative'}${accelerating ? ' and widening' : ''}`,
      weight: Math.abs(histNorm * w.macd),
    });
  }

  // Momentum (short lookback weighted more for w5)
  const momBlend =
    (ind.momentumShort ?? 0) * 0.6 + (ind.momentumLong ?? 0) * 0.4;
  const momNorm = clamp(momBlend / 0.4, -1, 1);
  score += momNorm * w.momentum;
  if (Math.abs(momNorm) > 0.35) {
    contributions.push({
      text: `Price momentum ${momBlend > 0 ? 'up' : 'down'} ${Math.abs(momBlend).toFixed(2)}% recently`,
      weight: Math.abs(momNorm * w.momentum),
    });
  }

  // Candle pattern lean
  score += ind.pattern.lean * w.pattern;
  if (Math.abs(ind.pattern.lean) >= 0.4) {
    contributions.push({ text: `Recent candles show ${ind.pattern.label}`, weight: Math.abs(ind.pattern.lean * w.pattern) });
  }

  // Order book imbalance
  if (ind.imbalance) {
    score += ind.imbalance.ratio * w.imbalance;
    if (Math.abs(ind.imbalance.ratio) > 0.15) {
      contributions.push({
        text: `Order book ${ind.imbalance.ratio > 0 ? 'buy' : 'sell'}-side pressure (${(Math.abs(ind.imbalance.ratio) * 100).toFixed(0)}% skew)`,
        weight: Math.abs(ind.imbalance.ratio * w.imbalance),
      });
    }
  }

  return { score, contributions };
}

// Confidence starts high and is docked for anything that makes the
// prediction less trustworthy, per the spec's explicit list of conditions.
function computeConfidence(ind, contributions, crossCorrelation, agreementWithOther) {
  let confidence = 78;
  const notes = [];
  let riskPoints = 0;

  const dock = (points, note) => {
    confidence -= points;
    riskPoints += points;
    notes.push(note);
  };

  // Rising volatility
  if (ind.volatility != null) {
    if (ind.volatility > 0.35) dock(14, `Elevated volatility (${ind.volatility.toFixed(2)}%)`);
    else if (ind.volatility > 0.2) dock(7, `Moderate volatility (${ind.volatility.toFixed(2)}%)`);
  }

  // Weakening momentum: histogram shrinking toward zero or momentum near zero
  if (ind.macd.prevHistogram != null) {
    const weakening =
      Math.abs(ind.macd.histogram) < Math.abs(ind.macd.prevHistogram) &&
      Math.sign(ind.macd.histogram) === Math.sign(ind.macd.prevHistogram);
    if (weakening) dock(6, 'MACD momentum weakening');
  }
  if (ind.momentumShort != null && Math.abs(ind.momentumShort) < 0.03) {
    dock(5, 'Very little short-term price movement');
  }

  // Large sell (or buy) pressure that conflicts with the trend direction
  if (ind.imbalance) {
    const trendSign = Math.sign(ind.trend.alignment) || Math.sign(ind.momentumLong ?? 0);
    const flowSign = Math.sign(ind.imbalance.ratio);
    if (trendSign !== 0 && flowSign !== 0 && trendSign !== flowSign && Math.abs(ind.imbalance.ratio) > 0.25) {
      dock(10, 'Order flow conflicts with prevailing trend');
    }
    if (Math.abs(ind.imbalance.ratio) > 0.6) {
      dock(6, `Heavy ${ind.imbalance.ratio < 0 ? 'sell' : 'buy'}-side pressure in the book`);
    }
  }

  // Correlation breakdown between BTC and XRP
  if (crossCorrelation != null) {
    if (Math.abs(crossCorrelation) < 0.3) {
      dock(10, `BTC/XRP correlation has broken down (${crossCorrelation.toFixed(2)})`);
    }
  }

  // Conflicting indicators: do the contributions disagree in direction?
  const positives = contributions.filter((c) => c.weight > 0 && c.text && !/bearish|sell|overbought|falling|oversold/i.test(c.text));
  const signs = contributions.map((c) => c.text);
  const posCount = signs.filter((t) => /bullish|buy|rising|oversold/i.test(t)).length;
  const negCount = signs.filter((t) => /bearish|sell|falling|overbought/i.test(t)).length;
  if (posCount > 0 && negCount > 0) {
    dock(8, 'Indicators are giving conflicting signals');
  }

  // Wide spread / thin liquidity
  if (ind.spread && ind.spread.percent > 0.05) {
    dock(5, `Wider than normal bid/ask spread (${ind.spread.percent.toFixed(3)}%)`);
  }

  // Agreement with the other asset's directional lean nudges confidence up
  if (agreementWithOther != null && crossCorrelation != null && Math.abs(crossCorrelation) >= 0.3) {
    if (agreementWithOther) {
      confidence += 4;
      notes.push('Confirms direction with correlated asset');
    } else {
      dock(6, 'Diverges from usually-correlated asset');
    }
  }

  confidence = clamp(confidence, 8, 95);
  return { confidence, notes, riskPoints: clamp(riskPoints, 0, 100) };
}

function recommend(pUp, confidence) {
  if (confidence < 32) return 'Wait';
  if (pUp >= 0.66 && confidence >= 55) return 'Strong Buy';
  if (pUp >= 0.55) return 'Buy';
  if (pUp <= 0.34 && confidence >= 55) return 'Strong Sell';
  if (pUp <= 0.45) return 'Sell';
  return 'Wait';
}

function buildWindowPrediction(windowDef, ind, otherInd, crossCorrelation) {
  const { score, contributions } = directionalScore(ind, windowDef.key);

  let otherAgrees = null;
  if (otherInd) {
    const { score: otherScore } = directionalScore(otherInd, windowDef.key);
    otherAgrees = Math.sign(score) === Math.sign(otherScore);
  }

  const { confidence, notes, riskPoints } = computeConfidence(ind, contributions, crossCorrelation, otherAgrees);

  const pUp = logistic(score);
  const pDown = 1 - pUp;

  // Expected move magnitude scales with ATR (volatility proxy) and horizon length,
  // discounted by confidence so low-trust predictions stay conservative.
  const horizonFactor = windowDef.minutes / 15;
  const expectedMovePct =
    (ind.atrPct / 100) * (0.4 + horizonFactor * 0.8) * (score) * (confidence / 100);
  const predictedPrice = ind.price * (1 + expectedMovePct);

  const topReasons = contributions
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((c) => c.text);
  const riskNotes = notes.slice(0, 3);

  return {
    window: windowDef.label,
    minutes: windowDef.minutes,
    probabilityUp: +(pUp * 100).toFixed(1),
    probabilityDown: +(pDown * 100).toFixed(1),
    predictedPrice: +predictedPrice.toFixed(ind.price > 100 ? 2 : 4),
    confidence: +confidence.toFixed(0),
    riskAdjustmentPct: +riskPoints.toFixed(0),
    recommendation: recommend(pUp, confidence),
    explanation: topReasons.length
      ? `${topReasons.join('; ')}.${riskNotes.length ? ' Risk factors: ' + riskNotes.join('; ') + '.' : ''}`
      : 'No strong signals either direction; indicators are roughly neutral.',
  };
}

/**
 * Top-level entry point. `data` = { BTC: {series, book}, XRP: {series, book} }
 * Returns null (per product) until enough candle history has been seeded.
 */
function buildPredictions(data) {
  const indicators = {};
  for (const symbol of Object.keys(data)) {
    indicators[symbol] = gatherIndicators(data[symbol].series, data[symbol].book);
  }

  const closesBySymbol = {};
  for (const symbol of Object.keys(data)) {
    closesBySymbol[symbol] = data[symbol].series.closes();
  }
  const symbols = Object.keys(data);
  let crossCorrelation = null;
  if (symbols.length === 2 && indicators[symbols[0]] && indicators[symbols[1]]) {
    crossCorrelation = correlation(closesBySymbol[symbols[0]], closesBySymbol[symbols[1]], 30);
  }

  const result = {};
  for (const symbol of symbols) {
    const ind = indicators[symbol];
    if (!ind) {
      result[symbol] = { ready: false, price: data[symbol].series.latestClose() };
      continue;
    }
    const other = symbols.find((s) => s !== symbol);
    const otherInd = other ? indicators[other] : null;

    const windows = {};
    for (const w of WINDOWS) {
      windows[w.key] = buildWindowPrediction(w, ind, otherInd, crossCorrelation);
    }

    result[symbol] = {
      ready: true,
      price: ind.price,
      indicatorsSnapshot: {
        rsi: +ind.rsi.toFixed(1),
        macdHistogram: +ind.macd.histogram.toFixed(4),
        atrPct: +ind.atrPct.toFixed(3),
        volatilityPct: ind.volatility != null ? +ind.volatility.toFixed(3) : null,
        ema20: +ind.trend.ema20.toFixed(2),
        ema50: +ind.trend.ema50.toFixed(2),
        ema200: ind.trend.ema200 != null ? +ind.trend.ema200.toFixed(2) : null,
        trendAlignment: ind.trend.alignment,
        momentumShortPct: ind.momentumShort != null ? +ind.momentumShort.toFixed(3) : null,
        volumeSpikeRatio: ind.volumeSpike ? +ind.volumeSpike.ratio.toFixed(2) : null,
        orderBookImbalance: ind.imbalance ? +ind.imbalance.ratio.toFixed(3) : null,
        spreadPct: ind.spread ? +ind.spread.percent.toFixed(4) : null,
        liquidity: ind.liquidity != null ? +ind.liquidity.toFixed(3) : null,
        candlePattern: ind.pattern.label,
      },
      windows,
    };
  }

  result.correlation = crossCorrelation != null ? +(crossCorrelation * 100).toFixed(1) : null;
  result.timestamp = new Date().toISOString();
  return result;
}

module.exports = {
  buildPredictions,
  WINDOWS,
  // Exported so the backtester can replay the *exact* same scoring logic
  // against historical candles rather than re-implementing it separately.
  gatherIndicators,
  directionalScore,
  logistic,
};

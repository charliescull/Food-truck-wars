// Market model fitted from practice data (see fit.js / model.json).
// Customers at a spot are a mix of three quality types (cheap-ok, standard-min,
// premium-only) with price limits ~ Normal(mu, sd). Each buys the best value-for-money
// truck it accepts that still has meals: value = quality_value * repFactor - price >= 0,
// ties to the cheaper truck. clear() computes sales as a fluid: offers in value order
// take proportionally from the customers who accept them, up to their meals.

const VALUES = { cheap: 8, standard: 12, premium: 16 };
const COSTS = { cheap: 2.5, standard: 3.75, premium: 5.5 };
const QRANK = { cheap: 0, standard: 1, premium: 2 };
const REP_DELTA = { cheap: -3, standard: 2, premium: 5 };
const repFactor = (rep) => 0.7 + 0.6 * rep / 100;

const SPOTS = {
  //          mean limit, spread, share accepting cheap, accepting standard
  thompson: { mu: 12.0, sd: 3.0, c: 0.46, s: 0.85 },
  union:    { mu: 12.75, sd: 3.0, c: 0.25, s: 0.80 },
  stadium:  { mu: 13.25, sd: 3.5, c: 0.32, s: 0.74 },
  highst:   { mu: 12.0, sd: 4.0, c: 0.50, s: 0.85 },
  oval:     { mu: 12.75, sd: 3.25, c: 0.34, s: 0.82 },
  northres: { mu: 11.0, sd: 2.5, c: 0.51, s: 0.90 },
};
const WEATHER = {
  oval:     { clear: 1.191, cloudy: 1.111, rain: 0.574, cold: 0.909 },
  thompson: { clear: 1.087, cloudy: 1.079, rain: 0.786, cold: 0.967 },
  union:    { clear: 1.076, cloudy: 1.051, rain: 0.827, cold: 0.966 },
  stadium:  { clear: 1.167, cloudy: 1.087, rain: 0.631, cold: 0.899 },
  highst:   { clear: 1.114, cloudy: 1.070, rain: 0.747, cold: 0.947 },
  northres: { clear: 1.093, cloudy: 1.054, rain: 0.794, cold: 0.971 },
};
const CROWD_SD = 0.13;

function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Spot parameters adjusted for tomorrow's events.
function spotParams(spot, events) {
  const p = { ...SPOTS[spot] };
  for (const e of events || []) {
    const name = (e.name || "") + " " + (e.effect || "");
    const here = e.spot === spot;
    // calibrated on practice data: game day only changes behaviour at the Stadium itself
    if (here && /game/i.test(name)) { p.mu += 0.75; p.c = Math.min(p.s, p.c + 0.15); }
    if (here && /midterm/i.test(name)) { p.s = Math.max(0.4, p.s - 0.25); p.c *= 0.57; }
    if (here && /concert/i.test(name)) p.mu += 1.0;
    if (/late/i.test(name) && (spot === "highst" || spot === "northres")) p.c = Math.min(p.s, p.c + 0.08);
  }
  return p;
}

// Customer segments: [type, limit, massShare]. type 0 accepts all, 1 standard+, 2 premium only.
const LIMIT_STEP = 0.5;
const segCache = new Map();
function segments(par) {
  const key = [par.mu, par.sd, par.c, par.s].join(",");
  if (segCache.has(key)) return segCache.get(key);
  const typeShare = [par.c, par.s - par.c, 1 - par.s];
  const segs = [];
  for (let L = 0.25; L < 31; L += LIMIT_STEP) {
    const m = phi((L + LIMIT_STEP / 2 - par.mu) / par.sd) - phi((L - LIMIT_STEP / 2 - par.mu) / par.sd);
    if (m < 1e-5) continue;
    for (let t = 0; t < 3; t++) if (typeShare[t] > 0) segs.push([t, L, m * typeShare[t]]);
  }
  segCache.set(key, segs);
  return segs;
}

// offers: [{quality, price, meals, rep}]; returns sold[] (fluid).
function clear(crowd, par, offers) {
  const segs = segments(par);
  const val = offers.map((o) => VALUES[o.quality] * repFactor(o.rep ?? 50) - o.price);
  const order = offers.map((_, i) => i).filter((i) => val[i] >= 0 && offers[i].meals > 0)
    .sort((a, b) => val[b] - val[a] || offers[a].price - offers[b].price);
  const left = segs.map((s) => s[2] * crowd);
  const sold = offers.map(() => 0);
  for (const i of order) {
    const o = offers[i], q = QRANK[o.quality];
    let want = 0;
    for (let k = 0; k < segs.length; k++) if (segs[k][0] <= q && segs[k][1] >= o.price) want += left[k];
    if (want <= 0) continue;
    const take = Math.min(o.meals, want), f = take / want;
    for (let k = 0; k < segs.length; k++) if (segs[k][0] <= q && segs[k][1] >= o.price) left[k] -= left[k] * f;
    sold[i] = take;
  }
  return sold;
}

// Expected crowd multipliers for tomorrow: weather scenarios x noise.
function scenarios(spot, weatherProbs) {
  const out = [];
  const z = [[-1.2, 0.25], [0, 0.5], [1.2, 0.25]];
  for (const [w, pw] of Object.entries(weatherProbs || { clear: 1 })) {
    if (pw <= 0) continue;
    const m = (WEATHER[spot] || {})[w] ?? 1;
    for (const [zz, pz] of z) out.push([m * (1 + zz * CROWD_SD), pw * pz]);
  }
  return out;
}

module.exports = { VALUES, COSTS, QRANK, REP_DELTA, SPOTS, WEATHER, CROWD_SD, repFactor, phi, spotParams, segments, clear, scenarios };

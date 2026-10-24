// Offline tournament: replay recorded practice markets (real weather, forecasts,
// events, crowds) scaled to N trucks, and play our strategy against rival archetypes.
//   node sim.js [markets] [field]    field e.g. "v2,premcut,stdcheap,random,v2,chaser,v2"
const fs = require("fs");
const M = require("./model.js");
const { makeStrategy } = require("./strategy.js");

const SPOTS = ["oval", "thompson", "union", "stadium", "highst", "northres"];
const RULES = { budget: 500, costs: M.COSTS, values: M.VALUES, spots: SPOTS, price_min: 1, price_max: 30 };

function loadMarkets() {
  const rows = fs.readFileSync(__dirname + "/data/obs.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  const by = {};
  for (const r of rows) {
    const m = by[r.seed] = by[r.seed] || {};
    const d = m[r.day] = m[r.day] || { weather: r.weather, events: r.events, fcWeather: r.fcWeather, fcEvents: r.fcEvents, fcExp: {}, customers: {}, base: r.nTrucksMarket };
    d.fcExp[r.spot] = r.fcExp; d.customers[r.spot] = r.customers;
  }
  return Object.entries(by).map(([seed, days]) => ({ seed, days: Object.keys(days).map(Number).sort((a, b) => a - b).map((k) => days[k]) }))
    .filter((m) => m.days.length >= 30);
}

// ---- rival archetypes (functions of the API-shaped state)
const pick = (a, r) => a[Math.floor(r() * a.length)];
const busiest = (s) => SPOTS.reduce((a, b) => (s.forecast.expected_customers[b] > s.forecast.expected_customers[a] ? b : a));
const ARCH = {
  random: (r) => (s) => ({ spot: pick(SPOTS, r), price: 10, quality: "standard", meals: 133 }),
  chaser: () => (s) => ({ spot: busiest(s), price: 10.5, quality: "standard", meals: 133 }),
  premcut: () => (s) => ({ spot: busiest(s), price: 10.5, quality: "premium", meals: 70 }),
  stdcheap: () => (s) => ({ spot: busiest(s), price: 9.5, quality: "standard", meals: 100 }),
  // moves to wherever had the most hungry customers yesterday
  hungry: () => (s) => {
    let spot = "union";
    if (s.last_day && s.last_day.spots) spot = SPOTS.reduce((a, b) => ((s.last_day.spots[b].hungry || 0) > (s.last_day.spots[a].hungry || 0) ? b : a));
    return { spot, price: 10, quality: "premium", meals: 60 };
  },
  // live-like: premium undercutter that moves to the hungriest spot / busiest
  prem11: () => (s) => ({ spot: s.last_day ? SPOTS.reduce((a, b) => ((s.last_day.spots[b].hungry || 0) > (s.last_day.spots[a].hungry || 0) ? b : a)) : busiest(s), price: 11, quality: "premium", meals: 56 }),
  std95: () => (s) => ({ spot: SPOTS.reduce((a, b) => (s.forecast.expected_customers[b] / (1 + ((s.last_day && s.last_day.spots[b].trucks.length) || 0)) > s.forecast.expected_customers[a] / (1 + ((s.last_day && s.last_day.spots[a].trucks.length) || 0)) ? b : a)), price: 9.5, quality: "standard", meals: 60 }),
  // live-like herd (night of 2026-10-23): everyone piles onto tomorrow's event, else the busiest spot
  eventprem: () => (s) => ({ spot: ((s.forecast.events || []).find((e) => e.spot) || {}).spot || busiest(s), price: 10.5, quality: "premium", meals: 90 }),
  eventcheap: () => (s) => ({ spot: ((s.forecast.events || []).find((e) => e.spot) || {}).spot || busiest(s), price: 9.75, quality: "premium", meals: 90 }),
  // goes wherever the most money was made yesterday
  winner: () => (s) => {
    let spot = busiest(s), top = 0;
    if (s.last_day && s.last_day.spots) for (const [sp, i] of Object.entries(s.last_day.spots)) for (const t of i.trucks || []) if (t.sold * t.price > top) { top = t.sold * t.price; spot = sp; }
    return { spot, price: 10.5, quality: "premium", meals: 90 };
  },
  // sticks to one spot all market
  loyal: (r) => { const sp = pick(SPOTS.filter((x) => x !== "stadium"), r); return () => ({ spot: sp, price: 11, quality: "standard", meals: 90 }); },
};

function makeBot(spec, rng) {
  if (spec.startsWith("v2") || spec.startsWith("v3")) {
    const opts = { quiet: true, v3: spec.startsWith("v3") };
    const [, params] = spec.split(":");
    if (params) for (const kv of params.split(",")) { const [k, v] = kv.split("="); opts[k] = Number(v); }
    return makeStrategy(opts).decide;
  }
  return ARCH[spec](rng);
}

function playMarket(market, specs, rng, persistent) {
  const n = specs.length, scale = Math.max(4, n) / Math.max(4, market.days[0].base);
  const trucks = specs.map((sp, i) => ({ id: "t" + i, spec: sp, cash: 0, rep: Object.fromEntries(SPOTS.map((s) => [s, 50])) }));
  const bots = specs.map((sp, i) => persistent ? persistent[i] : makeBot(sp, rng));
  let last = null;
  for (let di = 0; di < 30; di++) {
    const d = market.days[di];
    const forecast = { day: di + 1, weather: d.fcWeather, events: d.fcEvents, expected_customers: Object.fromEntries(SPOTS.map((s) => [s, Math.round(d.fcExp[s] * scale)])) };
    const pub = trucks.map((t) => ({ id: t.id, truck_name: t.spec + t.id, cash: t.cash, reputation: { ...t.rep } }));
    const orders = trucks.map((t, i) => {
      const state = { mode: "final", market: market.idx, markets: 20, day: di, days: 30, phase: "night", orders_open: true, order_for_day: di + 1,
        rules: RULES, forecast, you: { id: t.id, cash: t.cash, reputation: { ...t.rep } }, last_day: last, trucks: pub };
      try { return bots[i](state); } catch (e) { return null; }
    });
    const spots = {};
    for (const sp of SPOTS) {
      const idx = trucks.map((_, i) => i).filter((i) => orders[i] && orders[i].spot === sp);
      const offers = idx.map((i) => ({ ...orders[i], rep: trucks[i].rep[sp] }));
      const crowd = d.customers[sp] * scale;
      const sold = M.clear(crowd, M.spotParams(sp, d.events), offers).map(Math.floor);
      const totalSold = sold.reduce((a, b) => a + b, 0);
      spots[sp] = { customers: Math.round(crowd), hungry: Math.max(0, Math.round(crowd - totalSold)), trucks: idx.map((i, k) => ({ id: "t" + i, truck_name: trucks[i].spec, price: orders[i].price, quality: orders[i].quality, meals: orders[i].meals, sold: sold[k] })) };
      idx.forEach((i, k) => { trucks[i].cash += sold[k] * orders[i].price - orders[i].meals * M.COSTS[orders[i].quality]; trucks[i]._sold = sold[k]; });
    }
    for (const [i, t] of trucks.entries()) for (const sp of SPOTS) {
      if (orders[i] && orders[i].spot === sp && t._sold > 0) t.rep[sp] = Math.max(0, Math.min(100, t.rep[sp] + M.REP_DELTA[orders[i].quality]));
      else t.rep[sp] += (50 - t.rep[sp]) * 0.03;
    }
    last = { day: di + 1, weather: d.weather, events: d.events, spots, you: null };
  }
  return trucks.map((t) => t.cash);
}

function mulberry(a) { return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function tournament(field, nMarkets, seed = 1) {
  const markets = loadMarkets().slice(0, nMarkets);
  const rng = mulberry(seed);
  // strategies persist across markets like a real bot in the final
  const persistent = field.map((sp) => makeBot(sp, rng));
  const tot = field.map(() => 0);
  markets.forEach((m, k) => { m.idx = k + 1; playMarket(m, field, rng, persistent).forEach((c, i) => (tot[i] += c)); });
  return tot.map((t) => t / markets.length);
}

if (require.main === module) {
  const nM = Number(process.argv[2] || 10);
  const field = (process.argv[3] || "v2,premcut,stdcheap,random,hungry,chaser,loyal").split(",");
  const t0 = Date.now();
  const res = tournament(field, nM);
  field.forEach((f, i) => console.log(f.padEnd(26), "avg profit/market $" + res[i].toFixed(0)));
  console.log(`(${nM} markets, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
module.exports = { tournament, loadMarkets, ARCH };

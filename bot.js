// Food Truck Wars bot. Node 18+, no dependencies.
//
//   $env:NIGHTSHIFT_KEY = "fk_..."      (PowerShell)
//   node bot.js                 play the live game / the final (leave it running)
//   node bot.js --practice      play a private practice market and print profit
//   node bot.js --practice --seed rainy-week --days 30
//
// Strategy: for every spot x quality x price, estimate how many customers
// will accept us (price limit, minimum quality, value >= 0), subtract what
// rivals who beat us on value will take, then cook the newsvendor-optimal
// number of meals. Rivals are predicted from where they parked yesterday.
// Demand estimates are calibrated from what actually happened.

// Optional .env next to this file (gitignored): NIGHTSHIFT_KEY=fk_...
try {
  for (const line of require("fs").readFileSync(require("path").join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const URL = (process.env.NIGHTSHIFT_URL || "https://nightshift.joinbuilders.org").replace(/\/$/, "");
const KEY = process.env.NIGHTSHIFT_KEY || "";

// ---------------------------------------------------------------- model

const VALUES = { cheap: 8, standard: 12, premium: 16 };
const REP_DELTA = { cheap: -3, standard: 2, premium: 5 };

// What fraction of a spot's customers accept each quality, and their price limits.
// From the docs' spot table; refined online from observed sales.
const SPOT = {
  highst:   { cheapOk: 0.50, premOnly: 0.08, mean: 12.0, sd: 2.6 },
  oval:     { cheapOk: 0.30, premOnly: 0.20, mean: 13.0, sd: 1.8 },
  union:    { cheapOk: 0.20, premOnly: 0.15, mean: 13.0, sd: 1.8 },
  northres: { cheapOk: 0.45, premOnly: 0.05, mean: 11.0, sd: 1.8 },
  thompson: { cheapOk: 0.45, premOnly: 0.10, mean: 12.0, sd: 1.8 },
  stadium:  { cheapOk: 0.25, premOnly: 0.25, mean: 13.0, sd: 1.8 },
};

function phi(x) { // standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

const repFactor = (rep) => 0.7 + 0.6 * rep / 100;

// Per-market memory. Reset whenever the market changes.
let mem = null;
function memory(state) {
  const id = state.mode + ":" + state.market;
  if (!mem || mem.id !== id) mem = { id, demandAdj: {}, limitAdj: {}, lastSpot: null, history: [] };
  return mem;
}

// Fraction of customers at a spot that would buy (quality, price) if we were alone.
function acceptFrac(spot, quality, price, events) {
  const s = SPOT[spot];
  let qualOk;
  if (quality === "premium") qualOk = 1;
  else if (quality === "standard") qualOk = 1 - s.premOnly;
  else qualOk = s.cheapOk;
  let mean = s.mean + (mem.limitAdj[spot] || 0);
  let premOnly = s.premOnly;
  for (const e of events) {
    if (e.spot !== spot && !(/game/i.test(e.name))) continue;
    if (/game/i.test(e.name)) { mean += 0.5; qualOk = quality === "cheap" ? Math.min(1, qualOk + 0.15) : qualOk; }
    if (/midterm/i.test(e.name) && quality === "standard") qualOk = Math.max(0, qualOk - 0.15);
    if (/midterm/i.test(e.name) && quality === "cheap") qualOk *= 0.6;
    if (/concert/i.test(e.name)) mean += 0.7;
    if (/late/i.test(e.name) && quality === "cheap") qualOk = Math.min(1, qualOk + 0.2);
  }
  return qualOk * (1 - phi((price - mean) / s.sd));
}

// Predict rival trucks at each spot tomorrow: assume they repeat yesterday.
function predictRivals(state) {
  const me = state.you && state.you.id;
  const out = {};
  for (const sp of state.rules.spots) out[sp] = [];
  const last = state.last_day;
  if (last && last.spots) {
    for (const [sp, info] of Object.entries(last.spots)) {
      for (const t of info.trucks || []) {
        if (t.id === me) continue;
        out[sp] && out[sp].push({ price: t.price, quality: t.quality, meals: t.meals, rep: 55 });
      }
    }
  } else {
    // No history: spread the other trucks over spots by expected crowd.
    const n = Math.max(0, (state.trucks || []).length - 1);
    const exp = state.forecast.expected_customers;
    const tot = Object.values(exp).reduce((a, b) => a + b, 0) || 1;
    for (const sp of state.rules.spots) {
      const k = n * exp[sp] / tot;
      if (k > 0.05) out[sp].push({ price: 10.5, quality: "standard", meals: 133 * k, rep: 50 });
    }
  }
  return out;
}

// Expected sales for us at one spot with a given offer.
function expectedDemand(state, spot, quality, price, rivals) {
  const fc = state.forecast;
  const crowd = (fc.expected_customers[spot] || 0) * (mem.demandAdj[spot] || 1);
  const rep = (state.you.reputation && state.you.reputation[spot]) ?? 50;
  const myValue = VALUES[quality] * repFactor(rep) - price;
  if (myValue < 0) return 0;
  const mine = crowd * acceptFrac(spot, quality, price, fc.events || []);
  // Rivals with better value grab customers first (from the pool that accepts both).
  let taken = 0;
  for (const r of rivals[spot]) {
    const rv = VALUES[r.quality] * repFactor(r.rep) - r.price;
    if (rv < 0) continue;
    const better = rv > myValue + 1e-9 || (Math.abs(rv - myValue) < 1e-9 && r.price < price);
    const tie = Math.abs(rv - myValue) < 0.25 && !better;
    const theirPool = crowd * acceptFrac(spot, r.quality, r.price, fc.events || []);
    const overlap = Math.min(mine, theirPool);
    if (better) taken += Math.min(r.meals, overlap) * 0.9;
    else if (tie) taken += Math.min(r.meals, overlap) * 0.35; // noise: they're about as good
  }
  return Math.max(0, mine - taken);
}

// Expected sold given cooking `meals` against uncertain demand ~ N(mu, (0.18 mu + 8)^2).
function expectedSold(meals, mu) {
  if (mu <= 0) return 0;
  const sd = 0.18 * mu + 8;
  let tot = 0, wsum = 0;
  for (let z = -2.5; z <= 2.51; z += 0.5) {
    const w = Math.exp(-z * z / 2);
    tot += w * Math.min(meals, Math.max(0, mu + z * sd));
    wsum += w;
  }
  return tot / wsum;
}

function decide(state) {
  memory(state);
  const rules = state.rules;
  const rivals = predictRivals(state);
  const daysLeft = (state.days || 30) - (state.order_for_day || 1);
  let best = null;
  for (const spot of rules.spots) {
    for (const quality of ["cheap", "standard", "premium"]) {
      const cost = rules.costs[quality];
      const maxMeals = Math.floor(rules.budget / cost + 1e-9);
      for (let price = 5; price <= 20.001; price += 0.25) {
        const p = Math.round(price * 100) / 100;
        const mu = expectedDemand(state, spot, quality, p, rivals);
        if (mu < 1) continue;
        // newsvendor: try a few meal counts
        let bestM = null;
        for (const f of [0.6, 0.75, 0.9, 1.0, 1.1, 1.25, 1.4]) {
          const m = Math.min(maxMeals, Math.max(1, Math.round(mu * f)));
          const prof = expectedSold(m, mu) * p - m * cost;
          if (!bestM || prof > bestM.prof) bestM = { m, prof };
        }
        // Reputation is an asset: value future days at this spot a little.
        const rep = (state.you.reputation && state.you.reputation[spot]) ?? 50;
        const repGain = Math.max(-rep, Math.min(100 - rep, REP_DELTA[quality]));
        const future = Math.min(daysLeft, 8) * repGain * 0.6 * 1.2; // ~$/rep point/day, rough
        const stick = mem.lastSpot === spot ? 15 : 0;
        const score = bestM.prof + future + stick;
        if (!best || score > best.score) best = { score, spot, quality, price: p, meals: bestM.m, mu, prof: bestM.prof };
      }
    }
  }
  if (!best) best = { spot: "union", quality: "standard", price: 11, meals: 100, mu: 0, prof: 0 };
  mem.lastSpot = best.spot;
  mem.history.push({ day: state.order_for_day, ...best });
  console.log(`    plan: ${best.spot} ${best.quality} $${best.price} x${best.meals} (exp demand ${best.mu.toFixed(0)}, exp profit $${best.prof.toFixed(0)})`);
  return { spot: best.spot, price: best.price, quality: best.quality, meals: best.meals };
}

// Learn from yesterday: compare crowd vs forecast, and our sales vs prediction.
function learn(state) {
  memory(state);
  const last = state.last_day;
  if (!last || !last.spots || !mem.prevForecast || mem.prevForecast.day !== last.day) return;
  const exp = mem.prevForecast.expected_customers || {};
  for (const [sp, info] of Object.entries(last.spots)) {
    if (!exp[sp] || info.customers == null) continue;
    const ratio = info.customers / exp[sp];
    // weather noise is large; adapt slowly and clamp
    const cur = mem.demandAdj[sp] || 1;
    mem.demandAdj[sp] = Math.max(0.7, Math.min(1.3, cur * 0.85 + ratio * 0.15));
  }
  const you = last.you;
  if (you && you.spot && you.meals > 0) {
    const info = last.spots[you.spot] || {};
    const soldOut = you.sold >= you.meals;
    const hungry = info.hungry || 0;
    // Sold out with hungry people left: we could charge more there.
    if (soldOut && hungry > 10) mem.limitAdj[you.spot] = Math.min(2, (mem.limitAdj[you.spot] || 0) + 0.25);
    // Sold well under half of what we cooked: price limits are lower than we think.
    else if (you.sold < 0.5 * you.meals) mem.limitAdj[you.spot] = Math.max(-2, (mem.limitAdj[you.spot] || 0) - 0.35);
  }
}

// ---------------------------------------------------------------- plumbing

async function call(method, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 35000);
  try {
    const r = await fetch(URL + path, {
      method, signal: ctl.signal,
      headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await r.json(); } catch { data = { error: "bad json" }; }
    return [r.status, data];
  } finally { clearTimeout(timer); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function play(base) {
  let version = 0, orderedFor = null, backoff = 1000, practiceState = null;
  while (true) {
    let status, state;
    if (practiceState) { status = 200; state = practiceState; practiceState = null; }
    else {
      try { [status, state] = await call("GET", base + "/state?since=" + version); }
      catch (e) {
        console.log(`network error (${e.message}), retrying in ${backoff / 1000}s`);
        await sleep(backoff); backoff = Math.min(backoff * 2, 15000); continue;
      }
    }
    backoff = 1000;
    if (status === 429) { await sleep(2000); continue; }
    if (status !== 200) {
      console.log(`error ${status}: ${state.error}`);
      if (status === 401 || status === 404) process.exit(1);
      await sleep(3000); continue;
    }
    version = state.version;
    if (state.phase === "over" && state.mode === "practice") { report(state); return state; }
    const key = `${state.mode}|${state.market}|${state.order_for_day}`;
    if (state.phase === "night" && state.orders_open && key !== orderedFor) {
      try {
        report(state);
        let order;
        if (STRATEGY === "v1") { learn(state); order = decide(state); mem.prevForecast = state.forecast; }
        else { if (state.mode !== "practice") await addPublicReps(state); order = V2.decide(state); }
        if (SHADOW && state.mode !== "practice") {
          // decide but don't send: another bot owns the key; LIVE.md scores this against the real day
          orderedFor = key;
          console.log(`  shadow order for day ${state.order_for_day}: ${JSON.stringify(order)}`);
          try { require("fs").appendFileSync(require("path").join(__dirname, "data", "shadow.jsonl"), JSON.stringify({ mode: state.mode, market: state.market, day: state.order_for_day, order }) + "\n"); } catch {}
          continue;
        }
        const [st, res] = await call("POST", base + "/orders", order);
        if (st === 200) {
          orderedFor = key;
          console.log(`  ordered for day ${res.for_day}: ${JSON.stringify(order)}`);
          if (res.state) practiceState = res.state;
        } else {
          console.log(`  order rejected (${st}): ${res.error}`);
          await sleep(1000);
        }
      } catch (e) {
        console.log("  decide/order failed:", e && e.stack || e);
        await sleep(1000);
      }
    }
  }
}

function report(state) {
  const last = state.last_day || {};
  const mine = last.you || {};
  const where = state.mode + (state.mode === "final" ? ` market ${state.market}` : "");
  const cash = (state.you && state.you.cash || 0).toFixed(2);
  if (mine.spot) console.log(`[${where}] day ${last.day} (${last.weather}): ${mine.quality} at ${mine.spot} $${mine.price}, sold ${mine.sold}/${mine.meals}, profit $${(mine.profit || 0).toFixed(2)}, cash $${cash}`);
  else if (last.day) console.log(`[${where}] day ${last.day}: sat out, cash $${cash}`);
  else console.log(`[${where}] night before day ${state.order_for_day}, cash $${cash}`);
}

const STRATEGY = process.argv.includes("--v1") ? "v1" : process.argv.includes("--v2") ? "v2" : "v3";
const SHADOW = process.argv.includes("--shadow");
const CAMP = process.argv.includes("--camp") ? process.argv[process.argv.indexOf("--camp") + 1] : null;
const V2 = require("./strategy.js").makeStrategy({ v3: STRATEGY === "v3", camp: CAMP, persistPath: require("path").join(__dirname, "data", "rivals.json") });

// The TV's public state has every truck's reputation per spot; ours only has averages.
// Merge it in so rival offers are valued with their real reputation (1.5 s cap, optional).
async function addPublicReps(state) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(URL + "/api/v1/public/state", { signal: ctl.signal });
    const pub = await r.json();
    const reps = Object.fromEntries((pub.trucks || []).map((t) => [t.id, t.reputation]));
    for (const t of state.trucks || []) if (reps[t.id]) t.reputation = reps[t.id];
  } catch {} finally { clearTimeout(timer); }
}

async function main() {
  const args = process.argv.slice(2);
  console.log("strategy " + STRATEGY + (CAMP ? " camp " + CAMP : "") + (SHADOW ? " SHADOW (not sending orders)" : ""));
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  if (!KEY) { console.error("Set NIGHTSHIFT_KEY first (you get it when you register)."); process.exit(1); }
  if (args.includes("--practice")) {
    const body = { days: Number(opt("--days") || 30) };
    if (opt("--seed")) body.seed = opt("--seed");
    if (opt("--rivals")) body.rivals = Number(opt("--rivals"));
    const [st, res] = await call("POST", "/api/v1/practice", body);
    if (st !== 200 && st !== 201) { console.error(`could not start practice (${st}): ${res.error}`); process.exit(1); }
    console.log(`practice market ${res.id} started`);
    const fin = await play(res.base);
    console.log(`practice over: cash $${fin.you.cash.toFixed(2)}`);
    for (const t of [...fin.trucks].sort((a, b) => b.cash - a.cash)) console.log(`  ${t.truck_name.padEnd(24)} $${t.cash.toFixed(2).padStart(10)}`);
  } else {
    console.log(`playing the live game at ${URL} (Ctrl+C to stop)`);
    await play("/api/v1");
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { decide, learn, memory };

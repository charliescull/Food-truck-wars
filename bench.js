// Benchmark strategies on real practice markets with shared seeds.
//   node bench.js <nSeeds> [days] [variants...]   variants: v1, v2, v2:repVal=10,stick=20
const bot = require("./bot.js"); // loads .env, exports v1 decide/learn/memory
const { makeStrategy } = require("./strategy.js");
const URL = "https://nightshift.joinbuilders.org";
const H = { Authorization: "Bearer " + process.env.NIGHTSHIFT_KEY, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(URL + path, { method, headers: H, body: body && JSON.stringify(body) });
    if (r.status === 429) { await sleep(2000); continue; }
    return [r.status, await r.json()];
  }
  throw new Error("rate limited");
}

function makeVariant(spec) {
  if (spec === "v1") {
    const log = console.log;
    return { decide: (s) => { console.log = () => {}; bot.learn(s); const o = bot.decide(s); bot.memory(s).prevForecast = s.forecast; console.log = log; return o; } };
  }
  const opts = { quiet: true };
  const [, params] = spec.split(":");
  if (params) for (const kv of params.split(",")) { const [k, v] = kv.split("="); opts[k] = Number(v); }
  return makeStrategy(opts);
}

async function run(spec, seed, days) {
  const S = makeVariant(spec);
  const [, p] = await req("POST", "/api/v1/practice", { days, seed });
  let [, state] = await req("GET", p.base + "/state");
  while (state.phase !== "over") {
    const order = S.decide(state);
    const [st, res] = await req("POST", p.base + "/orders", order);
    if (st !== 200) throw new Error(spec + " order " + st + " " + JSON.stringify(res) + " " + JSON.stringify(order));
    state = res.state;
  }
  const others = state.trucks.filter((t) => t.id !== state.you.id).map((t) => t.cash);
  return { cash: state.you.cash, bestRival: Math.max(...others) };
}

(async () => {
  const n = Number(process.argv[2] || 5), days = Number(process.argv[3] || 30);
  const variants = process.argv.slice(4).length ? process.argv.slice(4) : ["v1", "v2"];
  const res = Object.fromEntries(variants.map((v) => [v, []]));
  for (let i = 0; i < n; i++) {
    const seed = "bench-" + i;
    for (const v of variants) res[v].push(await run(v, seed, days));
  }
  for (const v of variants) {
    const c = res[v].map((r) => r.cash), avg = c.reduce((a, b) => a + b, 0) / c.length;
    console.log(v.padEnd(28), "avg $" + avg.toFixed(0).padStart(6), " min $" + Math.min(...c).toFixed(0), " best rival avg $" + (res[v].reduce((a, r) => a + r.bestRival, 0) / n).toFixed(0));
  }
})();

// Data collection: play practice markets with random offers and log every spot's
// outcome (crowd vs forecast, every truck's offer and sales) to data/obs.jsonl.
//   node explore.js <games> [days]
require("./bot.js"); // loads .env
const fs = require("fs");
const URL = "https://nightshift.joinbuilders.org";
const H = { Authorization: "Bearer " + process.env.NIGHTSHIFT_KEY, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const RIVALS = Number(process.argv[4] || 3), ONLY = process.argv[5] ? process.argv[5].split(",") : null;

async function req(method, path, body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(URL + path, { method, headers: H, body: body && JSON.stringify(body) });
    if (r.status === 429) { await sleep(2000); continue; }
    return [r.status, await r.json()];
  }
  throw new Error("rate limited");
}

async function game(g, days) {
  const seed = "explore-" + Date.now() + "-" + g;
  const [st, p] = await req("POST", "/api/v1/practice", { days, seed, rivals: RIVALS });
  if (!p.base) throw new Error(JSON.stringify(p));
  let [, state] = await req("GET", p.base + "/state");
  const out = fs.createWriteStream("data/obs.jsonl", { flags: "a" });
  let prevHouse = {};
  while (state.phase !== "over") {
    const fc = state.forecast;
    const reps = {};
    for (const t of state.trucks) reps[t.id] = t.reputation || {};
    // explore: prefer spots no house truck used yesterday so we're often alone
    const busy = new Set(Object.values(prevHouse));
    const free = state.rules.spots.filter((s) => !busy.has(s));
    const spot = ONLY ? pick(ONLY) : Math.random() < 0.75 && free.length ? pick(free) : pick(state.rules.spots);
    const quality = pick(["cheap", "standard", "standard", "premium"]);
    const range = { cheap: [3.5, 9], standard: [6, 14.5], premium: [8, 18] }[quality];
    const price = Math.round(rnd(...range) * 4) / 4;
    const meals = Math.floor(500 / state.rules.costs[quality]);
    const [os, res] = await req("POST", p.base + "/orders", { spot, price, quality, meals });
    if (os !== 200) { console.log("order failed", os, res); break; }
    const next = res.state;
    const ld = next.last_day;
    prevHouse = {};
    for (const [sp, info] of Object.entries(ld.spots)) {
      for (const t of info.trucks) if (t.id.startsWith("h")) prevHouse[t.id] = sp;
      out.write(JSON.stringify({
        seed, day: ld.day, spot: sp, weather: ld.weather, events: ld.events,
        fcWeather: fc.weather, fcEvents: fc.events, fcCrowd: fc.crowds[sp], fcExp: fc.expected_customers[sp],
        customers: info.customers, hungry: info.hungry, nTrucksMarket: state.trucks.length,
        trucks: info.trucks.map((t) => ({ id: t.id, price: t.price, quality: t.quality, meals: t.meals, sold: t.sold, rep: (reps[t.id] || {})[sp] ?? null })),
      }) + "\n");
    }
    state = next;
  }
  out.end();
  console.log(`game ${g} done (${seed}), our cash ${state.you.cash}`);
}

(async () => {
  const games = Number(process.argv[2] || 4), days = Number(process.argv[3] || 30);
  fs.mkdirSync("data", { recursive: true });
  for (let g = 0; g < games; g++) await game(g, days);
})();

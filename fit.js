// Fit the customer model from data/obs.jsonl -> model.json
//   acceptance(spot, q, p, rep) = frac[q] * P(limit >= p) * [q_value * repFactor(rep) - p >= 0]
//   limit ~ Normal(mu, sd)
//   crowd = fcExp * weatherMult[spot][weather] / E_fc[weatherMult]   (checked both ways)
const fs = require("fs");
const rows = fs.readFileSync("data/obs.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const V = { cheap: 8, standard: 12, premium: 16 };
const rf = (r) => 0.7 + 0.6 * r / 100;
function phi(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }

// ---- weather multipliers per spot
const W = ["clear", "cloudy", "rain", "cold"];
const wm = {};
for (const r of rows) {
  if (!r.fcExp) continue;
  const k = r.spot; wm[k] = wm[k] || {}; (wm[k][r.weather] = wm[k][r.weather] || []).push(r.customers / r.fcExp);
}
const weatherMult = {};
for (const [sp, o] of Object.entries(wm)) {
  weatherMult[sp] = {};
  for (const w of W) { const v = o[w] || [1]; weatherMult[sp][w] = v.reduce((a, b) => a + b) / v.length; }
}
// does fcExp already include the forecast? compare ratio on rain days by forecast rain prob
const lo = [], hi = [];
for (const r of rows) if (r.weather === "rain" && r.fcExp) (r.fcWeather.rain > 0.5 ? hi : lo).push(r.customers / r.fcExp);
const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
console.log("rain-day ratio when forecast rain<=.5:", avg(lo).toFixed(3), lo.length, " >.5:", avg(hi).toFixed(3), hi.length);
// residual sd of crowd
let ss = 0, n = 0;
for (const r of rows) if (r.fcExp) { const e = r.customers / (r.fcExp * weatherMult[r.spot][r.weather]) - 1; ss += e * e; n++; }
console.log("crowd residual sd given true weather:", Math.sqrt(ss / n).toFixed(3));

// ---- acceptance fit per spot
const obs = {};
for (const r of rows) {
  if (r.trucks.length !== 1 || r.events.length) continue;
  const t = r.trucks[0];
  if (t.sold >= t.meals || r.customers < 15) continue;
  const rep = t.rep ?? 50;
  if (V[t.quality] * rf(rep) - t.price < 0) continue; // value cutoff known exactly
  (obs[r.spot] = obs[r.spot] || []).push({ q: t.quality, p: t.price, f: t.sold / r.customers, w: r.customers });
}
const spots = {};
for (const [sp, o] of Object.entries(obs)) {
  let best = null;
  for (let mu = 9; mu <= 16; mu += 0.25) for (let sd = 1; sd <= 5; sd += 0.25) {
    // given mu, sd the best frac per quality is a weighted LS closed form
    const fr = {}; let err = 0;
    for (const q of ["cheap", "standard", "premium"]) {
      let num = 0, den = 0;
      for (const x of o) if (x.q === q) { const s = 1 - phi((x.p - mu) / sd); num += x.w * s * x.f; den += x.w * s * s; }
      fr[q] = den ? Math.min(1, num / den) : null;
      for (const x of o) if (x.q === q && fr[q] != null) { const s = 1 - phi((x.p - mu) / sd); err += x.w * (fr[q] * s - x.f) ** 2; }
    }
    if (!best || err < best.err) best = { err, mu, sd, fr, n: o.length };
  }
  spots[sp] = best;
  console.log(sp.padEnd(9), "n", String(best.n).padStart(4), "mu", best.mu, "sd", best.sd,
    "frac", Object.entries(best.fr).map(([q, v]) => q[0] + "=" + (v == null ? "?" : v.toFixed(2))).join(" "));
}
console.log("weather mult:", JSON.stringify(weatherMult, (k, v) => typeof v === "number" ? +v.toFixed(3) : v));
fs.writeFileSync("model.json", JSON.stringify({ spots, weatherMult }, null, 1));

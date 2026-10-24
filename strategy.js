// v2 strategy: model-based. For each spot x quality x price, simulate tomorrow's
// customers against predicted rival offers under weather/noise scenarios, pick the
// profit-maximising meal count (newsvendor over scenarios), and add a value for the
// reputation change. Rivals are predicted from what they did yesterday (and, at the
// start of a new final market, from what they did at the same day of earlier markets).
const M = require("./model.js");

function makeStrategy(opts = {}) {
  const P = { repVal: 6, repHorizon: 8, stick: 0, priceStep: 0.25, ...opts };
  let mem = null;          // per-market memory
  const crossMarket = {};  // truckId -> day -> offer, across final markets

  function memory(state) {
    const id = state.mode + ":" + state.market;
    if (!mem || mem.id !== id) mem = { id, rivalRep: {}, lastDaySeen: 0, lastSpot: null };
    return mem;
  }

  // Track rival reputations ourselves (the live state may only give averages).
  function trackReps(state) {
    const last = state.last_day;
    if (!last || !last.spots || last.day <= mem.lastDaySeen) return;
    mem.lastDaySeen = last.day;
    const visited = {};
    for (const [sp, info] of Object.entries(last.spots)) for (const t of info.trucks || []) {
      visited[t.id] = visited[t.id] || {};
      if (t.sold > 0) visited[t.id][sp] = t.quality;
      if (state.mode === "final") ((crossMarket[t.id] = crossMarket[t.id] || {})[last.day] = { spot: sp, price: t.price, quality: t.quality, meals: t.meals });
    }
    for (const t of state.trucks || []) {
      const r = mem.rivalRep[t.id] = mem.rivalRep[t.id] || Object.fromEntries(state.rules.spots.map((s) => [s, 50]));
      for (const sp of state.rules.spots) {
        const q = visited[t.id] && visited[t.id][sp];
        if (q) r[sp] = Math.max(0, Math.min(100, r[sp] + M.REP_DELTA[q]));
        else r[sp] += (50 - r[sp]) * 0.03;
      }
    }
  }

  function rivalRep(state, id, spot) {
    const t = (state.trucks || []).find((x) => x.id === id);
    if (t && t.reputation && t.reputation[spot] != null) return t.reputation[spot];
    return (mem.rivalRep[id] && mem.rivalRep[id][spot]) ?? 50;
  }

  function predictRivals(state) {
    const me = state.you.id, out = {};
    for (const sp of state.rules.spots) out[sp] = [];
    const last = state.last_day;
    if (last && last.spots && last.day >= 1) {
      for (const [sp, info] of Object.entries(last.spots)) for (const t of info.trucks || []) {
        if (t.id === me || !out[sp]) continue;
        out[sp].push({ quality: t.quality, price: t.price, meals: t.meals, rep: rivalRep(state, t.id, sp) });
      }
      return out;
    }
    // first day of a market: use the same day from earlier final markets if we have it
    let known = 0;
    for (const t of state.trucks || []) {
      if (t.id === me) continue;
      const h = crossMarket[t.id] && crossMarket[t.id][state.order_for_day];
      if (h && out[h.spot]) { out[h.spot].push({ ...h, rep: 50 }); known++; }
    }
    if (known) return out;
    // nothing known: spread the rivals over spots in proportion to the crowd
    const n = Math.max(0, (state.trucks || []).length - 1);
    const exp = state.forecast.expected_customers, tot = Object.values(exp).reduce((a, b) => a + b, 0) || 1;
    for (const sp of state.rules.spots) {
      const k = n * exp[sp] / tot;
      if (k > 0.05) out[sp].push({ quality: "standard", price: 10.5, meals: 120 * k, rep: 50 });
    }
    return out;
  }

  function evaluate(state, rivals) {
    const fc = state.forecast, rules = state.rules;
    const daysLeft = Math.max(0, (state.days || 30) - (state.order_for_day || 1));
    const cands = [];
    for (const spot of rules.spots) {
      const par = M.spotParams(spot, fc.events);
      const base = fc.expected_customers[spot] || 0;
      const scen = M.scenarios(spot, fc.weather);
      const myRep = (state.you.reputation && state.you.reputation[spot]) ?? 50;
      for (const quality of ["cheap", "standard", "premium"]) {
        const cost = rules.costs[quality];
        const maxMeals = Math.floor(rules.budget / cost + 1e-9);
        const cap = M.VALUES[quality] * M.repFactor(myRep);
        const lo = Math.ceil((cost + 0.5) / P.priceStep) * P.priceStep;
        for (let price = lo; price <= Math.min(rules.price_max, cap) + 1e-9; price += P.priceStep) {
          price = Math.round(price * 100) / 100;
          const offers = rivals[spot].concat([{ quality, price, meals: 1e6, rep: myRep }]);
          const D = scen.map(([mult, w]) => [M.clear(base * mult, par, offers)[offers.length - 1], w]);
          // newsvendor over the discrete scenarios
          D.sort((a, b) => a[0] - b[0]);
          let best = { m: 0, prof: 0, sold: 0 };
          for (const [dm] of D) {
            const m = Math.min(maxMeals, Math.floor(dm));
            if (m <= 0) continue;
            let sold = 0;
            for (const [d, w] of D) sold += w * Math.min(m, d);
            const prof = sold * price - m * cost;
            if (prof > best.prof) best = { m, prof, sold };
          }
          if (best.m <= 0) continue;
          const repGain = Math.max(-myRep, Math.min(100 - myRep, M.REP_DELTA[quality]));
          const future = repGain * P.repVal * Math.min(daysLeft, P.repHorizon) / P.repHorizon;
          const score = best.prof + future + (mem.lastSpot === spot ? P.stick : 0);
          cands.push({ score, spot, quality, price, meals: best.m, prof: best.prof, sold: best.sold });
        }
      }
    }
    cands.sort((a, b) => b.score - a.score);
    return cands;
  }

  function decide(state) {
    memory(state);
    trackReps(state);
    const rivals = predictRivals(state);
    const cands = evaluate(state, rivals);
    const best = cands[0] || { spot: "union", quality: "standard", price: 10.5, meals: 40, prof: 0, sold: 0 };
    mem.lastSpot = best.spot;
    if (!opts.quiet) console.log(`    plan: ${best.spot} ${best.quality} $${best.price} x${best.meals} (exp sold ${best.sold.toFixed(0)}, exp profit $${best.prof.toFixed(0)})`);
    return { spot: best.spot, price: best.price, quality: best.quality, meals: best.meals };
  }

  return { decide, evaluate, predictRivals };
}

module.exports = { makeStrategy };

# Food Truck Wars bot

Builders Night Shift, 2026-10-23. Node 18+, no dependencies.

```powershell
$env:NIGHTSHIFT_KEY = "fk_..."
node bot.js --practice   # private practice market
node bot.js              # live game / final, leave running
```

Strategy: score every spot x quality x price by expected demand (price limits, quality
minimums, value-for-money vs rivals predicted from yesterday), cook the newsvendor-optimal
number of meals, value reputation gains, and calibrate demand from results.

# Market Ripple research system

A research tool that maps how world events move commodities, stocks, funds and crypto, measures those
links against real prices, and keeps a growing log of world events. It is not a trading system and gives
no buy or sell advice.

- Map and live desk: https://claude.ai/artifact/EMLTQM7WRjBVffZbYkgn6s
- Background report: https://claude.ai/code/artifact/cc82a9db-b692-4928-8204-a82cb1292918

## What runs where

| Part | File | What it does |
| --- | --- | --- |
| Prices | `predictor/fetch.py` | Daily history since 2005 for 73 Yahoo Finance series, plus the daily Geopolitical Risk index |
| Link tests | `predictor/calibrate.py` | Tests every map link with an event study; searches all pairs for predictive links |
| Model | `predictor/model.py` | Walk-forward logistic model, 5 and 20 days ahead, calibrated on 2014 to 2026 test years |
| Event log | `predictor/events.py` | Append-only log in `knowledge/events.jsonl`, de-duplicated; computes event pressure |
| Export | `predictor/export.py` | Builds the map database documents in `out/db/` |
| Job | `JOB.md`, `run_pipeline.sh` | Scheduled task `world-events-learning`, every 2 hours while the Claude app is open |

Run everything by hand: `./run_pipeline.sh`

## What the first full run found (14 Oct 2026)

- 51 of the 79 testable links show up in real prices (43 clearly). One is contradicted: copper and car
  makers rise together because demand lifts both, which swamps the cost effect.
- Only 1 of 79 links still predicts from the day after the shock. The extra "predictive" pairs the search
  found are mostly time-zone effects (US moves showing up in the next Asian session), not tradable.
- Out of sample, 6 of 69 assets beat a naive forecast at 20 days, mostly commodity futures (steel,
  wheat, soybeans, soybean oil, silver). The median AUC is 0.50, a coin flip.
- Raw probabilities were overconfident (a stated 84% came true about 60% of the time), so they are now
  calibrated. Expect most numbers between about 52% and 59%.

## Correlations (`predictor/correlate.py`, weekly returns since 2015)

- Copper vs bitcoin: weekly correlation +0.11, +0.04 after removing the S&P 500; ranged -0.11 to +0.29 by
  year and flipped sign 6 times; +0.22 in high-VIX weeks, about 0 in calm ones. When copper fell in a
  month, bitcoin fell that month 49% of the time (usual 44%) and the next month 35%. Copper does not lead
  bitcoin by a week (-0.02, p = 0.66).
- Strong and stable: dollar vs EM currencies -0.63, gold vs dollar -0.46 (no sign flips), Nvidia vs
  memory makers +0.53, silver vs copper +0.43, wheat vs soybeans +0.40.
- Lead-lag: 0 of 4,830 "this week predicts next week" tests survived a multiple-testing correction.
- Adding every asset's 5- and 20-day moves to the model (`predictor/experiment_xasset.py`) made it worse
  on unseen years: 1 of 69 assets beat naive with them, 6 without. Re-run weekly by the pipeline.

## Stock universe, exposures and the event screener

- Universe (`predictor/universe.py`): S&P 500, 400 and 600; Nasdaq Global Select and Global Market common
  stocks; Nifty 500, Sensex 30, Nifty Microcap 250 and the Nifty Total Market; about 45 global names.
  The Dow 30 are all S&P 500 members. About 3,700 stocks; prices refresh once a day.
- Exposures (`predictor/exposures.py`, weekly): each stock's weekly moves are cleaned of its market, its
  sector, company size and growth-versus-value, then tested against 38 factors (energy, metals, grains,
  softs, livestock, rates, currencies, VIX, bitcoin, freight, AI/semis, defence primes, geopolitical
  risk). Robust = |t| >= 4.5, likely = |t| >= 3, and the sign must hold in all three thirds of the sample.
  "Hidden" = an exposure the stock's sector would not normally have. Each stock's eight biggest surprises
  since 2012 are matched to same-day factor shocks and logged episodes.
- Screener (`stock_screen` in `exposures.py`, every run): each event of the last 14 days is traced through
  the map to factors, then to stocks through their measured exposures. It ranks exposure to the news, as a
  starting list for research; it does not forecast returns and is not advice.

## My portfolio (map section)

Paste tickers with optional weights. Each holding is scored the same way as the screener (current events ->
factors -> the holding's measured exposures), and the page sums the portfolio's factor leanings and the
events touching the most holdings. Holdings are saved in the viewer's private `data/users/<id>/` subtree
of the map database, which no one else can read. It shows exposure, not buy or sell calls.

## Limits

- The model learns from prices; the event log becomes training data only after a few months of entries.
- Yahoo continuous futures include contract-roll jumps; some proxies are thin (aluminium, steel).
- Links that start at shocks (tariffs, wars) have no price series and are judged from logged episodes only.

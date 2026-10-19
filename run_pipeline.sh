#!/bin/zsh
# Refresh prices, re-measure every map link, retrain the tested model, and rebuild the database export.
# Usage: ./run_pipeline.sh            (about 1 minute; longer once a day and once a week)
set -e
cd "$(dirname "$0")"
PY=.venv/bin/python
# the 600-stock universe is refreshed once a day; the 73 core series every run
if [ ! -f data/prices/AAPL.csv ] || [ -n "$(find data/prices/AAPL.csv -mmin +1200)" ]; then
  echo "== prices (daily universe refresh, several minutes)"; $PY -u -m predictor.fetch --universe | tail -2
else
  echo "== prices"; $PY -m predictor.fetch | tail -2
fi
echo "== links";  $PY -m predictor.calibrate 2>/dev/null | head -2
# new model inputs are trialled once a week; only families that beat the model without them are used (predictor.feature_trials)
if [ ! -f knowledge/feature_trials.json ] || [ -n "$(find knowledge/feature_trials.json -mtime +6)" ]; then
  echo "== weekly SEC data + feature trials"; $PY -m predictor.sec_data 2>&1 | tail -1 || true
  $PY -W ignore -m predictor.feature_trials 2>&1 | grep -E "verdict|Error" || true
fi
echo "== model";  $PY -m predictor.model > out/model_log.txt 2>&1 && $PY -c "import json;s=json.load(open('knowledge/model_report.json'))['summary'];print({h:(v['with_skill'],v['targets'],v['median_auc']) for h,v in s.items()})"
echo "== correlations"; $PY -W ignore -m predictor.correlate 2>/dev/null | head -1
# slower jobs that change slowly: once a week
if [ ! -f knowledge/experiment_xasset.json ] || [ -n "$(find knowledge/experiment_xasset.json -mtime +6)" ]; then
  echo "== weekly cross-asset experiment"; $PY -W ignore -m predictor.experiment_xasset 2>/dev/null | grep -E 'x_beats|base_beats' || true
fi
if [ ! -f knowledge/stock_profiles.json ] || [ -n "$(find knowledge/stock_profiles.json -mtime +6)" ]; then
  echo "== weekly stock exposure profiles"; $PY -W ignore -m predictor.exposures 2>/dev/null | head -1
fi
echo "== export"; $PY -m predictor.export --days $(date -u +%F) $(date -u -v-1d +%F) | grep -E "stock profiles" || true
echo "out/db/writes.json ready"

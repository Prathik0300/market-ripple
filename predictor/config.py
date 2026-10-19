"""Shared settings: where files live and which market series stand in for each map node."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PRICES = DATA / "prices"
KNOWLEDGE = ROOT / "knowledge"
OUT = ROOT / "out"
GRAPH_FILE = KNOWLEDGE / "graph.json"
EVENTS_FILE = KNOWLEDGE / "events.jsonl"

# node id -> (Yahoo symbol, transform)
#   "price": use log returns of the close
#   "inverse": the node is the strength of a currency quoted as USD/XXX, so use -log return
#   "yield": a yield in percent, so use daily changes in percentage points
PROXIES = {
    # macro & money
    "us_yields": ("^TNX", "yield"),
    "usd": ("DX-Y.NYB", "price"),
    "risk_on": ("^GSPC", "price"),
    "freight": ("BDRY", "price"),
    "inr": ("INR=X", "inverse"),
    "jpy": ("JPY=X", "inverse"),
    "em_fx": ("CEW", "price"),
    # commodities
    "brent": ("BZ=F", "price"),
    "jet_fuel": ("HO=F", "price"),
    "ttf": ("TTF=F", "price"),
    "hh": ("NG=F", "price"),
    "gold": ("GC=F", "price"),
    "silver": ("SI=F", "price"),
    "copper": ("HG=F", "price"),
    "aluminium": ("ALI=F", "price"),
    "steel": ("HRC=F", "price"),
    "wheat": ("ZW=F", "price"),
    "rice": ("ZR=F", "price"),
    "palm_oil": ("ZL=F", "price"),
    "soybeans": ("ZS=F", "price"),
    "cocoa": ("CC=F", "price"),
    "coffee": ("KC=F", "price"),
    # companies & sectors (one liquid bellwether each)
    "oil_majors": ("XOM", "price"),
    "india_omc": ("BPCL.NS", "price"),
    "airlines": ("UAL", "price"),
    "tankers": ("FRO", "price"),
    "container": ("ZIM", "price"),
    "defense": ("LMT", "price"),
    "gold_miners": ("NEM", "price"),
    "copper_miners": ("FCX", "price"),
    "alu_producers": ("AA", "price"),
    "beverages": ("KO", "price"),
    "fertilizer": ("NTR", "price"),
    "eu_chem": ("BAS.DE", "price"),
    "lng_export": ("LNG", "price"),
    "uranium_miners": ("CCJ", "price"),
    "lithium_miners": ("ALB", "price"),
    "re_miners": ("MP", "price"),
    "ai_chips": ("NVDA", "price"),
    "memory": ("MU", "price"),
    "hyperscalers": ("MSFT", "price"),
    "devices": ("AAPL", "price"),
    "autos": ("GM", "price"),
    "chocolate": ("HSY", "price"),
    "india_paints": ("ASIANPAINT.NS", "price"),
    "industrial_gas": ("APD", "price"),
    "nuclear_smr": ("CEG", "price"),
    "indian_it": ("INFY.NS", "price"),
    "jp_exporters": ("7203.T", "price"),
    "homebuilders": ("DHI", "price"),
    "crypto_stocks": ("COIN", "price"),
    "coffee_chains": ("SBUX", "price"),
    "ag_traders": ("ADM", "price"),
    "steel_cos": ("NUE", "price"),
    # funds, ETFs & crypto
    "f_oil": ("USO", "price"),
    "f_gold": ("GLD", "price"),
    "f_silver": ("SLV", "price"),
    "f_copper": ("COPX", "price"),
    "f_uranium": ("URA", "price"),
    "f_lithium": ("LIT", "price"),
    "f_rare": ("REMX", "price"),
    "f_defense": ("ITA", "price"),
    "f_semis": ("SMH", "price"),
    "f_agri": ("DBA", "price"),
    "f_bonds": ("TLT", "price"),
    "f_jets": ("JETS", "price"),
    "f_gas": ("UNG", "price"),
    "f_india": ("INDA", "price"),
    "bitcoin": ("BTC-USD", "price"),
    "ether": ("ETH-USD", "price"),
}

# Extra series used as model inputs but not drawn as nodes.
EXTRA = {
    "india_gold_fund": ("GOLDBEES.NS", "price"),
    "rheinmetall": ("RHM.DE", "price"),
    "vix": ("^VIX", "price"),
}

HISTORY_START = 1104537600  # 1 Jan 2005, UTC
HORIZONS = (5, 20)  # trading days ahead that the model forecasts

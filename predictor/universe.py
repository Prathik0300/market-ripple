"""The stock universe (S&P 500, Nifty 50, major global names) and the factor series every stock is tested
against (commodities, rates, currencies, crypto, freight, geopolitical risk).

    python -m predictor.universe      # rebuild data/universe/universe.json from the saved Wikipedia pages
"""
import io
import json
import re

import pandas as pd

from .config import DATA

UNI_DIR = DATA / "universe"
UNI_FILE = UNI_DIR / "universe.json"

SECTOR_ETF = {
    "Energy": "XLE", "Materials": "XLB", "Industrials": "XLI", "Consumer Discretionary": "XLY",
    "Consumer Staples": "XLP", "Health Care": "XLV", "Financials": "XLF", "Information Technology": "XLK",
    "Communication Services": "XLC", "Utilities": "XLU", "Real Estate": "XLRE",
}

NIFTY_SECTOR = {  # Nifty sector names -> nearest GICS sector
    "metals & mining": "Materials", "services": "Industrials", "healthcare": "Health Care", "automobile": "Consumer Discretionary",
    "financial services": "Financials", "information technology": "Information Technology", "consumer durables": "Consumer Discretionary",
    "oil gas & consumable fuels": "Energy", "oil, gas & consumable fuels": "Energy", "fast moving consumer goods": "Consumer Staples",
    "power": "Utilities", "construction": "Industrials", "construction materials": "Materials", "chemicals": "Materials",
    "telecommunication": "Communication Services", "capital goods": "Industrials", "consumer services": "Consumer Discretionary",
    "realty": "Real Estate", "media entertainment & publication": "Communication Services",
    "media, entertainment & publication": "Communication Services", "textiles": "Consumer Discretionary",
    "forest materials": "Materials", "diversified": "Industrials", "metals and mining": "Materials",
    "automobile and auto components": "Consumer Discretionary", "utilities": "Utilities",
}

GLOBAL = [  # symbol, name, GICS sector, market index
    ("TSM", "TSMC (ADR)", "Information Technology", "^GSPC"), ("ASML", "ASML (ADR)", "Information Technology", "^GSPC"),
    ("NVO", "Novo Nordisk (ADR)", "Health Care", "^GSPC"), ("SAP", "SAP (ADR)", "Information Technology", "^GSPC"),
    ("TM", "Toyota (ADR)", "Consumer Discretionary", "^GSPC"), ("SONY", "Sony (ADR)", "Consumer Discretionary", "^GSPC"),
    ("BABA", "Alibaba (ADR)", "Consumer Discretionary", "^GSPC"), ("SHEL", "Shell (ADR)", "Energy", "^GSPC"),
    ("BP", "BP (ADR)", "Energy", "^GSPC"), ("TTE", "TotalEnergies (ADR)", "Energy", "^GSPC"),
    ("RIO", "Rio Tinto (ADR)", "Materials", "^GSPC"), ("BHP", "BHP (ADR)", "Materials", "^GSPC"),
    ("VALE", "Vale (ADR)", "Materials", "^GSPC"), ("AZN", "AstraZeneca (ADR)", "Health Care", "^GSPC"),
    ("UL", "Unilever (ADR)", "Consumer Staples", "^GSPC"), ("DEO", "Diageo (ADR)", "Consumer Staples", "^GSPC"),
    ("BUD", "AB InBev (ADR)", "Consumer Staples", "^GSPC"), ("NSRGY", "Nestle (ADR)", "Consumer Staples", "^GSPC"),
    ("TECK", "Teck Resources", "Materials", "^GSPC"), ("SCCO", "Southern Copper", "Materials", "^GSPC"),
    ("AEM", "Agnico Eagle", "Materials", "^GSPC"), ("WPM", "Wheaton Precious Metals", "Materials", "^GSPC"),
    ("CCJ", "Cameco", "Energy", "^GSPC"), ("NTR", "Nutrien", "Materials", "^GSPC"), ("SQM", "SQM", "Materials", "^GSPC"),
    ("MP", "MP Materials", "Materials", "^GSPC"), ("FRO", "Frontline", "Energy", "^GSPC"), ("ZIM", "ZIM Shipping", "Industrials", "^GSPC"),
    ("CENX", "Century Aluminum", "Materials", "^GSPC"), ("AA", "Alcoa", "Materials", "^GSPC"),
    ("005930.KS", "Samsung Electronics", "Information Technology", "^KS11"), ("000660.KS", "SK hynix", "Information Technology", "^KS11"),
    ("RHM.DE", "Rheinmetall", "Industrials", "^STOXX50E"), ("AIR.PA", "Airbus", "Industrials", "^STOXX50E"),
    ("MC.PA", "LVMH", "Consumer Discretionary", "^STOXX50E"), ("SIE.DE", "Siemens", "Industrials", "^STOXX50E"),
    ("BAS.DE", "BASF", "Materials", "^STOXX50E"), ("VOW3.DE", "Volkswagen", "Consumer Discretionary", "^STOXX50E"),
    ("NHY.OL", "Norsk Hydro", "Materials", "^STOXX50E"), ("YAR.OL", "Yara", "Materials", "^STOXX50E"),
    ("GLEN.L", "Glencore", "Materials", "^STOXX50E"), ("MAERSK-B.CO", "Maersk", "Industrials", "^STOXX50E"),
    ("7203.T", "Toyota (Tokyo)", "Consumer Discretionary", "^N225"), ("8035.T", "Tokyo Electron", "Information Technology", "^N225"),
    ("2222.SR", "Saudi Aramco", "Energy", "^GSPC"), ("LYC.AX", "Lynas Rare Earths", "Materials", "^GSPC"),
    ("PLS.AX", "Pilbara Minerals", "Materials", "^GSPC"),
    ("VEDL.NS", "Vedanta", "Materials", "^NSEI"), ("NATIONALUM.NS", "NALCO", "Materials", "^NSEI"),
    ("IOC.NS", "Indian Oil", "Energy", "^NSEI"), ("HINDPETRO.NS", "HPCL", "Energy", "^NSEI"), ("BPCL.NS", "BPCL", "Energy", "^NSEI"),
    ("VBL.NS", "Varun Beverages", "Consumer Staples", "^NSEI"), ("INDIGO.NS", "IndiGo (InterGlobe)", "Industrials", "^NSEI"),
    ("ASIANPAINT.NS", "Asian Paints", "Materials", "^NSEI"),
]

# factor id -> (symbol, transform, label, group)
FACTORS = {
    "oil": ("BZ=F", "price", "Crude oil (Brent)", "energy"),
    "gasoline": ("RB=F", "price", "Gasoline", "energy"),
    "diesel": ("HO=F", "price", "Diesel / heating oil", "energy"),
    "gas_us": ("NG=F", "price", "US natural gas", "energy"),
    "gas_eu": ("TTF=F", "price", "Europe gas (TTF)", "energy"),
    "uranium": ("SRUUF", "price", "Uranium (physical trust)", "energy"),
    "gold": ("GC=F", "price", "Gold", "metals"),
    "silver": ("SI=F", "price", "Silver", "metals"),
    "platinum": ("PL=F", "price", "Platinum", "metals"),
    "palladium": ("PA=F", "price", "Palladium", "metals"),
    "copper": ("HG=F", "price", "Copper", "metals"),
    "aluminium": ("ALI=F", "price", "Aluminium", "metals"),
    "steel": ("HRC=F", "price", "Steel (US HRC)", "metals"),
    "lithium": ("LIT", "price", "Lithium & battery stocks (LIT)", "metals"),
    "wheat": ("ZW=F", "price", "Wheat", "agriculture"),
    "corn": ("ZC=F", "price", "Corn", "agriculture"),
    "soybeans": ("ZS=F", "price", "Soybeans", "agriculture"),
    "soyoil": ("ZL=F", "price", "Soybean oil", "agriculture"),
    "rice": ("ZR=F", "price", "Rice", "agriculture"),
    "sugar": ("SB=F", "price", "Sugar", "agriculture"),
    "coffee": ("KC=F", "price", "Coffee", "agriculture"),
    "cocoa": ("CC=F", "price", "Cocoa", "agriculture"),
    "cotton": ("CT=F", "price", "Cotton", "agriculture"),
    "cattle": ("LE=F", "price", "Live cattle", "agriculture"),
    "hogs": ("HE=F", "price", "Lean hogs", "agriculture"),
    "ojuice": ("OJ=F", "price", "Orange juice", "agriculture"),
    "rates": ("^TNX", "yield", "US 10-year yield", "macro"),
    "dollar": ("DX-Y.NYB", "price", "US dollar index", "macro"),
    "euro": ("EURUSD=X", "price", "Euro", "macro"),
    "yuan": ("CNY=X", "inverse", "Chinese yuan", "macro"),
    "rupee": ("INR=X", "inverse", "Indian rupee", "macro"),
    "yen": ("JPY=X", "inverse", "Japanese yen", "macro"),
    "vix": ("^VIX", "price", "Volatility (VIX)", "macro"),
    "bitcoin": ("BTC-USD", "price", "Bitcoin", "crypto"),
    "freight": ("BDRY", "price", "Dry-bulk freight (BDRY)", "trade"),
    "semis": ("SMH", "price", "Semiconductors / AI trade (SMH)", "theme"),
    "defense": ("LMT+NOC+GD+LHX", "basket", "Defence primes (LMT, NOC, GD, LHX)", "theme"),
    "gpr": ("GPR", "gpr", "Geopolitical risk index", "geopolitics"),
}

STYLE = {"size": ("IWM", "SPY"), "growth": ("IWF", "IWD")}  # small minus large, growth minus value
MARKETS = ["^GSPC", "^NSEI", "^STOXX50E", "^N225", "^KS11", "^IXIC", "^DJI", "^BSESN"]

# Exposures you would expect from a sector; anything robust outside this list is flagged "hidden".
EXPECTED = {
    "Energy": {"oil", "gasoline", "diesel", "gas_us", "gas_eu", "uranium", "rates"},
    "Materials": {"copper", "aluminium", "steel", "gold", "silver", "platinum", "palladium", "lithium", "gas_us", "gas_eu", "oil", "dollar", "yuan"},
    "Utilities": {"rates", "gas_us", "gas_eu"},
    "Real Estate": {"rates"},
    "Financials": {"rates", "vix"},
    "Consumer Staples": {"wheat", "corn", "soybeans", "soyoil", "sugar", "coffee", "cocoa", "cattle", "hogs", "rates", "dollar"},
    "Industrials": {"freight", "defense", "oil", "diesel", "steel"},
    "Information Technology": {"semis", "dollar", "yen", "rupee"},
    "Communication Services": {"semis"},
    "Consumer Discretionary": {"oil", "gasoline", "steel", "aluminium"},
    "Health Care": {"rates"},
}


def yahoo(sym):
    return sym.replace(".", "-") if re.fullmatch(r"[A-Z]+\.[A-Z]", sym) else sym


def build():
    """Merge every list into one universe. A stock in several indexes keeps its first record and gains the
    other index names in "indexes" (S&P 500 first, so GICS sectors win over coarser ones)."""
    by_sym, order = {}, []

    def add(sym, name, sector, industry, index, market):
        sym = str(sym).strip()
        if not sym or sym.lower().startswith("nan") or name in ("nan", ""):
            return
        if sym in by_sym:
            if index not in by_sym[sym]["indexes"]:
                by_sym[sym]["indexes"].append(index)
            return
        by_sym[sym] = {"sym": sym, "name": str(name), "sector": sector, "industry": str(industry), "index": index,
                       "indexes": [index], "market": market}
        order.append(sym)

    for fname, label in (("sp500.html", "S&P 500"), ("sp400.html", "S&P 400"), ("sp600.html", "S&P 600")):
        t = pd.read_html(io.StringIO((UNI_DIR / fname).read_text()))[0]
        for _, r in t.iterrows():
            add(yahoo(str(r["Symbol"])), r["Security"], str(r["GICS Sector"]), r["GICS Sub-Industry"], label, "^GSPC")
    nf_tables = pd.read_html(io.StringIO((UNI_DIR / "nifty50.html").read_text()))
    nf = next(t for t in nf_tables if 45 <= len(t) <= 55 and any("Symbol" in str(c) for c in t.columns))
    sym_col = next(c for c in nf.columns if "Symbol" in str(c))
    sec_col = next(c for c in nf.columns if "Sector" in str(c))
    for _, r in nf.iterrows():
        sec = NIFTY_SECTOR.get(str(r[sec_col]).strip().lower(), "Industrials")
        add(f"{str(r[sym_col]).strip()}.NS", r[nf.columns[0]], sec, r[sec_col], "Nifty 50", "^NSEI")
    sx = next(t for t in pd.read_html(io.StringIO((UNI_DIR / "sensex.html").read_text())) if "Symbol" in [str(c) for c in t.columns] and len(t) == 30)
    for _, r in sx.iterrows():
        nse = str(r["Symbol"]).replace(".BO", ".NS")
        add(nse, r["Company"], NIFTY_SECTOR.get(str(r["Industry"]).strip().lower(), "Industrials"), r["Industry"], "Sensex", "^NSEI")
    n5 = pd.read_csv(UNI_DIR / "nifty500.csv")
    for _, r in n5.iterrows():
        add(f"{str(r['Symbol']).strip()}.NS", r["Company Name"], NIFTY_SECTOR.get(str(r["Industry"]).strip().lower(), "Industrials"), r["Industry"], "Nifty 500", "^NSEI")
    # Indian small and micro caps (NSE lists); stocks already in the Nifty 500 just gain the label
    for fname, label in (("ind_niftysmallcap250list.csv", "Nifty Smallcap 250"), ("ind_niftymicrocap250_list.csv", "Nifty Microcap 250"),
                         ("ind_niftytotalmarket_list.csv", "Nifty Total Market")):
        p = UNI_DIR / fname
        if not p.exists():
            continue
        for _, r in pd.read_csv(p).iterrows():
            add(f"{str(r['Symbol']).strip()}.NS", r["Company Name"], NIFTY_SECTOR.get(str(r["Industry"]).strip().lower(), "Industrials"), r["Industry"], label, "^NSEI")
    for sym, name, sec, mkt in GLOBAL:
        add(sym, name, sec, sec, "Global", mkt)
    # Nasdaq Global Select and Global Market common stocks (sector unknown unless already listed above)
    nq = pd.read_csv(UNI_DIR / "nasdaqlisted.txt", sep="|").dropna(subset=["Symbol"])
    nq = nq[(nq["Test Issue"] == "N") & (nq["ETF"] == "N") & (nq["Financial Status"] == "N") & nq["Market Category"].isin(["Q", "G"])]
    nq = nq[~nq["Security Name"].str.contains(r"Warrant|Right|Unit|Preferred|Notes|Debenture|Depositary Shares, each representing a", case=False, regex=True)]
    for _, r in nq.iterrows():
        sym = str(r["Symbol"]).strip()
        if re.fullmatch(r"[A-Z]{1,5}", sym):
            add(sym, str(r["Security Name"]).split(" - ")[0], "Unclassified", "Nasdaq-listed", "Nasdaq", "^GSPC")
    stocks = [by_sym[s] for s in order]
    UNI_FILE.write_text(json.dumps({"stocks": stocks}, indent=1))
    print(f"{len(stocks)} stocks: " + ", ".join(f"{k} {v}" for k, v in pd.Series([s['index'] for s in stocks]).value_counts().items()))
    return stocks


def load():
    return json.loads(UNI_FILE.read_text())["stocks"]


def all_symbols():
    syms = {s["sym"] for s in load()}
    for v in FACTORS.values():
        if v[0] != "GPR":
            syms |= set(v[0].split("+"))
    syms |= {x for pair in STYLE.values() for x in pair}
    syms |= set(SECTOR_ETF.values()) | set(MARKETS)
    return sorted(syms)


if __name__ == "__main__":
    build()

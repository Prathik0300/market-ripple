"""Collect fresh, dated headlines from RSS feeds for the two-hourly job to triage.

Web search does not sort by time, so the job starts from feeds that carry a publication time:
topic searches on Google News (limited to the last day) for US and Indian editions, plus a few publishers'
own feeds. Headlines already logged (same link or a near-identical title) are dropped.

It also reads earlier sources, grouped by topic, so the job sees a story before news sites pick it up:
  sec-filings      SEC EDGAR 8-K, 6-K and Form 4 (insider trades) for the portfolio and screener watchlist
  india-filings    NSE and BSE corporate announcements for Indian names in the portfolio (Groww), the screener watchlist
                   and the newest focus list; a filing both exchanges carry is listed once, at the earlier time
  fed-register     Federal Register documents on public inspection (the day before official publication)
  us-official      Federal Reserve press releases, BLS release feeds, OFAC recent actions
  india-official   RBI press releases and notifications, DGFT notifications
  press-wires      PR Newswire and Business Wire (earnings, M&A) company press releases
  fast-wires       FinancialJuice and investingLive (ex-ForexLive) headline feeds
  leader-posts     Trump's Truth Social posts via an unofficial public mirror (trumpstruth.org)
  weather          NOAA hurricane centre (Atlantic, East Pacific) and NWS severe alerts for TX, LA, IA, IL, NE
  prediction-markets  Polymarket and Kalshi markets on the Fed, tariffs, wars, oil and recession that moved
                   10+ points in about 24 h (snapshots kept in out/prediction_markets.json)
Upcoming scheduled releases (BLS and USDA calendars, next 7 days) are listed separately under "upcoming".
SEC and BLS refuse requests without a contact address in the User-Agent: set SEC_CONTACT (an email) in the environment.
Every source fails softly: an error is recorded and the rest still run. Sources are fetched in parallel.

    python -m predictor.news            # writes out/news_candidates.json and prints a numbered list
    python -m predictor.news --hours 24
"""
import argparse
import contextlib
import csv
import html
import http.cookiejar
import io
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

from .analyst import watchlist
from .config import KNOWLEDGE, OUT
from .events import _similar, load_events

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
# Government sites get a plain descriptive User-Agent. SEC and BLS also require a contact address, read from SEC_CONTACT.
GOV_UA = {"User-Agent": "Market Ripple personal research"}
IST = timezone(timedelta(hours=5, minutes=30))
ET_TZ = ZoneInfo("America/New_York")
TOPICS = {
    "energy": 'oil OR crude OR OPEC OR Hormuz OR refinery OR LNG OR "natural gas" OR pipeline',
    "metals": 'copper OR aluminium OR aluminum OR nickel OR lithium OR "rare earth" OR smelter OR "mine strike" OR steel',
    "agriculture": 'wheat OR rice OR corn OR soybean OR fertilizer OR urea OR cocoa OR coffee OR sugar OR drought OR monsoon',
    "trade-policy": 'tariff OR "export ban" OR "export controls" OR sanctions OR quota OR "anti-dumping"',
    "central-bank": '"Federal Reserve" OR ECB OR "Bank of Japan" OR PBOC OR "rate hike" OR "rate cut" OR CPI OR inflation',
    "supply-chain": 'shortage OR outage OR "port closure" OR "factory fire" OR "supply chain" OR "Red Sea" OR shipping OR strike workers',
    "conflict": 'missile OR ceasefire OR war OR attack OR coup OR blockade',
    "tech": 'semiconductor OR chip OR "memory prices" OR helium OR "data center" OR Nvidia',
    "crypto": 'bitcoin OR crypto OR "spot ETF" OR stablecoin',
}
INDIA_TOPICS = {
    "india-markets": 'RBI OR rupee OR Sensex OR Nifty OR SEBI OR FPI',
    "india-policy": 'India "export ban" OR "quality control order" OR BIS OR "import duty" OR GST',
    "india-supply": 'India shortage OR LPG OR fertiliser OR monsoon OR "fuel price"',
}
FEEDS = {
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    "CNBC world": "https://www.cnbc.com/id/100727362/device/rss/rss.html",
    "CNBC economy": "https://www.cnbc.com/id/20910258/device/rss/rss.html",
    "Mint markets": "https://www.livemint.com/rss/markets",
    "Economic Times markets": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
}
# Federal Register agency slugs: Commerce (incl. BIS and ITA trade remedies), USTR, Treasury/OFAC, Energy, and the
# Executive Office of the President (tariff proclamations and executive orders).
FR_AGENCIES = {
    "commerce-department", "industry-and-security-bureau", "international-trade-administration",
    "trade-representative-office-of-united-states", "treasury-department", "foreign-assets-control-office",
    "energy-department", "executive-office-of-the-president",
}
BLS_FEEDS = ["cpi", "empsit", "ppi", "jolts", "ximpim", "eci", "realer", "prod2"]
RBI_FEEDS = {"RBI press releases": "https://www.rbi.org.in/pressreleases_rss.xml", "RBI notifications": "https://www.rbi.org.in/notifications_rss.xml"}
# Exchange filings that are routine compliance, not news: newspaper notices, lost share certificates, trading-window
# closures, depository certificates (NSE "Depositories and Participants", BSE "Reg. 74 (5)").
FILING_SKIP = re.compile(r"newspaper|share certificate|trading window|depositories and participants|reg\. ?74 ?\(5\)", re.I)
NSE_PAGE = "https://www.nseindia.com/companies-listing/corporate-filings-announcements"
NSE_UA = {**UA, "Accept": "application/json, text/plain, */*", "Referer": NSE_PAGE}
BSE_API = "https://api.bseindia.com/BseIndiaAPI/api"
# BSE's API answers scripted requests with "Access Denied" unless they send a JSON Accept header and bseindia.com as Referer.
BSE_UA = {**UA, "Accept": "application/json, text/plain, */*", "Referer": "https://www.bseindia.com/"}
# BSE is asked once per company: 6 at a time, each worker pausing 0.5 s, covers about 40 names in 5-6 s. With 4 it took
# 8-16 s inside the full run and became the slowest source (Oct 2026); BSE refused none of these requests.
BSE_WORKERS = 6
# NSE and BSE filings by one company this many minutes apart can be one filing (_merge_filings). On 15-16 Oct 2026 (all
# companies, 603 NSE/BSE pairs attaching the same PDF) the median gap was 3 minutes, 98% were within 30 and 99% within
# 45; BSE was first in 59%.
PAIR_MINUTES = 45
# Words that do not tell filings apart: exchange boilerplate ("X Limited has informed the Exchange about ..."),
# regulation references, the catch-all "General Updates" category, dates and reporting periods, and "Board of Directors
# at its meeting held today", which every filing from a results-day board meeting repeats.
FILING_STOP = set("""about alia also and announcement announcements any approve are attached attachment attachments been board
bse company compliance compliances consider copy dated dear details directors disclosure disclosures email enclose enclosed
enclosing ended exchange exchanges find for from general half has have held herewith iii inform information informed inter
intimate intimation its kindly letter limited listing lodr ltd ltdhas madam mail meeting nse obligations para part per period
please pursuant quarter read received reference refer reg regarding regulation regulations requirements schedule scheduled sebi
sir stock sub submission submit submitted that the their this titled today under update updates vide was were which with year
yearly january february march april may june july august september october november december jan feb mar apr jun jul aug sep
sept oct nov dec monday tuesday wednesday thursday friday saturday sunday""".split())
# An exchange's own surveillance query (NSE category, BSE subcategory), kept apart from the company's reply.
EXCH_QUERY = re.compile(r"(spurt in volume|price movement|news verification|clarification)$", re.I)
WIRES = {
    "PR Newswire financial": "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss",
    "Business Wire earnings": "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEF9YXA==",
    "Business Wire M&A": "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFtRWA==",
}
FAST = {"FinancialJuice": "https://www.financialjuice.com/feed.ashx?xy=rss", "investingLive": "https://investinglive.com/feed/"}
NHC = {"NHC Atlantic": "https://www.nhc.noaa.gov/index-at.xml", "NHC East Pacific": "https://www.nhc.noaa.gov/index-ep.xml"}
NWS_STATES = "TX,LA,IA,IL,NE"  # Gulf Coast refineries and ports; corn belt
# Prediction markets: Polymarket tags and Kalshi series covering the Fed, tariffs, wars and ceasefires, oil, recession.
POLY_TAGS = ["fed", "tariffs", "oil", "economy", "geopolitics", "ceasefire", "ukraine", "middle-east", "iran", "china"]
POLY_KEEP = re.compile(r"\bfed\b|fomc|rate (cut|hike)|interest rate|tariff|trade deal|\bwar\b|invade|invasion|ceasefire|peace|military|"
                       r"strike|attack|clash|nuclear|blockade|strait|hormuz|\boil\b|crude|opec|recession|sanction", re.I)
KALSHI_SERIES = [
    "KXFEDDECISION", "KXRECSSNBER", "KXQRECESS", "KXWRECSS", "KXLARGETARIFF", "KXNEWTARIFFS", "KXEFFTARIFF",
    "KXTARIFFRATEPRC", "KXTARIFFRATEINDIA", "KXTARIFFSEMI", "KXTARIFFPHARMA", "KXGLOBALTARIFFS", "KXHORMUZRETURN",
    "KXOPECCUTS", "KXINDIAOIL", "KXCRUDEEXPORTBAN", "KXOFAC", "KXSANCTIONRUSSIA", "KXUKRAINE", "KXUSAIRANAGREEMENT",
]
MOVE_PTS = 0.10       # a move of 10 percentage points or more
POLY_MIN_VOL = 5000   # USD traded in 24 h, so thin markets do not trigger
KALSHI_MIN_VOL = 1000  # contracts traded in 24 h


def _gnews(q, india=False):
    params = {"q": f"{q} when:1d", "hl": "en-IN" if india else "en-US", "gl": "IN" if india else "US", "ceid": "IN:en" if india else "US:en"}
    return "https://news.google.com/rss/search?" + urllib.parse.urlencode(params)


def _read(url, headers=UA):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read()


def _row(title, url, source, ts, topic, feed):
    ts = ts.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return {"title": re.sub(r"\s+", " ", html.unescape(html.unescape(title))).strip(), "url": url, "source": source, "ts": ts, "topic": topic, "feed": feed}


def _items(xml_bytes, feed, topic, naive_tz=None):
    out = []
    root = ET.fromstring(xml_bytes)
    for it in root.iter("item"):
        title = html.unescape(html.unescape((it.findtext("title") or "").strip()))
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate")
        src = it.find("source")
        source = (src.text if src is not None else feed) or feed
        try:
            ts = parsedate_to_datetime(pub) if pub else None
            if ts and ts.tzinfo is None and naive_tz:
                ts = ts.replace(tzinfo=naive_tz)
            ts = ts.astimezone(timezone.utc) if ts else None
        except (TypeError, ValueError):
            ts = None
        if title and ts:
            title = re.sub(r"\s+-\s+[^-]{2,60}$", "", title) if source and title.endswith(source) else title
            out.append({"title": title, "url": link, "source": source.strip(), "ts": ts.isoformat().replace("+00:00", "Z"), "topic": topic, "feed": feed})
    return out


# ---- primary sources ----

def _watch_syms():
    """Stocks held in knowledge/portfolio.json plus the screener's watchlist (python -m predictor.analyst watchlist)."""
    syms = []
    from .brokers import all_holdings
    syms += [h["sym"] for h in all_holdings() if h.get("kind") == "stock"]
    with contextlib.redirect_stdout(io.StringIO()):
        syms += watchlist()
    return list(dict.fromkeys(syms))


def _contact_ua():
    """User-Agent with the SEC_CONTACT address; SEC and BLS answer 403 without one."""
    contact = os.environ.get("SEC_CONTACT", "").strip()
    if not contact:
        raise RuntimeError("SEC_CONTACT is not set (SEC and BLS refuse requests without a contact email)")
    return {"User-Agent": f"Market Ripple personal research {contact}"}


def _sec_ciks(syms, ua):
    """CIK -> ticker for the watched symbols, from SEC's ticker file (cached in out/ for a week)."""
    p = OUT / "sec_company_tickers.json"
    if not p.exists() or time.time() - p.stat().st_mtime > 7 * 86400:
        p.write_bytes(_read("https://www.sec.gov/files/company_tickers.json", ua))
    want = set(syms)
    return {int(r["cik_str"]): r["ticker"] for r in json.loads(p.read_text()).values() if r["ticker"] in want}


def _sec(cut, syms):
    """8-K, 6-K and Form 4 filings by watched companies, from EDGAR's latest-filings Atom feed (paged back to the cutoff).

    A Form 4 appears twice in the feed: once under the insider ("Reporting") and once under the company ("Issuer");
    the company entry is matched and the insider's name is taken from the other entry with the same accession number.
    """
    ua = _contact_ua()
    ciks = _sec_ciks(syms, ua)
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for form, pages in (("8-K", 10), ("6-K", 10), ("4", 40)):
        for start in range(0, pages * 100, 100):
            url = f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type={form}&company=&dateb=&owner=include&start={start}&count=100&output=atom"
            entries = ET.fromstring(_read(url, ua)).findall("a:entry", ns)
            reporters = {}
            for e in entries:
                m = re.match(r"\S+ - (.+?) \(\d{10}\) \(Reporting\)", e.findtext("a:title", namespaces=ns) or "")
                if m:
                    reporters[e.findtext("a:id", namespaces=ns)] = m[1]
            oldest = None
            for e in entries:
                oldest = datetime.fromisoformat(e.findtext("a:updated", namespaces=ns))
                m = re.match(r"(\S+) - (.+?) \((\d{10})\) \((\w+)\)", e.findtext("a:title", namespaces=ns) or "")
                if not m or m[4] == "Reporting" or int(m[3]) not in ciks or oldest < cut:
                    continue
                if form == "4" and m[1] not in ("4", "4/A"):  # type=4 is a prefix search: it also returns 424B and 425
                    continue
                link = e.find("a:link", ns).get("href")
                head = f"{ciks[int(m[3])]} {m[1] if m[1] != '4' else 'Form 4'} {m[2].title()}: "
                if form == "4":
                    title = head + f"insider filing by {reporters.get(e.findtext('a:id', namespaces=ns), 'an insider').title()}"
                else:
                    summary = html.unescape(e.findtext("a:summary", namespaces=ns) or "")
                    items = re.findall(r"Item \d+\.\d+: [^<\n]+", summary)
                    items = [i for i in items if not i.startswith("Item 9.01")] or items
                    title = head + ("; ".join(i.strip() for i in items) or "filed")
                out.append(_row(title, link, "SEC EDGAR", oldest, "sec-filings", "SEC EDGAR"))
            if not entries or oldest < cut:
                break
            time.sleep(0.15)  # SEC's limit is 10 requests a second
    return out


def _fed_register(cut):
    """Documents on Federal Register public inspection (filed the day before publication) from the trade/energy agencies."""
    d = json.loads(_read("https://www.federalregister.gov/api/v1/public-inspection-documents/current.json", GOV_UA))
    out = []
    for r in d.get("results", []):
        slugs = {a.get("slug") for a in r.get("agencies", [])}
        if not slugs & FR_AGENCIES or not r.get("filed_at"):
            continue
        ts = datetime.fromisoformat(r["filed_at"])
        agency = "; ".join(r.get("agency_names") or [])
        title = f"{agency}: {(r.get('title') or r.get('toc_doc') or '').strip()} ({r.get('type')}, publishes {r.get('publication_date')})"
        if ts >= cut:
            out.append(_row(title, r.get("html_url"), "Federal Register (public inspection)", ts, "fed-register", "Federal Register"))
    return out


def _atom(xml_bytes, feed, topic):
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for e in ET.fromstring(xml_bytes).findall("a:entry", ns):
        pub = e.findtext("a:published", namespaces=ns) or e.findtext("a:updated", namespaces=ns)
        link = e.find("a:link", ns)
        if pub:
            out.append(_row(e.findtext("a:title", namespaces=ns) or "", link.get("href") if link is not None else "", feed, datetime.fromisoformat(pub), topic, feed))
    return out


def _ofac(cut):
    """OFAC recent actions (HTML list; it shows a date but no time, so items are stamped noon US Eastern)."""
    page = _read("https://ofac.treasury.gov/recent-actions", UA).decode("utf-8", "replace")
    now = datetime.now(timezone.utc)
    out = []
    for href, title, day in re.findall(r'<a href="(/recent-actions/[^"]+)"[^>]*>([^<]+)</a></div></div><div><div[^>]*>\s*([A-Z][a-z]+ \d{1,2}, \d{4})', page):
        ts = min(datetime.strptime(day, "%B %d, %Y").replace(hour=12, tzinfo=ET_TZ), now)
        if ts >= cut:
            out.append(_row("OFAC: " + html.unescape(title), "https://ofac.treasury.gov" + href, "OFAC recent actions", ts, "us-official", "OFAC"))
    return out


def _dgft(cut):
    """DGFT notifications (no RSS or JSON exists; the notification page's table carries a creation timestamp)."""
    page = _read("https://www.dgft.gov.in/CP/?opt=notification", UA).decode("utf-8", "replace")
    out = []
    for row in re.findall(r"<tr>(.*?)</tr>", page, re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        link = re.search(r'href="([^"]+)"', row)
        if len(cells) < 6 or not re.match(r"\d\d/\d\d/\d{4} \d\d:\d\d:\d\d$", cells[5]):
            continue
        ts = datetime.strptime(cells[5], "%d/%m/%Y %H:%M:%S").replace(tzinfo=IST)
        if ts >= cut:
            url = urllib.parse.quote(link[1], safe=":/") if link else "https://www.dgft.gov.in/CP/?opt=notification"
            out.append(_row(f"DGFT Notification {cells[1]}: {cells[3]}", url, "DGFT", ts, "india-official", "DGFT"))
    return out


def _india_watch(syms):
    """Indian names to follow on the exchanges, as {symbol: ISIN or None}: Groww holdings, the .NS/.BO names among syms
    (the screener watchlist) and both sides of the India group in the newest knowledge/focus/<date>.json."""
    from .brokers import all_holdings
    held = [h for h in all_holdings() if str(h.get("sym", "")).endswith((".NS", ".BO"))]
    names = [h["sym"] for h in held] + [s for s in syms if s.endswith((".NS", ".BO"))]
    focus = sorted((KNOWLEDGE / "focus").glob("????-??-??.json"))
    if focus:
        india = json.loads(focus[-1].read_text()).get("india") or {}
        names += [r["sym"] for side in ("up", "down") for r in india.get(side) or []]
    isin = {h["sym"]: h.get("isin") for h in held}
    return {s: isin.get(s) for s in dict.fromkeys(names)}


def _nse_get(url):
    """GET from NSE's JSON API. It answers plain requests (Oct 2026); if it starts refusing them (401/403), visit the
    announcements page once for Akamai's session cookies (the home page refuses scripts) and retry with them."""
    try:
        return _read(url, NSE_UA)
    except urllib.error.HTTPError as e:
        if e.code not in (401, 403):
            raise
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    with opener.open(urllib.request.Request(NSE_PAGE, headers={**UA, "Accept": "text/html"}), timeout=25) as r:
        r.read()
    with opener.open(urllib.request.Request(url, headers=NSE_UA), timeout=25) as r:
        return r.read()


def _nse(cut, watch):
    """NSE corporate announcements for the watched .NS names. One request lists every company's filings since the
    cutoff (about 500 a weekday); rows match on symbol, or on ISIN for a holding whose symbol has since changed."""
    if not watch:
        return []
    by_isin = {i: s for s, i in watch.items() if i}
    q = {"index": "equities", "from_date": cut.astimezone(IST).strftime("%d-%m-%Y"), "to_date": datetime.now(IST).strftime("%d-%m-%Y")}
    out = []
    for r in json.loads(_nse_get("https://www.nseindia.com/api/corporate-announcements?" + urllib.parse.urlencode(q))):
        sym = (r.get("symbol") or "") + ".NS"
        sym = sym if sym in watch else by_isin.get(r.get("sm_isin"))
        if not sym:
            continue
        ts = datetime.strptime(r.get("exchdisstime") or r["an_dt"], "%d-%b-%Y %H:%M:%S").replace(tzinfo=IST)  # public (disseminated) time
        if ts < cut or FILING_SKIP.search(f"{r.get('desc')} {r.get('attchmntText')}"):
            continue
        pdf = r.get("attchmntFile")
        it = _row(f"{sym[:-3]} (NSE) {r.get('desc')}: {(r.get('attchmntText') or '')[:200]}", pdf if pdf and pdf != "-" else NSE_PAGE,
                  "NSE announcements", ts, "india-filings", "NSE")
        it["_m"] = _filing_match(sym, ts, _nse_size(r.get("fileSize")), f"{r.get('desc')} {r.get('attchmntText') or ''}", r.get("sm_name"), r.get("desc"))
        out.append(it)
    return out


def _nse_size(s):
    """NSE shows an attachment's size rounded ("658.62 KB"): (bytes, rounding error), or None without an attachment."""
    m = re.fullmatch(r"([\d.]+) (Bytes|KB|MB|GB)", (s or "").strip())
    if not m or not float(m[1]):
        return None
    unit = 1024 ** ["Bytes", "KB", "MB", "GB"].index(m[2])
    return float(m[1]) * unit, 0.0051 * unit


def _filing_match(sym, ts, size, text, name, kind):
    """What _merge_filings compares: the watched symbol, the time, the attachment size as (bytes, rounding error), the
    subject words (leaving out the company's name, numbers, dates and FILING_STOP), the words of kind (the NSE category
    or BSE subcategory) and whether kind is an exchange's surveillance query."""
    name = set(re.findall(r"[a-z0-9]+", (name or "").lower()))
    words = lambda s: {w for w in re.findall(r"[a-z0-9]+", s.lower())
                       if len(w) > 2 and w not in name and w not in FILING_STOP and not re.fullmatch(r"\d+(st|nd|rd|th)?", w)}
    return {"sym": sym, "t": ts, "size": size, "words": words(text), "kind": words(kind or ""), "query": bool(EXCH_QUERY.match((kind or "").strip()))}


def _bse_codes():
    """BSE scrip code of every active BSE equity, keyed by SYMBOL.BO, by ISIN, and by SYMBOL.NS (NSE's equity list joined
    on ISIN, since some companies trade under different symbols on the two exchanges). Cached in out/ for a week."""
    p = OUT / "bse_scrip_codes.json"
    if not p.exists() or time.time() - p.stat().st_mtime > 7 * 86400:
        rows = json.loads(_read(f"{BSE_API}/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active", BSE_UA))
        codes = {r["ISIN_NUMBER"].strip(): r["SCRIP_CD"] for r in rows if r.get("ISIN_NUMBER")}
        codes |= {r["scrip_id"].strip() + ".BO": r["SCRIP_CD"] for r in rows if r.get("scrip_id")}
        nse = csv.reader(io.StringIO(_read("https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv").decode("utf-8", "replace")))
        codes |= {row[0].strip() + ".NS": codes[row[6].strip()] for row in nse if len(row) > 6 and row[6].strip() in codes}
        p.write_text(json.dumps(codes))
    return json.loads(p.read_text())


def _bse(cut, watch):
    """BSE corporate announcements for the watched names, asked per BSE scrip code (50 a page, newest first),
    BSE_WORKERS companies at a time. Returns (items, errors): a company whose request fails is reported, not fatal."""
    codes = _bse_codes()
    since, until = cut.astimezone(IST).strftime("%Y%m%d"), datetime.now(IST).strftime("%Y%m%d")

    def company(sym, code):
        out = []
        for page in range(1, 6):
            q = {"pageno": page, "strCat": -1, "strPrevDate": since, "strScrip": code, "strSearch": "P", "strToDate": until, "strType": "C", "subcategory": -1}
            rows = json.loads(_read(f"{BSE_API}/AnnSubCategoryGetData/w?" + urllib.parse.urlencode(q), BSE_UA)).get("Table") or []
            for r in rows:
                ts = datetime.fromisoformat(r.get("DissemDT") or r["NEWS_DT"]).replace(tzinfo=IST)
                # NEWSSUB reads "Company Ltd - 500440 - Announcement under Regulation 30 (LODR)-Press Release": keep the subject
                subject = re.sub(r"^.+? - \d{6} - |Announcement under Regulation 30 \(LODR\)\s*-\s*", "", r.get("NEWSSUB") or "").strip()
                if ts < cut or FILING_SKIP.search(f"{r.get('SUBCATNAME')} {subject}"):
                    continue
                pdf = r.get("ATTACHMENTNAME")
                url = f"https://www.bseindia.com/xml-data/corpfiling/{'AttachLive' if r.get('PDFFLAG') == 0 else 'AttachHis'}/{pdf}" if pdf else r.get("NSURL") or ""
                head = re.sub(r"<[^>]+>", " ", r.get("HEADLINE") or "").strip()
                title = f"{sym.rsplit('.', 1)[0]} (BSE) {subject[:150]}" + (f": {head[:160]}" if head and head.lower() not in subject.lower() else "")
                it = _row(title.replace("''", "'"), url, "BSE announcements", ts, "india-filings", "BSE")
                size = r.get("Fld_Attachsize")
                it["_m"] = _filing_match(sym, ts, (float(size), 0.0) if size else None, f"{subject} {head}", r.get("SLONGNAME"), r.get("SUBCATNAME"))
                out.append(it)
            time.sleep(0.5)
            if len(rows) < 50:
                break
        return out

    todo = {}
    for sym, isin in sorted(watch.items(), key=lambda kv: not kv[0].endswith(".NS")):
        code = codes.get(sym) or codes.get(isin or "") or codes.get(sym.rsplit(".", 1)[0] + ".BO")
        if code and code not in todo.values():  # a company watched as both X.NS and X.BO is asked once, as X.NS (to pair with NSE)
            todo[sym] = code
    with ThreadPoolExecutor(max_workers=BSE_WORKERS) as ex:
        futs = {sym: ex.submit(company, sym, code) for sym, code in todo.items()}
    out, failed = [], []
    for sym, f in futs.items():
        try:
            out += f.result()
        except Exception as e:
            failed.append(f"{sym.rsplit('.', 1)[0]}: {e}")
    if failed and len(failed) == len(todo):
        raise RuntimeError(f"all {len(todo)} companies failed ({failed[0]})")
    return out, [f"BSE: {len(failed)} of {len(todo)} companies failed ({'; '.join(failed[:3])})"] if failed else []


def _same_size(a, b):
    """Equal attachment sizes, (bytes, rounding error) each. The larger error, not the sum: two NSE sizes one rounding
    step apart ("3.13 MB", "3.14 MB") are different files."""
    return bool(a and b) and abs(a[0] - b[0]) <= max(a[1], b[1])


def _merge_filings(items):
    """List each filing once. NSE and BSE carry most filings minutes apart, and a company sometimes files one document
    twice on an exchange (e.g. results as both "Outcome of Board Meeting" and "Financial Results"). Items of one company
    are merged into the earliest, titled from the item with the most subject words, when (strongest evidence first):
      - an NSE and a BSE item attach the same PDF (equal size) that no other filing of the company on either exchange
        attaches, within PAIR_MINUTES;
      - they attach the same PDF and share 2+ subject words or a category word ("Outcome of Board Meeting" on both,
        "Dividend" on both): on a results day one PDF can serve several filings;
      - they share 3+ subject words, within 30 minutes (some companies send each exchange its own letter);
      - two items on one exchange attach the same PDF and share 75%+ of their subject words, within PAIR_MINUTES.
    Each NSE item pairs with at most one BSE item, best evidence first, and an exchange's surveillance query is never
    merged with the company's reply. Subject words leave out the company's name and boilerplate, which is what made
    events._similar merge different companies' filings."""
    m = [it.pop("_m") for it in items]
    n = len(items)
    same_doc = lambda i, j: m[i]["sym"] == m[j]["sym"] and _same_size(m[i]["size"], m[j]["size"])
    unique = [sum(same_doc(i, j) and items[i]["feed"] == items[j]["feed"] for j in range(n)) == 1 for i in range(n)]
    group = list(range(n))

    def root(i):
        while group[i] != i:
            i = group[i]
        return i

    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            a, b = m[i], m[j]
            if a["sym"] != b["sym"] or a["query"] != b["query"]:
                continue
            mins = abs(a["t"] - b["t"]).total_seconds() / 60
            size, common = same_doc(i, j), len(a["words"] & b["words"])
            if items[i]["feed"] == items[j]["feed"]:
                if size and mins <= PAIR_MINUTES and common and common >= 0.75 * min(len(a["words"]), len(b["words"])):
                    group[root(i)] = root(j)
                continue
            strong = size and unique[i] and unique[j]
            if (strong or size and (common >= 2 or a["kind"] & b["kind"])) and mins <= PAIR_MINUTES or common >= 3 and mins <= 30:
                pairs.append(((not strong, not size, -common, mins), i, j))
    paired = set()
    for _, i, j in sorted(pairs):
        if i not in paired and j not in paired:
            paired |= {i, j}
            group[root(i)] = root(j)
    groups = {}
    for i in sorted(range(n), key=lambda i: items[i]["ts"]):
        groups.setdefault(root(i), []).append(i)
    out = []
    for g in groups.values():
        if len(g) == 1:
            out.append(items[g[0]])
            continue
        feeds = "+".join(dict.fromkeys(items[i]["feed"] for i in g))  # in order of dissemination, e.g. BSE+NSE
        best = max(g, key=lambda i: len(m[i]["words"]))  # the earliest among equals
        out.append({**items[g[0]], "title": re.sub(r"\((NSE|BSE)\)", f"({feeds})", items[best]["title"], count=1)})
    return out


def _india_filings(cut, syms):
    """Exchange filings for the watched Indian names from both exchanges, fetched side by side: NSE for .NS names (one
    request for all companies) and BSE for every name (one request each). BSE usually disseminates a few minutes before
    NSE and also lists board-meeting intimations (which set results dates) and SAST disclosures that NSE's announcements
    lack. A filing both carry is listed once (_merge_filings). Returns (items, errors), so one exchange failing does not
    drop the other's items."""
    watch = _india_watch(syms)
    with ThreadPoolExecutor(max_workers=2) as ex:
        nse = ex.submit(_nse, cut, {s: i for s, i in watch.items() if s.endswith(".NS")})
        bse = ex.submit(_bse, cut, watch)
    out, errors = [], []
    try:
        out += nse.result()
    except Exception as e:
        errors.append(f"NSE: {e}")
    try:
        items, errs = bse.result()
        out += items
        errors += errs
    except Exception as e:
        errors.append(f"BSE: {e}")
    return _merge_filings(out), errors


def _bls():
    ua = _contact_ua()
    out = []
    for n in BLS_FEEDS:
        out += _atom(_read(f"https://www.bls.gov/feed/{n}.rss", ua), "BLS", "us-official")
    return out


def _fast(name, url):
    out = _items(_read(url), name, "fast-wires")
    for it in out:
        it["title"] = re.sub(r"^FinancialJuice:\s*", "", it["title"])
    return out


def _truth():
    """Trump's Truth Social posts from trumpstruth.org, an unofficial public mirror (Truth Social has no open feed)."""
    out = []
    for it in _items(_read("https://trumpstruth.org/feed"), "Truth Social mirror", "leader-posts"):
        if re.match(r"^(\[No Title\]|(Video|Image|Photo) post from|RT @)", it["title"]):
            continue
        text = html.unescape(it["title"])
        it["title"] = "Trump on Truth Social: " + (text[:240] + "..." if len(text) > 240 else text)
        it["source"] = "Truth Social via trumpstruth.org (unofficial mirror)"
        out.append(it)
    return out


def _nhc(name, url):
    """Hurricane centre products: keep public advisories and outlooks, drop the graphics/discussion duplicates."""
    return [it for it in _items(_read(url), name, "weather") if re.search(r"Public Advisory|Tropical Weather Outlook", it["title"])]


def _nws():
    """NWS severe and extreme alerts for the Gulf Coast refinery/port states and the corn belt, one per event and state."""
    d = json.loads(_read(f"https://api.weather.gov/alerts/active?area={NWS_STATES}&severity=Severe,Extreme", {**GOV_UA, "Accept": "application/geo+json"}))
    latest = {}
    for f in d.get("features", []):
        pr = f.get("properties", {})
        states = sorted({c[:2] for c in pr.get("geocode", {}).get("UGC", [])} & set(NWS_STATES.split(",")))
        if not pr.get("sent") or not states:
            continue
        key = (pr.get("event"), states[0])
        if key not in latest or pr["sent"] > latest[key]["sent"]:
            latest[key] = pr
    out = []
    for (event, st), pr in latest.items():
        title = f"NWS {event} ({st}, {pr.get('severity')}): {(pr.get('areaDesc') or '')[:150]}"
        out.append(_row(title, pr.get("@id") or pr.get("id") or "", "NWS alerts", datetime.fromisoformat(pr["sent"]), "weather", "NWS"))
    return out


# ---- prediction markets ----

def _poly_markets():
    out = {}
    for tag in POLY_TAGS:
        for ev in json.loads(_read(f"https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&tag_slug={tag}")):
            for m in ev.get("markets", []):
                if m.get("closed") or not m.get("active") or not POLY_KEEP.search(f"{ev.get('title')} {m.get('question')}"):
                    continue
                try:
                    outcomes, prices = json.loads(m["outcomes"]), json.loads(m["outcomePrices"])
                except (KeyError, TypeError, ValueError):
                    continue
                if not outcomes or outcomes[0] != "Yes":
                    continue
                p = float(prices[0])
                chg = m.get("oneDayPriceChange")
                out["poly:" + str(m["id"])] = {"q": m.get("question"), "p": p, "vol": float(m.get("volume24hr") or 0), "min_vol": POLY_MIN_VOL,
                                               "day_ago": p - float(chg) if chg is not None else None, "src": "Polymarket",
                                               "url": f"https://polymarket.com/event/{ev.get('slug')}"}
    return out


def _kalshi_markets():
    out = {}
    for series in KALSHI_SERIES:
        url = f"https://api.elections.kalshi.com/trade-api/v2/events?status=open&series_ticker={series}&with_nested_markets=true&limit=50"
        for wait in (0, 2, 5):  # Kalshi rate-limits bursts (HTTP 429): back off and retry
            time.sleep(wait or 0.3)
            try:
                d = json.loads(_read(url))
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or wait == 5:
                    raise
        for ev in d.get("events", []):
            for m in ev.get("markets", []):
                if m.get("status") not in (None, "active"):
                    continue
                f = lambda k: float(m.get(k) or 0)
                bid, ask, last = f("yes_bid_dollars"), f("yes_ask_dollars"), f("last_price_dollars")
                p = (bid + ask) / 2 if bid > 0 and 0 < ask < 1 and ask - bid <= 0.10 else last
                sub = m.get("yes_sub_title") or ""
                q = m.get("title") or ev.get("title") or m["ticker"]
                out["kalshi:" + m["ticker"]] = {"q": q + (f" [{sub}]" if sub and sub not in q else ""), "p": p, "vol": f("volume_24h_fp"),
                                                "min_vol": KALSHI_MIN_VOL, "day_ago": f("previous_price_dollars") or None, "src": "Kalshi",
                                                "url": f"https://kalshi.com/markets/{series.lower()}"}
    return out


def _prediction_moves():
    """Markets whose Yes probability moved 10+ points in about a day. The baseline is our own snapshot nearest to 24 h
    ago (at least 12 h old, kept in out/prediction_markets.json); before such a snapshot exists, the API's own
    previous-day price is used."""
    now = datetime.now(timezone.utc)
    current, errors = {}, []
    for name, fn in (("Polymarket", _poly_markets), ("Kalshi", _kalshi_markets)):
        try:
            current.update(fn())
        except Exception as e:
            errors.append(f"{name}: {e}")
    path = OUT / "prediction_markets.json"
    try:
        hist = json.loads(path.read_text()).get("history", {}) if path.exists() else {}
    except ValueError:
        hist = {}
    out = []
    for key, m in current.items():
        old = [(datetime.fromisoformat(t), p) for t, p in hist.get(key, []) if now - datetime.fromisoformat(t) >= timedelta(hours=12)]
        if old:
            t0, p0 = min(old, key=lambda x: abs((now - x[0]) - timedelta(hours=24)))
        elif m["day_ago"] is not None:
            t0, p0 = now - timedelta(hours=24), m["day_ago"]
        else:
            continue
        if abs(m["p"] - p0) >= MOVE_PTS and m["vol"] >= m["min_vol"]:
            hrs = (now - t0).total_seconds() / 3600
            title = f"{m['src']} odds: \"{m['q']}\" Yes {p0:.0%} -> {m['p']:.0%} in {hrs:.0f} h"
            out.append(_row(title, m["url"], m["src"], now, "prediction-markets", m["src"]))
    keep_from = now - timedelta(hours=48)
    for key, m in current.items():
        hist.setdefault(key, []).append([now.isoformat(timespec="seconds"), round(m["p"], 4)])
    hist = {k: [x for x in v if datetime.fromisoformat(x[0]) >= keep_from] for k, v in hist.items()}
    path.write_text(json.dumps({"updated": now.isoformat(timespec="seconds"), "history": {k: v for k, v in hist.items() if v}}))
    if errors and not current:
        raise RuntimeError("; ".join(errors))
    return out, errors


# ---- release calendars (upcoming, not headlines) ----

def _bls_calendar(now, until):
    text = _read("https://www.bls.gov/schedule/news_release/bls.ics", _contact_ua()).decode("utf-8", "replace")
    text = re.sub(r"\r?\n[ \t]", "", text)  # unfold continuation lines
    out = []
    for ev in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.S):
        start, summ = re.search(r"DTSTART[^:\n]*:(\d{8}T\d{6})", ev), re.search(r"\nSUMMARY:(.*)", ev)
        if start and summ:
            ts = datetime.strptime(start[1], "%Y%m%dT%H%M%S").replace(tzinfo=ET_TZ)
            if now <= ts <= until:
                out.append({"date": ts.isoformat(), "title": summ[1].strip(), "source": "BLS release calendar", "topic": "calendar", "url": "https://www.bls.gov/schedule/"})
    return out


def _usda_calendar(now, until):
    """USDA ESMIS release calendar (NASS reports, WASDE): the page embeds its events as JSON."""
    page = _read("https://usda.library.cornell.edu/release-calendar").decode("utf-8", "replace")
    cfg = json.loads(re.search(r'data-drupal-selector="drupal-settings-json">(.*?)</script>', page, re.S)[1])
    events = [e for v in cfg.get("fullcalendar", {}).values() for src in v.get("options", {}).get("eventSources", []) for e in src]
    out, seen = [], set()
    for e in events:
        ts = datetime.fromisoformat(e["start"])
        if now <= ts <= until and (e["start"], e["title"]) not in seen:
            seen.add((e["start"], e["title"]))
            out.append({"date": ts.isoformat(), "title": re.sub(r"\s+", " ", e["title"]), "source": "USDA release calendar", "topic": "calendar",
                        "url": "https://usda.library.cornell.edu" + (e.get("url") or "/release-calendar")})
    return out


def _jobs(cut):
    """(name, function) for every feed; each function returns a list of items."""
    jobs = [(f"Google News US/{t}", lambda q=q, t=t: _items(_read(_gnews(q)), "Google News US", t)) for t, q in TOPICS.items()]
    jobs += [(f"Google News India/{t}", lambda q=q, t=t: _items(_read(_gnews(q, True)), "Google News India", t)) for t, q in INDIA_TOPICS.items()]
    jobs += [(name, lambda name=name, u=u: _items(_read(u), name, "publisher")) for name, u in FEEDS.items()]
    try:
        syms = _watch_syms()
    except Exception:
        syms = []
    jobs += [("SEC EDGAR", lambda: _sec(cut, syms)), ("Federal Register", lambda: _fed_register(cut)),
             ("Federal Reserve", lambda: _items(_read("https://www.federalreserve.gov/feeds/press_all.xml", GOV_UA), "Federal Reserve", "us-official")),
             ("BLS", _bls), ("OFAC", lambda: _ofac(cut)), ("DGFT", lambda: _dgft(cut)), ("India filings", lambda: _india_filings(cut, syms)),
             ("Truth Social mirror", _truth), ("NWS alerts", _nws)]
    jobs += [(name, lambda name=name, u=u: _items(_read(u, GOV_UA), name, "india-official", naive_tz=IST)) for name, u in RBI_FEEDS.items()]
    jobs += [(name, lambda name=name, u=u: _items(_read(u), name, "press-wires")) for name, u in WIRES.items()]
    jobs += [(name, lambda name=name, u=u: _fast(name, u)) for name, u in FAST.items()]
    jobs += [(name, lambda name=name, u=u: _nhc(name, u)) for name, u in NHC.items()]
    return jobs


EARLY = ("sec-filings", "india-filings", "fed-register", "us-official", "india-official", "press-wires", "fast-wires", "leader-posts", "weather", "prediction-markets")
# feeds whose titles follow a template, so 75% shared words can be different events: NHC "Atlantic" vs "Eastern North
# Pacific Tropical Weather Outlook", Truth Social endorsements of different candidates, FinancialJuice "Saudi civil
# defense: danger has passed in Riyadh" vs "... in Najran" (18 Oct 2026)
TEMPLATE = ("weather", "leader-posts", "fast-wires")


def _template_dup(a, b):
    """Two template-feed items repeat each other only with the same text, except the same story on two different fast
    wires (FinancialJuice and investingLive word it differently). NHC basins are separate feeds, so weather is exact."""
    if a["feed"] != b["feed"] and a["topic"] == b["topic"] == "fast-wires":
        return _similar(a["title"], b["title"])
    return re.findall(r"\w+", a["title"].lower()) == re.findall(r"\w+", b["title"].lower())


def _dedupe(got, cut, logged):
    """Drops items already logged (same link or a similar title) and, of two similar titles in this run, keeps the one
    from an EARLY topic, then the earlier one: a filing or release is not replaced by the news story it caused (Vedanta's
    18 Oct 2026 press release on NSE at 06:34 UTC, then Economic Times at 06:58). TEMPLATE items dedupe each other
    only by _template_dup. Returns newest first."""
    logged_urls = {e.get("url") for e in logged}
    recent_titles = [e["title"] for e in logged[-300:]]
    seen, templates, filings, keep = [], [], [], []
    for it in sorted(got, key=lambda x: (x["topic"] not in EARLY, x["ts"])):
        if datetime.fromisoformat(it["ts"].replace("Z", "+00:00")) < cut:
            continue
        if it["url"] in logged_urls or any(_similar(it["title"], t) for t in recent_titles) or any(_similar(it["title"], s) for s in seen):
            continue
        if any(_template_dup(it, t) if it["topic"] in TEMPLATE else _similar(it["title"], t["title"]) for t in templates):
            continue
        # exchange boilerplate ("... has informed the Exchange about ...") would merge different companies' filings, so
        # filing titles drop only other feeds' items
        if it["topic"] == "india-filings":
            filings.append(it["title"])
        elif any(_similar(it["title"], f) for f in filings):
            continue
        elif it["topic"] in TEMPLATE:  # compared with other template items by _template_dup, with the rest by _similar
            templates.append(it)
        else:
            seen.append(it["title"])
        keep.append(it)
    return sorted(keep, key=lambda x: x["ts"], reverse=True)


def collect(hours=48):
    now = datetime.now(timezone.utc)
    cut = now - timedelta(hours=hours)
    OUT.mkdir(exist_ok=True)
    got, errors, upcoming = [], [], []
    jobs = _jobs(cut)
    calendars = [("BLS calendar", _bls_calendar), ("USDA calendar", _usda_calendar)]
    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = [(name, ex.submit(fn)) for name, fn in jobs]
        moves = ex.submit(_prediction_moves)
        cals = [(name, ex.submit(fn, now, now + timedelta(days=7))) for name, fn in calendars]
        for name, f in futs:
            try:
                res = f.result()
                if isinstance(res, tuple):  # (items, errors) from a source with a fallback (India filings)
                    res, errs = res
                    errors += [f"{name}/{e}" for e in errs]
                got += res
            except Exception as e:
                errors.append(f"{name}: {e}")
        try:
            items, errs = moves.result()
            got += items
            errors += [f"prediction markets/{e}" for e in errs]
        except Exception as e:
            errors.append(f"prediction markets: {e}")
        for name, f in cals:
            try:
                upcoming += f.result()
            except Exception as e:
                errors.append(f"{name}: {e}")
    keep = _dedupe(got, cut, load_events())
    upcoming.sort(key=lambda x: x["date"])
    (OUT / "news_candidates.json").write_text(json.dumps({"collected": now.isoformat(), "count": len(keep), "errors": errors, "items": keep, "upcoming": upcoming}, indent=1))
    return keep, errors, upcoming


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=48)
    args = ap.parse_args(argv)
    items, errors, upcoming = collect(args.hours)
    by_topic = {}
    for i, it in enumerate(items):
        by_topic.setdefault(it["topic"], []).append((i, it))
    print(f"{len(items)} new dated headlines from the last {args.hours} h (already-logged ones removed); {len(errors)} feed errors")
    early = {}
    for it in items:
        if it["topic"] in EARLY:
            early[it["feed"]] = early.get(it["feed"], 0) + 1
    print("early sources: " + (", ".join(f"{k} {v}" for k, v in early.items()) or "none new"))
    for t, rows in by_topic.items():
        print(f"\n## {t}")
        for i, it in rows[:18]:
            print(f"[{i}] {it['ts'][:16]} | {it['title'][:140]} | {it['source']}")
    if upcoming:
        print("\n## upcoming releases (next 7 days)")
        for u in upcoming[:25]:
            print(f"{u['date'][:16]} | {u['title'][:100]} | {u['source']}")
    if errors:
        print("\nfeed errors:", "; ".join(errors[:15]))


if __name__ == "__main__":
    main()

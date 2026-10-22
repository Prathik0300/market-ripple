import { redirect } from "next/navigation";
import { signedInUser, supabaseServer } from "@/lib/supabase/server";
import Link from "next/link";
import { NODE_LABELS, areaOf, classOfSymbol, cleanInterests, type Area } from "@/lib/interests";
import { getWorldDocs } from "@/lib/world";

// The main page: what moves the user's areas first (events, news pressure and the model, focus names, fresh facts on
// their own map nodes), then everything else the map tracks. All of it comes from the shared world documents the
// desks read (through the shared Redis cache, so a render costs one profile query); the user's areas only choose and
// order. A research and impact feed, never buy or sell advice. New uploads re-render it live (shell-client.tsx).

type NodeHit = { id: string; dir: number; why?: string };
type Ev = { id: string; ts: string; title: string; summary?: string; scale?: string; url?: string; source?: string; nodes?: NodeHit[] };
type Horizon = { prob_up: number; skill: number; auc: number; has_skill: boolean };
type Sig = { label: string; symbol: string; h5?: Horizon; h20?: Horizon };
type Signals = { updated?: string; pressure?: Record<string, number>; items?: Record<string, Sig>; test_years?: string;
  summary?: Record<"h5" | "h20", { targets: number; with_skill: number } | undefined> };
type FocusItem = { sym: string; name: string; kind: string; market?: string; score: number; dir: number;
  factors?: { f: string; rho: number }[]; events?: { title: string; url?: string; ts: string }[] };
type Side = { up?: FocusItem[]; down?: FocusItem[] };
type Focus = { updated?: string; factors?: Record<string, string>; us?: Side; india?: Side; commodities?: Side; crypto?: Side };
type Fact = { id: string; kind: string; subject?: string; text: string; source?: string; observed: string; url?: string; value?: { date?: string } };
type Facts = { updated?: string; facts?: Fact[] };

const DOCS = ["feed/latest", "signals/latest", "focus/latest", "facts/latest"];
const SHOW = 6;   // rows before "More"
const MAX = 25;   // rows in all

const safe = (u?: string) => (u && /^https?:\/\//.test(u) ? u : null);
const sgn = (v: number, d = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
const label = (id: string) => NODE_LABELS[id] ?? id.replace(/_/g, " ");
function ago(ts: string, now: number) {
  const m = Math.max(0, Math.round((now - Date.parse(ts)) / 6e4));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

// ------------------------------------------------------------------ choosing what belongs to an area
const focusRows = (f: Focus) => (["us", "india", "commodities", "crypto"] as const)
  .flatMap((k) => [...(f[k]?.up ?? []), ...(f[k]?.down ?? [])].map((x) => ({ ...x, section: k })));
type FocusRow = ReturnType<typeof focusRows>[number];

function focusInArea(x: FocusRow, a: Area) {
  if (x.section === "commodities") return a.nodes.has(x.sym) || (x.kind === "fund" && a.classes.has("funds"));
  if (x.section === "crypto") return a.classes.has("crypto");
  // a stock belongs to an area through its class, or when its strongest measured exposure is one of the area's factors
  return a.classes.has(x.section) || a.factors.has(x.factors?.[0]?.f ?? "");
}

// Facts shown on this page: no analyst ratings or price targets (they read as advice), no world events (the news list
// already has them), and earnings dates only for names on the focus list.
const FACT_KINDS = new Set(["official", "filing", "reported_quarter", "market_odds", "weather", "web_fact", "earnings_date"]);
const ADVICE = /\b(buy|sell|target|rating|overweight|underweight|outperform|underperform|upgrade|downgrade)s?\b/i;
const TICKER = /^[A-Z0-9][A-Z0-9.^=&_-]*$/;
const COMPANY_KINDS = new Set(["filing", "reported_quarter", "earnings_date"]);  // their subject is a company, never a coin

function factShown(f: Fact, focusSyms: Set<string>, now: number) {
  if (!FACT_KINDS.has(f.kind) || ADVICE.test(f.text)) return false;
  if (f.kind === "earnings_date") {
    const d = Date.parse(f.value?.date ?? "");
    return focusSyms.has(f.subject ?? "") && d >= now - 864e5 && d <= now + 14 * 864e5;
  }
  return true;
}
function factInArea(f: Fact, a: Area, syms: { all: Set<string>; companies: Set<string> }) {
  const company = COMPANY_KINDS.has(f.kind);
  const named = company ? syms.companies : syms.all;
  return (f.subject ?? "").split(",").some((s) =>
    a.nodes.has(s) || a.tags.has(s) || (TICKER.test(s) && (named.has(s) || a.classes.has(classOfSymbol(s, company)))));
}

// ------------------------------------------------------------------ small pieces
function More({ rows, children }: { rows: number; children: React.ReactNode }) {
  if (rows <= 0) return null;
  return (
    <details className="more">
      <summary>{rows} more</summary>
      <div className="more-body">{children}</div>
    </details>
  );
}

function Push({ v }: { v: number }) {
  return <span className={v > 0 ? "upc" : v < 0 ? "downc" : ""}>{v > 0 ? "pushes up" : v < 0 ? "pushes down" : "no net push"} ({sgn(v)})</span>;
}

function EventRow({ e, now, mine }: { e: Ev; now: number; mine?: Set<string> }) {
  const u = safe(e.url);
  const hits = (e.nodes ?? []).filter((n) => !mine || mine.has(n.id));
  return (
    <div className="frow">
      <div className="ftitle">{u ? <a href={u} target="_blank" rel="noopener noreferrer">{e.title}</a> : e.title}</div>
      <p className="meta">{ago(e.ts, now)}{e.source ? ` · ${e.source}` : ""}{e.scale && e.scale !== "minor" ? ` · ${e.scale}` : ""}</p>
      {hits.length > 0 && (
        <div className="nodes">{hits.slice(0, 4).map((n) => (
          <span key={n.id} className={"chip " + (n.dir > 0 ? "upc" : "downc")} title={n.why}>{label(n.id)} {n.dir > 0 ? "↑" : "↓"}</span>
        ))}</div>
      )}
    </div>
  );
}

function ModelLine({ h, days }: { h?: Horizon; days: number }) {
  if (!h) return null;
  return (
    <p className="small">{days}-day: {Math.round(h.prob_up * 100)}% chance higher ·{" "}
      {h.has_skill
        ? <span className="upc">tested edge on unseen years (skill {sgn(h.skill, 3)}, AUC {h.auc.toFixed(2)})</span>
        : <span>no tested edge (skill {sgn(h.skill, 3)}), so no better than the usual up-rate</span>}
    </p>
  );
}

function SignalRow({ id, sig, pressure }: { id: string; sig?: Sig; pressure?: number }) {
  return (
    <div className="frow">
      <div className="prow"><b>{sig?.label ?? label(id)}</b>{pressure != null && <span className="small">News {<Push v={pressure} />}</span>}</div>
      <ModelLine h={sig?.h5} days={5} />
      <ModelLine h={sig?.h20} days={20} />
    </div>
  );
}

function FocusRowView({ x, now, factorNames }: { x: FocusRow; now: number; factorNames: Record<string, string> }) {
  const ev = x.events?.[0];
  const u = safe(ev?.url);
  const via = (x.factors ?? []).slice(0, 2).map((f) => factorNames[f.f] ?? f.f).join(", ");
  return (
    <div className="frow">
      <div className="prow">
        {x.section === "commodities" ? <b>{x.name}</b> : <b>{x.sym.replace(/\.NS$/, "")} <span className="small muted">{x.name}</span></b>}
        <span className={"chip " + (x.dir > 0 ? "upc" : "downc")}>{x.dir > 0 ? "tailwind" : "headwind"} {sgn(x.score, 0)}</span>
      </div>
      {via && <p className="small">Through {via}</p>}
      {ev && <p className="small">Biggest driver: {u ? <a href={u} target="_blank" rel="noopener noreferrer">{ev.title}</a> : ev.title} ({ago(ev.ts, now)})</p>}
    </div>
  );
}

function FactRow({ f, now }: { f: Fact; now: number }) {
  const u = safe(f.url);
  return (
    <div className="frow">
      <div className="ftitle">{u ? <a href={u} target="_blank" rel="noopener noreferrer">{f.text}</a> : f.text}</div>
      <p className="meta">{f.kind.replace(/_/g, " ")} · {f.source ?? "source not named"} · {ago(f.observed, now)}</p>
    </div>
  );
}

function Card({ title, why, empty, children }: { title: string; why: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="pcard">
      <div className="prow"><h3>{title}</h3>{children.length > 0 && <span className="chip">{children.length}</span>}</div>
      <p className="small why">{why}</p>
      {children.length ? <>{children.slice(0, SHOW)}<More rows={children.length - SHOW}>{children.slice(SHOW)}</More></> : <p className="empty">{empty}</p>}
    </section>
  );
}

// ------------------------------------------------------------------ the page
export default async function Home() {
  const supabase = await supabaseServer();
  const user = await signedInUser(supabase);
  if (!user) redirect("/login");
  const [prof, docs] = await Promise.all([
    supabase.from("profiles").select("interests").eq("id", user.id).maybeSingle(),
    getWorldDocs(supabase, DOCS).catch(() => new Map()),
  ]);
  // not asked yet: onboarding first (when the column is missing, before the migration, show the whole market instead)
  if (!prof.error && prof.data?.interests == null) redirect("/onboarding");
  const ids = cleanInterests(prof.data?.interests);
  const area = areaOf(ids);
  const doc = <T,>(p: string) => (docs.get(p)?.data ?? {}) as T;
  const feed = doc<{ updated?: string; events?: Ev[] }>("feed/latest");
  const signals = doc<Signals>("signals/latest");
  const focus = doc<Focus>("focus/latest");
  const facts = doc<Facts>("facts/latest");
  const now = Date.now();

  // events on the user's nodes, newest first; the rest go below
  const events = (feed.events ?? []).slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const evMine = events.filter((e) => (e.nodes ?? []).some((n) => area.nodes.has(n.id)));
  const evRest = events.filter((e) => !evMine.includes(e));

  // news pressure and the model on the user's nodes: tested edges first, then the strongest push
  const pressure = signals.pressure ?? {};
  const items = signals.items ?? {};
  const edge = (id: string) => (items[id]?.h5?.has_skill || items[id]?.h20?.has_skill ? 1 : 0);
  const order = (a: string, b: string) => edge(b) - edge(a) || Math.abs(pressure[b] ?? 0) - Math.abs(pressure[a] ?? 0);
  const sigIds = [...new Set([...Object.keys(pressure), ...Object.keys(items)])];
  const sigMine = sigIds.filter((id) => area.nodes.has(id)).sort(order);
  const sigRest = sigIds.filter((id) => !area.nodes.has(id)).sort(order);

  // focus names, strongest exposure first
  const rows = focusRows(focus).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const focusMine = rows.filter((x) => focusInArea(x, area));
  const focusRest = rows.filter((x) => !focusMine.includes(x));
  const isCompany = (x: FocusRow) => x.section === "us" || x.section === "india";
  const focusSyms = new Set(rows.filter(isCompany).map((x) => x.sym));
  const mineSyms = { all: new Set(focusMine.map((x) => x.sym)), companies: new Set(focusMine.filter(isCompany).map((x) => x.sym)) };

  const shown = (facts.facts ?? []).filter((f) => factShown(f, focusSyms, now)).sort((a, b) => Date.parse(b.observed) - Date.parse(a.observed));
  const factsMine = shown.filter((f) => factInArea(f, area, mineSyms));
  const factsRest = shown.filter((f) => !factsMine.includes(f));

  const factorNames = focus.factors ?? {};
  const s5 = signals.summary?.h5, s20 = signals.summary?.h20;
  const skillNote = s5 && s20
    ? `Tested on unseen years (${signals.test_years ?? "walk-forward"}), the model has an edge on ${s5.with_skill} of ${s5.targets} targets at 5 days and ${s20.with_skill} of ${s20.targets} at 20 days. Everywhere else its probability is no better than the usual up-rate.`
    : "Each probability is shown with its tested skill on unseen years.";
  const noData = !docs.size;
  const updated = [feed.updated, signals.updated, focus.updated].filter(Boolean).map((t) => Date.parse(t!)).sort((a, b) => b - a)[0];

  return (
    <main className="connect home">
      <div className="home-head">
        <h1>What moves your areas</h1>
        {updated ? <span className="stamp">Data from the run {ago(new Date(updated).toISOString(), now)}</span> : null}
      </div>
      <p className="lead">World events traced through the map to the areas you follow, with what the model has and has not been able to test.
        This is a research and impact feed: it shows what is pushing on markets, not what to buy or sell.</p>
      {noData && <p className="caution">The shared world data has not been uploaded yet. It appears after the next 2-hourly run.</p>}

      {area.picked.length ? (
        <div className="areas">
          {area.picked.map((i) => <span key={i.id} className="chip">{i.label}</span>)}
          <Link href="/settings" className="small">Change</Link>
        </div>
      ) : (
        <p>You have not picked any areas yet, so everything is under Across the market. <Link href="/settings">Pick your areas</Link></p>
      )}
      {area.picked.length > 0 && <h2 className="band">Your areas</h2>}
      {area.picked.length > 0 && (
        <div className="grid2">
          <Card title="News moving your areas" empty="No logged event touched your areas in the feed window."
            why="Events from the last day, kept when the map traces them to one of your areas. Arrows show which way the event pushes that node.">
            {evMine.slice(0, MAX).map((e) => <EventRow key={e.id} e={e} now={now} mine={area.nodes} />)}
          </Card>
          <Card title="News pressure and the model" empty="No signals for your areas yet."
            why={`Net push from recent news on each of your nodes, and the walk-forward model's chance the price is higher. ${skillNote}`}>
            {sigMine.slice(0, MAX).map((id) => <SignalRow key={id} id={id} sig={items[id]} pressure={pressure[id]} />)}
          </Card>
          <Card title="Names most exposed in your areas" empty="No focus names in your areas today."
            why="From the focus list: ranked by how strongly the last 14 days of news reaches each name through its measured exposures. This is exposure to the news, not a forecast.">
            {focusMine.slice(0, MAX).map((x) => <FocusRowView key={x.section + x.sym} x={x} now={now} factorNames={factorNames} />)}
          </Card>
          <Card title="Fresh facts in your areas" empty="No new facts in your areas this week."
            why="From the shared facts store: filings, official releases, reported quarters and other sourced facts from the last 7 days, newest first.">
            {factsMine.slice(0, MAX).map((f) => <FactRow key={f.id} f={f} now={now} />)}
          </Card>
        </div>
      )}

      <h2 className="band">Across the market</h2>
      <p className="small">The general impact view: everything else the map is tracking.</p>
      <div className="grid2">
        <Card title="Latest events" empty="No events logged yet." why="Every logged event from the last day, newest first, with the nodes it pushes.">
          {evRest.slice(0, MAX).map((e) => <EventRow key={e.id} e={e} now={now} />)}
        </Card>
        <Card title="Strongest news pressure" empty="No signals yet."
          why="Nodes where tested model edges exist come first, then the strongest net push from recent news.">
          {sigRest.slice(0, MAX).map((id) => <SignalRow key={id} id={id} sig={items[id]} pressure={pressure[id]} />)}
        </Card>
        <Card title="Most exposed names" empty="The focus list has not been built yet."
          why="The rest of the focus list, across US and Indian stocks, commodities, funds and crypto. Exposure to the news, not a forecast.">
          {focusRest.slice(0, MAX).map((x) => <FocusRowView key={x.section + x.sym} x={x} now={now} factorNames={factorNames} />)}
        </Card>
        <Card title="Other fresh facts" empty="No other facts this week." why="Sourced facts from the last 7 days outside your areas, newest first.">
          {factsRest.slice(0, MAX).map((f) => <FactRow key={f.id} f={f} now={now} />)}
        </Card>
      </div>
      <p className="small muted">Research only. Market Ripple never places or prepares trades and does not give personal buy or sell advice.
        Your areas only change the order of this page; they are never used to train the shared model.</p>
    </main>
  );
}

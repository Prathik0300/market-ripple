import { supabaseServer } from "@/lib/supabase/server";

// Trades from connected platforms, each next to the world events logged within a day of it, and the
// portfolio's biggest gain and loss days with what drove them (from the user's own report).
type Tx = { ts: string; sym: string; side: string; qty: number; price: number | null; ccy: string; connection_id: string };
type Ev = { ts: string; title: string; url: string | null; source: string | null; scale: string | null };
type Day = { d: string; ret: number; spx: number | null; by_holding: [string, number][]; drivers: [string, number][]; events: string[] };

const DAY = 864e5;
const fmt = (ts: string) => new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const money = (v: number | null, ccy: string) => (v == null ? "–" : (ccy === "INR" ? "₹" : ccy === "USD" ? "$" : "") + v.toLocaleString("en-IN", { maximumFractionDigits: v < 1 ? 6 : 2 }));
const safe = (u: string | null) => (u && /^https?:\/\//.test(u) ? u : null);

export default async function Activity() {
  const supabase = await supabaseServer();
  const [{ data: txs }, { data: rep }] = await Promise.all([
    supabase.from("transactions").select("ts, sym, side, qty, price, ccy, connection_id").order("ts", { ascending: false }).limit(300),
    supabase.from("user_reports").select("data").eq("kind", "portfolio").maybeSingle(),
  ]);
  const trades = (txs ?? []) as Tx[];
  let events: Ev[] = [];
  if (trades.length) {
    const lo = new Date(Date.parse(trades[trades.length - 1].ts) - DAY).toISOString();
    const hi = new Date(Date.parse(trades[0].ts) + DAY).toISOString();
    const { data } = await supabase.from("events").select("ts, title, url, source, scale").gte("ts", lo).lte("ts", hi).order("ts").limit(2000);
    events = (data ?? []) as Ev[];
  }
  const near = (ts: string) => events.filter((e) => Math.abs(Date.parse(e.ts) - Date.parse(ts)) <= DAY);
  const days: Day[] = ((rep?.data as { basket?: { days?: Day[] } } | null)?.basket?.days ?? []).slice().sort((a, b) => a.ret - b.ret);
  const losses = days.filter((d) => d.ret < 0), gains = days.filter((d) => d.ret > 0).reverse();

  const DayList = ({ list, title }: { list: Day[]; title: string }) => (
    <section className="pcard">
      <h2>{title}</h2>
      {list.length ? list.map((d) => (
        <div key={d.d} className="actday">
          <div className="prow"><b>{fmt(d.d)}</b><span className={d.ret >= 0 ? "ok" : "err"}>{d.ret > 0 ? "+" : ""}{d.ret.toFixed(1)}%</span></div>
          <p className="small">From {d.by_holding.slice(0, 3).map(([s, v]) => `${s.replace(/-USD$|\.NS$/, "")} ${v > 0 ? "+" : ""}${v.toFixed(1)}%`).join(", ")}
            {d.spx != null ? ` · S&P 500 ${d.spx > 0 ? "+" : ""}${d.spx}%` : ""}</p>
          <p className="small">{d.drivers.length ? "Same-day shocks: " + d.drivers.map(([f, v]) => `${f} ${v > 0 ? "+" : ""}${v}`).join(", ") : "No measured factor shock that day"}
            {d.events.length ? " · " + d.events.join("; ") : ""}</p>
        </div>
      )) : <p>Appears once your connected holdings have a year of prices behind them.</p>}
    </section>
  );

  return (
    <main className="connect">
      <a href="/desk#portfolio" className="small">&larr; Back to your portfolio</a>
      <h1>Trades and the events around them</h1>
      <p className="lead">Your connected platforms&rsquo; trades, each with the world events logged within a day of it, and your portfolio&rsquo;s biggest
        gain and loss days with what moved markets then. This describes what happened; it is not a buy or sell signal.</p>
      <div className="grid2">
        <DayList list={losses} title="Biggest loss days, last year" />
        <DayList list={gains} title="Biggest gain days, last year" />
      </div>
      <section className="pcard">
        <h2>Trades</h2>
        {trades.length ? (
          <div className="tblwrap"><table className="acttbl">
            <thead><tr><th>Date</th><th>Asset</th><th>Side</th><th>Qty</th><th>Price</th><th>World events that day</th></tr></thead>
            <tbody>{trades.map((t, i) => {
              const ev = near(t.ts);
              return (
                <tr key={i}>
                  <td>{fmt(t.ts)}</td><td>{t.sym}</td><td className={t.side === "buy" ? "ok" : "err"}>{t.side}</td>
                  <td>{Number(t.qty).toLocaleString("en-IN", { maximumFractionDigits: 6 })}</td><td>{money(t.price, t.ccy)}</td>
                  <td className="small">{ev.length ? ev.slice(0, 3).map((e, j) => {
                    const u = safe(e.url);
                    return <div key={j}>{u ? <a href={u} target="_blank" rel="noopener noreferrer">{e.title}</a> : e.title}</div>;
                  }) : <span>None logged</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        ) : <p>No trades yet. CoinDCX shares its trade history; Groww&rsquo;s holdings come without past orders for now. Coins bought with an app&rsquo;s simple Buy button often have no trade records.</p>}
        <p className="small">The world-event log starts on 1 October 2026, so older trades show none. For older big days, the lists above use same-day market shocks and the history of major episodes instead.</p>
      </section>
    </main>
  );
}

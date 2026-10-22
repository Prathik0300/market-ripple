"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import s from "./assistant.module.css";

type Turn = { role: "user" | "assistant"; content: string };

const STARTERS = [
  "Which world events this week touch my holdings?",
  "Does the model show any tested skill for what I hold?",
  "What is my portfolio most exposed to?",
  "Summarise the latest on the Strait of Hormuz and what it moves.",
];

const TOOL_LABEL: Record<string, string> = {
  get_dossier: "Reading a research dossier",
  get_focus: "Reading the focus list",
  search_facts: "Searching recent facts",
  search_events: "Searching the event history",
  get_my_connected_data: "Reading your connected data",
};

// A small, safe renderer for the reply: paragraphs, "- " bullets and **bold**. Everything is a text node; no HTML.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b> : part,
  );
}
function Rich({ text }: { text: string }) {
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split("\n").filter((l) => l.trim());
        if (lines.length && lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>)}</ul>;
        }
        const head = /^#{1,4}\s+(.*)$/.exec(b.trim());
        if (head && lines.length === 1) return <h3 key={i}>{inline(head[1])}</h3>;
        return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l.replace(/^#{1,4}\s+/, ""))}</span>)}</p>;
      })}
    </>
  );
}

export default function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (turns.length) end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns, status]);
  useEffect(() => () => abort.current?.abort(), []);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setError("");
    setDraft("");
    const history: Turn[] = [...turns, { role: "user", content: q }];
    setTurns([...history, { role: "assistant", content: "" }]);
    setBusy(true);
    setStatus("Reading your data");
    const ctl = new AbortController();
    abort.current = ctl;
    let answer = "";
    const show = () => setTurns([...history, { role: "assistant", content: answer }]);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ripple": "1" },
        body: JSON.stringify({ messages: history }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `The assistant could not answer (${res.status}).`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as { t: string; v?: string };
          if (ev.t === "text") {
            answer += ev.v ?? "";
            setStatus("");
            show();
          } else if (ev.t === "tool") setStatus(TOOL_LABEL[ev.v ?? ""] ?? "Looking something up");
          else if (ev.t === "error") throw new Error(ev.v);
        }
      }
      if (!answer.trim()) throw new Error("No answer came back. Try asking again.");
    } catch (e) {
      if (ctl.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Something went wrong.");
      // keep the question so it can be asked again; drop the empty reply
      setTurns(answer.trim() ? [...history, { role: "assistant", content: answer }] : turns);
      if (!answer.trim()) setDraft(q);
    } finally {
      setBusy(false);
      setStatus("");
      abort.current = null;
    }
  }

  return (
    <section className={`pcard ${s.chat}`} aria-label="Conversation">
      {turns.length === 0 ? (
        <div className={s.starters}>
          <p>Try one of these, or ask your own:</p>
          <div className={s.chips}>
            {STARTERS.map((q) => <button key={q} type="button" className={s.chip} onClick={() => ask(q)}>{q}</button>)}
          </div>
        </div>
      ) : (
        <div className={s.log} aria-live="polite">
          {turns.map((t, i) => (
            <div key={i} className={t.role === "user" ? s.me : s.bot}>
              {t.role === "user" ? <p>{t.content}</p> : t.content ? <Rich text={t.content} /> : null}
              {t.role === "assistant" && i === turns.length - 1 && busy && (
                <span className={s.status}>{status || "Writing"}<span className={s.dots} aria-hidden>…</span></span>
              )}
            </div>
          ))}
        </div>
      )}
      <div ref={end} />
      {error && <p className="err" role="alert">{error}</p>}
      <form className={s.form} onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
        <textarea
          className={s.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(draft); } }}
          placeholder="Ask about your holdings, today's events or a signal"
          aria-label="Your question"
          maxLength={4000}
          rows={2}
        />
        <div className={s.actions}>
          {turns.length > 0 && !busy && <button type="button" className="quiet" onClick={() => { setTurns([]); setError(""); }}>New chat</button>}
          {busy
            ? <button type="button" className="quiet" onClick={() => abort.current?.abort()}>Stop</button>
            : <button type="submit" disabled={!draft.trim()}>Ask</button>}
        </div>
      </form>
      <p className={`small ${s.note}`}>Research and explanation only. Not buy, sell or hold advice.</p>
    </section>
  );
}

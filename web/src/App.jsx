import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import NOUNS from "./data/nouns.json";
import { Store } from "./lib/db.js";
import {
  emptyCard,
  applyRating,
  RATING,
  RATING_NAME,
  minutesUntilDue,
  isDue,
} from "./lib/scheduler.js";
import { inferRating, Baseline } from "./lib/inference.js";
import { buildQueue, placement, ensureState } from "./lib/session.js";

const ARTICLES = ["der", "die", "das"];
const COLOR = {
  der: { main: "#2D68A8", soft: "#E7EEF6" },
  die: { main: "#B23A48", soft: "#F7E9EB" },
  das: { main: "#2F7D58", soft: "#E6F1EC" },
};
const NEW_PER_SESSION = 12;
const cardById = new Map(NOUNS.map((c) => [c.id, c]));

// CEFR levels present in the content, in order. (B2–C2 are a frequency proxy.)
const ALL_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
// Quick groupings the user can apply with one tap.
const PRESETS = [
  { label: "A1–A2", levels: ["A1", "A2"] },
  { label: "B1–B2", levels: ["B1", "B2"] },
  { label: "C1–C2", levels: ["C1", "C2"] },
  { label: "A1–B2", levels: ["A1", "A2", "B1", "B2"] },
  { label: "All", levels: ALL_LEVELS },
];
const LEVELS_META_KEY = "activeLevels";
const DEFAULT_LEVELS = ["A1"];
// How many cards exist per level (for the selector chips).
const COUNT_BY_LEVEL = NOUNS.reduce((m, c) => ((m[c.level] = (m[c.level] || 0) + 1), m), {});

const sameLevels = (a, b) =>
  a.length === b.length && ALL_LEVELS.every((l) => a.includes(l) === b.includes(l));

// Compact label for the active levels, e.g. ["A1","A2"] -> "A1–A2",
// ["A1","B1"] -> "A1, B1", all six -> "A1–C2", none -> "no levels".
function levelSummary(levels) {
  if (!levels.length) return "no levels";
  const idx = levels.map((l) => ALL_LEVELS.indexOf(l)).sort((a, b) => a - b);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (contiguous && idx.length > 1) return `${ALL_LEVELS[idx[0]]}–${ALL_LEVELS[idx[idx.length - 1]]}`;
  return idx.map((i) => ALL_LEVELS[i]).join(", ");
}

function fmtInterval(days) {
  if (days < 1) {
    const mins = Math.max(1, Math.round(days * 24 * 60));
    return mins < 60 ? `${mins} min` : `${Math.round(days * 24)} h`;
  }
  if (days < 30) return `${Math.round(days)} d`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} y`;
}

// A friendly absolute clock label for a future due time, anchored to "now":
// "today at 3:40 PM", "tomorrow at 8:00 AM", "Thursday at 9:00 AM", "Jul 4 at 9:00 AM".
function fmtWhen(target, now = new Date()) {
  const time = target.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const dayDiff = Math.round((startOfDay(target) - startOfDay(now)) / 86400000);
  if (dayDiff <= 0) return `today at ${time}`;
  if (dayDiff === 1) return `tomorrow at ${time}`;
  if (dayDiff < 7) return `${target.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  return `${target.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

// Soonest upcoming due moment across the active pool, with how many cards land
// by then. Returns null when nothing is scheduled ahead (e.g. no cards seen yet).
function nextDueInfo(activeNouns, statesById, now = new Date()) {
  let soonest = Infinity;
  for (const c of activeNouns) {
    const st = statesById.get(c.id);
    if (!st) continue;
    const t = new Date(st.due).getTime();
    if (t > now.getTime() && t < soonest) soonest = t;
  }
  if (!isFinite(soonest)) return null;
  // Cards due within a short grace window of the soonest one count as "the next batch".
  const batchWindow = 5 * 60 * 1000;
  let count = 0;
  for (const c of activeNouns) {
    const st = statesById.get(c.id);
    if (!st) continue;
    const t = new Date(st.due).getTime();
    if (t > now.getTime() && t <= soonest + batchWindow) count++;
  }
  return {
    rel: fmtInterval((soonest - now.getTime()) / 86400000),
    when: fmtWhen(new Date(soonest), now),
    count,
  };
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [queue, setQueue] = useState([]);
  const [phase, setPhase] = useState("question"); // question | revealed | done
  const [pending, setPending] = useState(null);
  const [colorCoding, setColorCoding] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [showLevels, setShowLevels] = useState(false);
  const [levels, setLevels] = useState(DEFAULT_LEVELS);
  const [stats, setStats] = useState({ answered: 0, correct: 0, graduated: 0, intro: 0 });

  // Content restricted to the active CEFR levels — drives the queue and counts.
  const activeNouns = useMemo(
    () => NOUNS.filter((c) => levels.includes(c.level)),
    [levels],
  );

  const dbRef = useRef(null);
  const statesRef = useRef(new Map()); // id -> fsrs card
  const baselineRef = useRef(new Baseline());
  const shownAt = useRef(0);
  const hiddenDuringQ = useRef(false);

  const currentId = queue[0];
  const card = currentId ? cardById.get(currentId) : null;

  // ---- init: open db, hydrate state + baseline, build first queue ----
  useEffect(() => {
    let alive = true;
    (async () => {
      const db = await Store.open();
      dbRef.current = db;
      const cards = await db.getAllCards();
      const m = new Map();
      cards.forEach((row) => m.set(row.id, row.fsrs));
      statesRef.current = m;
      // seed baseline from recent correct, non-discarded recall times
      const log = await db.getRecentLog(100);
      const recalls = log.filter((e) => e.correct && !e.discarded && e.recall_ms != null).map((e) => e.recall_ms);
      baselineRef.current = new Baseline(undefined, recalls);

      // restore the saved level selection (default A1)
      const saved = await db.getMeta(LEVELS_META_KEY);
      const lv = Array.isArray(saved) && saved.length ? saved.filter((l) => ALL_LEVELS.includes(l)) : DEFAULT_LEVELS;
      const pool = NOUNS.filter((c) => lv.includes(c.level));

      const q = buildQueue(pool, m, NEW_PER_SESSION);
      if (!alive) return;
      setLevels(lv.length ? lv : DEFAULT_LEVELS);
      setQueue(q);
      setStats((s) => ({ ...s, intro: q.length }));
      setReady(true);
    })();
    return () => { alive = false; };
  }, []);

  // ---- timing + distraction tracking ----
  useEffect(() => {
    if (ready && phase === "question" && card) {
      shownAt.current = performance.now();
      hiddenDuringQ.current = false;
    }
  }, [ready, phase, currentId, card]);

  useEffect(() => {
    const onVis = () => { if (document.hidden && phase === "question") hiddenDuringQ.current = true; };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [phase]);

  // ---- answer (single committed tap = the grade) ----
  const answer = useCallback((tapped) => {
    if (phase !== "question" || !card) return;
    const latencyMs = performance.now() - shownAt.current;
    const correct = tapped === card.article;
    const inf = inferRating({
      correct, latencyMs, lemmaLen: card.lemma.length,
      baseline: baselineRef.current.value(), hidden: hiddenDuringQ.current,
    });
    const preState = ensureState(statesRef.current, card.id); // pre-answer FSRS state
    const { card: nextFsrs } = applyRating(preState, inf.rating);
    setPending({
      id: card.id, preState, nextFsrs, tapped, correct, latencyMs,
      rating: inf.rating, recallMs: inf.recallMs, discarded: inf.discarded,
      why: inf.why, overridden: false,
    });
    setPhase("revealed");
  }, [phase, card]);

  // ---- manual override (recompute from pre-answer state) ----
  const override = useCallback((rating) => {
    setPending((p) => {
      if (!p) return p;
      const { card: nextFsrs } = applyRating(p.preState, rating);
      return { ...p, rating, nextFsrs, overridden: true, why: `manual override → ${RATING_NAME[rating]}` };
    });
  }, []);

  // ---- commit: persist state + log, update baseline, requeue/advance ----
  const commit = useCallback(async () => {
    if (!pending) return;
    const p = pending;
    const c = cardById.get(p.id);
    statesRef.current.set(p.id, p.nextFsrs);

    const db = dbRef.current;
    if (db) {
      await db.putCard(p.id, p.nextFsrs);
      await db.appendLog({
        cardId: p.id, lemma: c.lemma, rating: p.rating, correct: p.correct,
        latency_ms: Math.round(p.latencyMs),
        recall_ms: p.recallMs != null ? Math.round(p.recallMs) : null,
        discarded: p.discarded, overridden: p.overridden,
      });
    }
    if (p.correct && !p.discarded && p.recallMs != null) baselineRef.current.push(p.recallMs);

    const rest = queue.slice(1);
    const pl = placement(p.nextFsrs, rest.length);
    if (!pl.graduates) rest.splice(pl.reinsertAt, 0, p.id);

    setStats((st) => ({
      ...st,
      answered: st.answered + 1,
      correct: st.correct + (p.correct ? 1 : 0),
      graduated: st.graduated + (pl.graduates ? 1 : 0),
    }));
    setQueue(rest);
    setPending(null);
    setPhase(rest.length ? "question" : "done");
  }, [pending, queue]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e) => {
      if (phase === "question") {
        const i = ["1", "2", "3"].indexOf(e.key);
        if (i >= 0) { e.preventDefault(); answer(ARTICLES[i]); }
      } else if (phase === "revealed" && (e.key === " " || e.key === "Enter")) {
        e.preventDefault(); commit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, answer, commit]);

  const newSession = () => {
    const q = buildQueue(activeNouns, statesRef.current, NEW_PER_SESSION);
    setQueue(q);
    setStats((s) => ({ ...s, intro: q.length }));
    setPhase(q.length ? "question" : "done");
  };

  // Change the active levels: persist, rebuild the queue from the new pool,
  // and start a fresh session over it. Clearing the inferred-pending state
  // keeps the reveal panel consistent if the user was mid-card.
  const applyLevels = useCallback((next) => {
    const lv = ALL_LEVELS.filter((l) => next.includes(l)); // canonical order, dedup
    if (sameLevels(lv, levels)) return;
    setLevels(lv);
    dbRef.current?.setMeta(LEVELS_META_KEY, lv);
    const pool = NOUNS.filter((c) => lv.includes(c.level));
    const q = buildQueue(pool, statesRef.current, NEW_PER_SESSION);
    setPending(null);
    setQueue(q);
    setStats((s) => ({ ...s, intro: q.length }));
    setPhase("question"); // empty pool falls through to the "nothing due / pick a level" panel
  }, [levels]);

  const toggleLevel = (lvl) =>
    applyLevels(levels.includes(lvl) ? levels.filter((l) => l !== lvl) : [...levels, lvl]);

  const resetAll = async () => {
    if (!window.confirm("Erase all local progress and start over?")) return;
    await dbRef.current?.clearAll();
    statesRef.current = new Map();
    baselineRef.current = new Baseline();
    dbRef.current?.setMeta(LEVELS_META_KEY, levels);
    setStats({ answered: 0, correct: 0, graduated: 0, intro: 0 });
    const q = buildQueue(activeNouns, statesRef.current, NEW_PER_SESSION);
    setQueue(q);
    setStats((s) => ({ ...s, intro: q.length }));
    setPhase("question");
  };

  // counts for the header (scoped to the active levels)
  const now = new Date();
  let dueCount = 0, learned = 0;
  for (const c of activeNouns) {
    const st = statesRef.current.get(c.id);
    if (st) { learned++; if (isDue(st, now)) dueCount++; }
  }
  const acc = stats.answered ? Math.round((stats.correct / stats.answered) * 100) : null;
  const progress = stats.intro ? stats.graduated / stats.intro : 0;
  const nextDue = nextDueInfo(activeNouns, statesRef.current, now);

  if (!ready) return <div className="dq-root"><div className="dq-loading">Loading…</div></div>;

  return (
    <div className="dq-root">
      <div className="dq-shell">
        <header className="dq-head">
          <div className="dq-brand">
            <span className="dq-logo">der<span style={{ color: COLOR.die.main }}>·</span>die<span style={{ color: COLOR.das.main }}>·</span>das</span>
            <span className="dq-sub">{levelSummary(levels)} · article trainer</span>
          </div>
          <div className="dq-head-actions">
            <button className={"dq-pill" + (showLevels ? " on" : "")} onClick={() => { setShowLevels((v) => !v); setShowInfo(false); }} aria-label="Choose levels">{levelSummary(levels)}</button>
            <button className="dq-icon" onClick={() => { setShowInfo((v) => !v); setShowLevels(false); }} aria-label="How grading works">?</button>
          </div>
        </header>

        {showLevels && (
          <div className="dq-levels">
            <div className="dq-levels-row">
              {ALL_LEVELS.map((lvl) => (
                <button
                  key={lvl}
                  className={"dq-lvl" + (levels.includes(lvl) ? " on" : "")}
                  onClick={() => toggleLevel(lvl)}
                >
                  <span className="dq-lvl-name">{lvl}</span>
                  <span className="dq-lvl-count">{COUNT_BY_LEVEL[lvl] || 0}</span>
                </button>
              ))}
            </div>
            <div className="dq-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={"dq-preset" + (sameLevels(p.levels, levels) ? " on" : "")}
                  onClick={() => applyLevels(p.levels)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="dq-levels-note">
              {activeNouns.length} nouns selected. B2–C2 are leveled by word frequency, not an official list.
            </div>
          </div>
        )}

        {showInfo && (
          <div className="dq-info">
            One tap is your answer <em>and</em> your grade. A wrong tap is <b>Again</b>; a correct tap
            becomes <b>Hard / Good / Easy</b> from how fast you recalled, measured against your own
            rolling pace and adjusted for word length. Progress is saved on this device; the override
            row fixes the rare misread.
          </div>
        )}

        <div className="dq-bar"><div className="dq-bar-fill" style={{ width: `${progress * 100}%` }} /></div>
        <div className="dq-meta">
          <span>{learned}/{activeNouns.length} seen</span>
          <span>{dueCount} due</span>
          <span>{acc == null ? "—" : `${acc}%`}</span>
        </div>

        {phase !== "done" && card && (
          <main className="dq-card" key={currentId + "-" + phase}>
            {phase === "question" ? (
              <>
                <div className="dq-prompt-tag">which article?</div>
                <div className="dq-lemma">{card.lemma}</div>
                <div className="dq-gloss">{card.translation}</div>
                <div className="dq-choices">
                  {ARTICLES.map((art, i) => (
                    <button
                      key={art}
                      className="dq-choice"
                      style={colorCoding ? { "--c": COLOR[art].main, "--cs": COLOR[art].soft } : { "--c": "#3a3f45", "--cs": "#eef0f2" }}
                      onClick={() => answer(art)}
                    >
                      <span className="dq-choice-key">{i + 1}</span>
                      {art}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <Reveal card={card} pending={pending} colorCoding={colorCoding}
                      onOverride={override} onContinue={commit} />
            )}
          </main>
        )}

        {phase !== "done" && !card && (
          <main className="dq-card dq-done">
            <div className="dq-done-h">{levels.length ? "You're all caught up" : "Pick a level to start"}</div>
            {levels.length ? (
              <>
                {nextDue && (
                  <div className="dq-next">
                    <span className="dq-next-rel">Next review in ~{nextDue.rel}</span>
                    <span className="dq-next-when">
                      {nextDue.count} card{nextDue.count === 1 ? "" : "s"} due {nextDue.when}
                    </span>
                  </div>
                )}
                <p className="dq-done-note">
                  Every card in {levelSummary(levels)} is scheduled for later — that's the spaced-repetition
                  scheduler spacing them out. {nextDue ? "Come back then," : "Come back when cards are due,"} or
                  add another level to keep studying now.
                </p>
              </>
            ) : (
              <p className="dq-done-note">Choose one or more CEFR levels above to start a session.</p>
            )}
            <button className="dq-primary" onClick={() => setShowLevels(true)}>Choose levels</button>
          </main>
        )}

        {phase === "done" && (
          <main className="dq-card dq-done">
            <div className="dq-done-h">Session complete</div>
            <div className="dq-done-stats">
              <div><b>{stats.intro}</b><span>words</span></div>
              <div><b>{stats.answered}</b><span>taps</span></div>
              <div><b>{acc == null ? "—" : acc + "%"}</b><span>correct</span></div>
            </div>
            {nextDue && (
              <div className="dq-next">
                <span className="dq-next-rel">Next review in ~{nextDue.rel}</span>
                <span className="dq-next-when">
                  {nextDue.count} card{nextDue.count === 1 ? "" : "s"} due {nextDue.when}
                </span>
              </div>
            )}
            <p className="dq-done-note">
              Each word now has its own due date saved on this device. The ones you found hard come back
              first — no manual rating needed.
            </p>
            <button className="dq-primary" onClick={newSession}>Continue studying</button>
          </main>
        )}

        <footer className="dq-foot">
          <label className="dq-toggle">
            <input type="checkbox" checked={colorCoding} onChange={(e) => setColorCoding(e.target.checked)} />
            <span>gender colors</span>
          </label>
          <button className="dq-link" onClick={resetAll}>reset progress</button>
        </footer>
      </div>
    </div>
  );
}

function Reveal({ card, pending, colorCoding, onOverride, onContinue }) {
  const c = colorCoding ? COLOR[card.article] : { main: "#26408A", soft: "#eef0f2" };
  const ratingColor = { [RATING.Again]: "#B23A48", [RATING.Hard]: "#C9772F", [RATING.Good]: "#2F7D58", [RATING.Easy]: "#2D68A8" }[pending.rating];
  const days = (new Date(pending.nextFsrs.due).getTime() - Date.now()) / 86400000;
  return (
    <div className="dq-reveal" onClick={onContinue}>
      <div className="dq-verdict" style={{ color: pending.correct ? "#2F7D58" : "#B23A48" }}>
        {pending.correct ? "correct" : `not quite — you tapped ${pending.tapped}`}
      </div>

      <div className="dq-answer" style={{ "--c": c.main, "--cs": c.soft }}>
        <span className="dq-art">{card.article}</span>
        <span className="dq-noun">{card.lemma}</span>
      </div>
      <div className="dq-plural">{card.plural ? `plural: die ${card.plural}` : "no plural (mass noun)"}</div>
      {card.example && <div className="dq-example">{card.example}</div>}

      <div className="dq-chip">
        <span className="dq-chip-rating" style={{ background: ratingColor }}>{RATING_NAME[pending.rating]}</span>
        <span className="dq-chip-data">
          {Math.round(pending.latencyMs)}ms
          {pending.recallMs != null && !pending.discarded ? ` · recall ${Math.round(pending.recallMs)}ms` : ""}
          {` · next in ${fmtInterval(days)}`}
        </span>
      </div>
      <div className="dq-why">{pending.why}</div>

      <div className="dq-override" onClick={(e) => e.stopPropagation()}>
        <span>override:</span>
        {[RATING.Again, RATING.Hard, RATING.Good, RATING.Easy].map((r) => (
          <button key={r} className={"dq-ov" + (pending.rating === r ? " on" : "")}
                  onClick={() => onOverride(r)}>{RATING_NAME[r]}</button>
        ))}
      </div>

      <button className="dq-primary" onClick={(e) => { e.stopPropagation(); onContinue(); }}>
        Continue <span className="dq-kbd">space</span>
      </button>
    </div>
  );
}

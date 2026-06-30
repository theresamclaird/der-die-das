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
import { buildSession, buildCramQueue, willGraduate, advanceQueue, ensureState } from "./lib/session.js";
import { amplifyConfigured } from "./lib/amplifyConfig.js";
import { SyncEngine, LocalOnlyAdapter } from "./lib/sync.js";
import Auth, { currentUser, logOut } from "./Auth.jsx";

const ARTICLES = ["der", "die", "das"];
// Light mode: saturated hue on a pale tint. Border defaults to the main hue.
const COLOR = {
  der: { main: "#2D68A8", soft: "#E7EEF6", border: "#2D68A8" },
  die: { main: "#B23A48", soft: "#F7E9EB", border: "#B23A48" },
  das: { main: "#2F7D58", soft: "#E6F1EC", border: "#2F7D58" },
};
// Dark mode: light hue text on a dark tinted surface + a mid-tone border, so
// the noun (rendered in --ink) keeps strong contrast on the answer card.
const COLOR_DARK = {
  der: { main: "#8FB4EE", soft: "#1C2C44", border: "#35507C" },
  die: { main: "#E78C97", soft: "#3A2127", border: "#7C3B43" },
  das: { main: "#74BD95", soft: "#1B3429", border: "#356C4F" },
};
// Neutral (gender-colors off), per theme.
const NEUTRAL_LIGHT = { main: "#3a3f45", soft: "#eef0f2", border: "#3a3f45" };
const NEUTRAL_DARK = { main: "#C7CDD4", soft: "#23272E", border: "#39404A" };
const NEW_PER_SESSION = 12;

// Track the OS dark-mode preference reactively so the gender palette can swap.
function usePrefersDark() {
  const mq = () => window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(() => !!(mq() && mq().matches));
  useEffect(() => {
    const m = mq();
    if (!m) return;
    const on = (e) => setDark(e.matches);
    m.addEventListener ? m.addEventListener("change", on) : m.addListener(on);
    return () => (m.removeEventListener ? m.removeEventListener("change", on) : m.removeListener(on));
  }, []);
  return dark;
}
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
  const [cram, setCram] = useState(false); // off-schedule practice mode
  const [authUser, setAuthUser] = useState(null); // {email} when signed in
  const [showAuth, setShowAuth] = useState(false);
  const [sync, setSync] = useState({ state: "idle", at: null, error: null }); // sync status
  const [stateTick, setStateTick] = useState(0); // bump to re-render after sync pulls

  // Gender palette + neutral fallback, chosen from the OS theme.
  const dark = usePrefersDark();
  const GENDER = dark ? COLOR_DARK : COLOR;
  const NEUTRAL = dark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  const swatch = (art) => {
    const p = colorCoding ? GENDER[art] : NEUTRAL;
    return { "--c": p.main, "--cs": p.soft, "--cb": p.border };
  };

  // Content restricted to the active CEFR levels — drives the queue and counts.
  const activeNouns = useMemo(
    () => NOUNS.filter((c) => levels.includes(c.level)),
    [levels],
  );

  const dbRef = useRef(null);
  const statesRef = useRef(new Map()); // id -> fsrs card
  const reserveRef = useRef([]); // unintroduced new cards, fed in as the queue drains (#2)
  const fillerRef = useRef(new Set()); // ids currently in the queue as off-schedule recycled filler (#2)
  const baselineRef = useRef(new Baseline());
  const syncRef = useRef(null); // SyncEngine (created after db opens)
  const shownAt = useRef(0);
  const hiddenDuringQ = useRef(false);

  const currentId = queue[0];
  const card = currentId ? cardById.get(currentId) : null;
  // The current card is off-schedule recycled filler (interleaving only, never
  // graded) when it's in the filler set and we're not in cram (#2).
  const reviewOnly = !cram && currentId != null && fillerRef.current.has(currentId);
  // The shared answer pill tints to the article's gender color only once revealed
  // (and only when color-coding is on); until then it stays neutral.
  const answerColor = card
    ? (phase === "revealed" && colorCoding ? GENDER[card.article] : NEUTRAL)
    : NEUTRAL;

  // Reconcile with the backend (if signed in), then refresh in-memory state from
  // whatever the pull may have changed. Safe to call anytime; no-ops when local.
  const runSync = useCallback(async () => {
    const engine = syncRef.current, db = dbRef.current;
    if (!engine || !db) return;
    setSync((s) => ({ ...s, state: "syncing", error: null }));
    const res = await engine.sync();
    if (res && res.ok) {
      const rows = await db.getAllCards();
      const m = new Map();
      rows.forEach((r) => m.set(r.id, r.fsrs));
      statesRef.current = m;
      setStateTick((t) => t + 1);
      setSync({ state: "ok", at: res.at, error: null });
    } else if (res && res.skipped) {
      setSync((s) => ({ ...s, state: "idle" }));
    } else {
      setSync({ state: "error", at: null, error: (res && res.error) || "sync failed" });
    }
  }, []);

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

      const { queue: q, reserve } = buildSession(pool, m, NEW_PER_SESSION);
      if (!alive) return;
      reserveRef.current = reserve;
      fillerRef.current = new Set();
      setLevels(lv.length ? lv : DEFAULT_LEVELS);
      setQueue(q);
      setStats((s) => ({ ...s, intro: q.length }));
      setReady(true);

      // Sync engine: local-only until a deployed backend AND a sign-in exist.
      syncRef.current = new SyncEngine(db, new LocalOnlyAdapter());
      if (amplifyConfigured) {
        try {
          const { AmplifyAdapter } = await import("./lib/amplifyAdapter.js");
          syncRef.current.setAdapter(new AmplifyAdapter());
          const u = await currentUser();
          if (alive && u) { setAuthUser(u); runSync(); }
        } catch { /* stay local-only */ }
      }
    })();
    return () => { alive = false; };
  }, [runSync]);

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
      why: inf.why, overridden: false, review: reviewOnly,
    });
    setPhase("revealed");
  }, [phase, card, reviewOnly]);

  // ---- manual override (recompute from pre-answer state) ----
  const override = useCallback((rating) => {
    setPending((p) => {
      if (!p) return p;
      const { card: nextFsrs } = applyRating(p.preState, rating);
      return { ...p, rating, nextFsrs, overridden: true, why: `manual override → ${RATING_NAME[rating]}` };
    });
  }, []);

  // Advance the live queue after a card is answered. Off-schedule paths (cram,
  // recycled filler) and the graded path all funnel the answered card + current
  // session state through the pure advanceQueue() helper in session.js (#2), then
  // sync the reserve/filler refs from its result.
  const applyAdvance = useCallback((rest, answered, fsrsCard) => {
    const r = advanceQueue({
      rest, answered, fsrsCard,
      reserve: reserveRef.current, filler: fillerRef.current,
      allCards: activeNouns, stateById: statesRef.current,
    });
    reserveRef.current = r.reserve;
    fillerRef.current = r.filler;
    return r;
  }, [activeNouns]);

  // ---- commit: persist state + log, update baseline, requeue/advance ----
  const commit = useCallback(async () => {
    if (!pending) return;
    const p = pending;
    const c = cardById.get(p.id);

    // Cram is off-schedule practice: it must NOT touch FSRS state, due dates, or
    // the spaced-review baseline (massed-practice timing would skew it). We still
    // log the rep, flagged cram:true, so the raw signals are preserved but can be
    // excluded from scheduler calibration.
    if (cram) {
      if (dbRef.current) {
        await dbRef.current.appendLog({
          cardId: p.id, lemma: c.lemma, rating: p.rating, correct: p.correct,
          latency_ms: Math.round(p.latencyMs),
          recall_ms: p.recallMs != null ? Math.round(p.recallMs) : null,
          discarded: p.discarded, overridden: p.overridden, cram: true,
        });
      }
      const rest = queue.slice(1);
      if (!p.correct) rest.push(p.id); // missed → drill again later this round
      setStats((st) => ({
        ...st,
        answered: st.answered + 1,
        correct: st.correct + (p.correct ? 1 : 0),
        cleared: (st.cleared || 0) + (p.correct ? 1 : 0), // unique cards drilled clean
      }));
      setQueue(rest);
      setPending(null);
      setPhase(rest.length ? "question" : "done");
      return;
    }

    // Off-schedule recycled filler (#2): shown only to break up a struggled card.
    // Like cram, log the rep but never grade, reschedule, or move the baseline.
    // It's flagged `cram: true` so the existing sync path still excludes it from
    // scheduler calibration, plus `filler: true` to distinguish it from a true
    // cram-mode rep. (Forwarding `filler` to the backend is left to the sync
    // layer — see sync.js — and is intentionally not wired here.)
    if (p.review) {
      if (dbRef.current) {
        await dbRef.current.appendLog({
          cardId: p.id, lemma: c.lemma, rating: p.rating, correct: p.correct,
          latency_ms: Math.round(p.latencyMs),
          recall_ms: p.recallMs != null ? Math.round(p.recallMs) : null,
          discarded: p.discarded, overridden: p.overridden, cram: true, filler: true,
        });
      }
      const { queue: next, addedNew } = applyAdvance(queue.slice(1), { id: p.id, stays: false });
      setStats((st) => ({
        ...st,
        answered: st.answered + 1,
        correct: st.correct + (p.correct ? 1 : 0),
        intro: st.intro + addedNew,
      }));
      setQueue(next);
      setPending(null);
      setPhase(next.length ? "question" : "done");
      return;
    }

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

    const graduates = willGraduate(p.nextFsrs);
    const { queue: next, addedNew } = applyAdvance(
      queue.slice(1), { id: p.id, stays: !graduates }, p.nextFsrs,
    );

    setStats((st) => ({
      ...st,
      answered: st.answered + 1,
      correct: st.correct + (p.correct ? 1 : 0),
      graduated: st.graduated + (graduates ? 1 : 0),
      intro: st.intro + addedNew,
    }));
    setQueue(next);
    setPending(null);
    setPhase(next.length ? "question" : "done");
  }, [pending, queue, cram, applyAdvance]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e) => {
      // Don't let card shortcuts fire while a dialog is open or the user is
      // typing into a field (email/password/code), or modifier combos.
      if (showAuth) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (phase === "question") {
        const i = ["1", "2", "3"].indexOf(e.key);
        if (i >= 0) { e.preventDefault(); answer(ARTICLES[i]); }
      } else if (phase === "revealed" && (e.key === " " || e.key === "Enter")) {
        e.preventDefault(); commit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, answer, commit, showAuth]);

  const newSession = () => {
    const { queue: q, reserve } = buildSession(activeNouns, statesRef.current, NEW_PER_SESSION);
    reserveRef.current = reserve;
    fillerRef.current = new Set();
    setQueue(q);
    setStats((s) => ({ ...s, intro: q.length }));
    setPhase(q.length ? "question" : "done");
  };

  // Count of seen cards eligible for cram (drives button enable/label).
  const seenCount = activeNouns.reduce((n, c) => n + (statesRef.current.has(c.id) ? 1 : 0), 0);

  // Off-schedule practice over the seen pool, hardest-first. Read-only re: FSRS.
  const startCram = () => {
    const q = buildCramQueue(activeNouns, statesRef.current);
    if (!q.length) return;
    reserveRef.current = [];
    fillerRef.current = new Set();
    setCram(true);
    setPending(null);
    setQueue(q);
    setStats({ answered: 0, correct: 0, graduated: 0, cleared: 0, intro: q.length });
    setPhase("question");
  };

  // Leave cram and return to the normal scheduled session.
  const exitCram = () => {
    setCram(false);
    setPending(null);
    newSession();
  };

  // ---- auth / sync controls ----
  const onAuthed = (u) => { setAuthUser(u); setShowAuth(false); runSync(); };
  const doSignOut = async () => {
    await logOut();
    setAuthUser(null);
    setSync({ state: "idle", at: null, error: null });
  };
  // Opportunistic sync when connectivity returns (signed-in only).
  useEffect(() => {
    if (!authUser) return;
    const on = () => runSync();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [authUser, runSync]);

  // Change the active levels: persist, rebuild the queue from the new pool,
  // and start a fresh session over it. Clearing the inferred-pending state
  // keeps the reveal panel consistent if the user was mid-card.
  const applyLevels = useCallback((next) => {
    const lv = ALL_LEVELS.filter((l) => next.includes(l)); // canonical order, dedup
    if (sameLevels(lv, levels)) return;
    setLevels(lv);
    dbRef.current?.setMeta(LEVELS_META_KEY, lv);
    const pool = NOUNS.filter((c) => lv.includes(c.level));
    const { queue: q, reserve } = buildSession(pool, statesRef.current, NEW_PER_SESSION);
    reserveRef.current = reserve;
    fillerRef.current = new Set();
    setCram(false); // changing levels leaves cram
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
    setCram(false);
    setStats({ answered: 0, correct: 0, graduated: 0, intro: 0 });
    const { queue: q, reserve } = buildSession(activeNouns, statesRef.current, NEW_PER_SESSION);
    reserveRef.current = reserve;
    fillerRef.current = new Set();
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
  const progress = stats.intro
    ? Math.min(1, (cram ? (stats.cleared || 0) : stats.graduated) / stats.intro)
    : 0;
  const nextDue = nextDueInfo(activeNouns, statesRef.current, now);

  if (!ready) return <div className="dq-root"><div className="dq-loading">Loading…</div></div>;

  return (
    <div className="dq-root">
      <div className="dq-shell">
        <header className="dq-head">
          <div className="dq-brand">
            <span className="dq-logo">der<span style={{ color: GENDER.die.main }}>·</span>die<span style={{ color: GENDER.das.main }}>·</span>das</span>
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

        {cram && (
          <div className="dq-cram-banner">
            <span><b>Practice mode</b> · off-schedule, won't change your due dates</span>
            <button className="dq-cram-exit" onClick={exitCram}>exit</button>
          </div>
        )}

        <div className="dq-bar"><div className={"dq-bar-fill" + (cram ? " cram" : "")} style={{ width: `${progress * 100}%` }} /></div>
        <div className="dq-meta">
          <span>{learned}/{activeNouns.length} seen</span>
          <span>{cram ? `${queue.length} left` : `${dueCount} due`}</span>
          <span>{acc == null ? "—" : `${acc}%`}</span>
        </div>

        {phase !== "done" && card && (
          // Keyed on the card id only (not the phase) so the question→reveal
          // transition mutates in place instead of remounting — that's what keeps
          // the noun fixed while the article and the lower panel cross-fade.
          <main className={"dq-card dq-trainer dq-" + phase} key={currentId}>
            {/* Verdict mark in the top-right corner (absolutely positioned, so it
                never shifts the noun): a green check when correct, a red ✕ when not. */}
            {phase === "revealed" && pending && (
              <div className={"dq-mark " + (pending.correct ? "dq-mark-ok" : "dq-mark-no")}
                   aria-label={pending.correct ? "correct" : `incorrect — you tapped ${pending.tapped}`}>
                {pending.correct ? "✓" : "✕"}
              </div>
            )}

            {/* Shared answer pill, identical in both phases: the underscores fade
                out as the real article fades in, and the noun never moves. */}
            <div className="dq-answer" style={{ "--c": answerColor.main, "--cs": answerColor.soft }}>
              <span className="dq-art">
                <span className="dq-art-ph">___</span>
                <span className="dq-art-real">{card.article}</span>
              </span>
              <span className="dq-noun">{card.lemma}</span>
            </div>

            {/* Lower panel: the article buttons on the question, the reveal detail
                on the answer — cross-faded so only this region changes. */}
            {phase === "question" ? (
              <div className="dq-choices">
                {ARTICLES.map((art, i) => (
                  <button
                    key={art}
                    className="dq-choice"
                    style={swatch(art)}
                    onClick={() => answer(art)}
                  >
                    <span className="dq-choice-key">{i + 1}</span>
                    {art}
                  </button>
                ))}
              </div>
            ) : (
              <Reveal card={card} pending={pending} cram={cram} review={reviewOnly}
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
                  practice off-schedule below.
                </p>
              </>
            ) : (
              <p className="dq-done-note">Choose one or more CEFR levels above to start a session.</p>
            )}
            {levels.length > 0 && seenCount > 0 && (
              <button className="dq-primary" onClick={startCram}>Practice anyway ({seenCount})</button>
            )}
            <button className="dq-secondary" onClick={() => setShowLevels(true)}>Choose levels</button>
          </main>
        )}

        {phase === "done" && cram && (
          <main className="dq-card dq-done">
            <div className="dq-done-h">Practice round done</div>
            <div className="dq-done-stats">
              <div><b>{stats.intro}</b><span>words</span></div>
              <div><b>{stats.answered}</b><span>taps</span></div>
              <div><b>{acc == null ? "—" : acc + "%"}</b><span>correct</span></div>
            </div>
            <p className="dq-done-note">
              Off-schedule practice — your due dates are untouched, so your real review schedule is exactly
              where you left it.
            </p>
            <button className="dq-primary" onClick={startCram}>Go again</button>
            <button className="dq-secondary" onClick={exitCram}>Back to review</button>
          </main>
        )}

        {phase === "done" && !cram && (
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
            {seenCount > 0 && (
              <button className="dq-secondary" onClick={startCram}>Practice anyway</button>
            )}
          </main>
        )}

        {amplifyConfigured && (
          <div className="dq-account">
            {authUser ? (
              <>
                <span className="dq-acct-email" title={authUser.email}>{authUser.email}</span>
                <span className={"dq-sync dq-sync-" + sync.state}>
                  {sync.state === "syncing" ? "syncing…"
                    : sync.state === "error" ? "sync failed"
                    : sync.at ? `synced ${new Date(sync.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : "not synced yet"}
                </span>
                <button className="dq-link" onClick={runSync} disabled={sync.state === "syncing"}>sync now</button>
                <button className="dq-link" onClick={doSignOut}>sign out</button>
              </>
            ) : (
              <button className="dq-link dq-signin" onClick={() => setShowAuth(true)}>Sign in to sync across devices</button>
            )}
          </div>
        )}

        <footer className="dq-foot">
          <label className="dq-toggle">
            <input type="checkbox" checked={colorCoding} onChange={(e) => setColorCoding(e.target.checked)} />
            <span>gender colors</span>
          </label>
          <button className="dq-link" onClick={resetAll}>reset progress</button>
        </footer>
      </div>

      {showAuth && <Auth onAuthed={onAuthed} onClose={() => setShowAuth(false)} />}
    </div>
  );
}

function Reveal({ card, pending, cram, review, onOverride, onContinue }) {
  const ratingColor = { [RATING.Again]: "#B23A48", [RATING.Hard]: "#C9772F", [RATING.Good]: "#2F7D58", [RATING.Easy]: "#2D68A8" }[pending.rating];
  const days = (new Date(pending.nextFsrs.due).getTime() - Date.now()) / 86400000;
  // Cram and recycled filler are both off-schedule: no rating applied, no due
  // date change — show raw timing only, never an FSRS interval or override.
  const offSchedule = cram || review;
  // The verdict and the article+noun pill are rendered by the shared card so they
  // stay put across the question→reveal transition; this panel is everything that
  // fades in beneath them.
  return (
    <div className="dq-reveal" onClick={onContinue}>
      {card.translation && (
        <div className="dq-gloss">English: {card.gloss_def === false ? "" : "the "}{card.translation}</div>
      )}
      <div className="dq-plural">{card.plural ? `plural: die ${card.plural}` : "no plural (mass noun)"}</div>
      {card.example && <div className="dq-example">{card.example}</div>}

      {offSchedule ? (
        /* Off-schedule: no rating is applied and no due date changes, so we show
           only the raw timing — not an FSRS interval or the override controls.
           A recycled-filler card (review) is shown once and does not re-drill. */
        <div className="dq-chip">
          <span className="dq-chip-data">
            {Math.round(pending.latencyMs)}ms
            {pending.recallMs != null && !pending.discarded ? ` · recall ${Math.round(pending.recallMs)}ms` : ""}
            {pending.correct ? "" : (cram ? " · missed — will re-show this round" : " · missed")}
            {review ? " · review only" : ""}
          </span>
        </div>
      ) : (
        <>
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
        </>
      )}

      <button className="dq-primary" onClick={(e) => { e.stopPropagation(); onContinue(); }}>
        Continue <span className="dq-kbd">space</span>
      </button>
    </div>
  );
}

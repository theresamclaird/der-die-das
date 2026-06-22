import { useState, useEffect, useRef, useCallback } from "react";
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

function fmtInterval(days) {
  if (days < 1) {
    const mins = Math.max(1, Math.round(days * 24 * 60));
    return mins < 60 ? `${mins} min` : `${Math.round(days * 24)} h`;
  }
  if (days < 30) return `${Math.round(days)} d`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} y`;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [queue, setQueue] = useState([]);
  const [phase, setPhase] = useState("question"); // question | revealed | done
  const [pending, setPending] = useState(null);
  const [colorCoding, setColorCoding] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [stats, setStats] = useState({ answered: 0, correct: 0, graduated: 0, intro: 0 });

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

      const q = buildQueue(NOUNS, m, NEW_PER_SESSION);
      if (!alive) return;
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
    const q = buildQueue(NOUNS, statesRef.current, NEW_PER_SESSION);
    setQueue(q);
    setStats((s) => ({ ...s, intro: q.length }));
    setPhase(q.length ? "question" : "done");
  };

  const resetAll = async () => {
    if (!window.confirm("Erase all local progress and start over?")) return;
    await dbRef.current?.clearAll();
    statesRef.current = new Map();
    baselineRef.current = new Baseline();
    setStats({ answered: 0, correct: 0, graduated: 0, intro: 0 });
    const q = buildQueue(NOUNS, statesRef.current, NEW_PER_SESSION);
    setQueue(q);
    setStats((s) => ({ ...s, intro: q.length }));
    setPhase("question");
  };

  // counts for the header
  const now = new Date();
  let dueCount = 0, learned = 0;
  for (const c of NOUNS) {
    const st = statesRef.current.get(c.id);
    if (st) { learned++; if (isDue(st, now)) dueCount++; }
  }
  const acc = stats.answered ? Math.round((stats.correct / stats.answered) * 100) : null;
  const progress = stats.intro ? stats.graduated / stats.intro : 0;

  if (!ready) return <div className="dq-root"><div className="dq-loading">Loading…</div></div>;

  return (
    <div className="dq-root">
      <div className="dq-shell">
        <header className="dq-head">
          <div className="dq-brand">
            <span className="dq-logo">der<span style={{ color: COLOR.die.main }}>·</span>die<span style={{ color: COLOR.das.main }}>·</span>das</span>
            <span className="dq-sub">A1 · article trainer</span>
          </div>
          <button className="dq-icon" onClick={() => setShowInfo((v) => !v)} aria-label="How grading works">?</button>
        </header>

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
          <span>{learned}/{NOUNS.length} seen</span>
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

        {phase === "done" && (
          <main className="dq-card dq-done">
            <div className="dq-done-h">Session complete</div>
            <div className="dq-done-stats">
              <div><b>{stats.intro}</b><span>words</span></div>
              <div><b>{stats.answered}</b><span>taps</span></div>
              <div><b>{acc == null ? "—" : acc + "%"}</b><span>correct</span></div>
            </div>
            <p className="dq-done-note">
              Each word now has its own FSRS due date saved on this device. Come back later and the
              ones you found hard will be due first — no manual rating needed.
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

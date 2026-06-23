// sync.js — backend-agnostic sync engine (DESIGN §5, §6; Phase 1).
//
// Local-first: the engine and content run entirely client-side, so a full
// review works offline. This module reconciles the local IndexedDB state with a
// remote store *when* one is available and the user is signed in. It never sits
// on the critical path of a review — App writes to IndexedDB synchronously and
// calls sync() opportunistically (on sign-in, app open, regained connectivity).
//
// The engine talks to an *adapter* (see amplifyAdapter.js) implementing:
//   isReady(): Promise<boolean>
//   listCardStates(): Promise<[{cardId, fsrs, lastReview}]>
//   upsertCardState({cardId, fsrs, due, lastReview}): Promise<void>
//   createReviewLogs(entries[]): Promise<void>
// Swapping backends means writing a new adapter — nothing else changes.

const META_INITIALIZED = "sync.initialized";   // has the first full push happened
const META_LOG_CURSOR = "sync.lastPushedSeq";   // highest log seq pushed
const META_LAST_SYNC = "sync.lastSyncAt";       // ISO of last successful sync

// Milliseconds of the FSRS card's last review (0 if never reviewed / unknown).
function lastReviewMs(fsrs) {
  const lr = fsrs && fsrs.last_review;
  return lr ? new Date(lr).getTime() : 0;
}
function dueIso(fsrs) {
  return fsrs && fsrs.due ? new Date(fsrs.due).toISOString() : null;
}
// Remote FSRS blobs arrive as JSON, so Date fields are ISO strings. Rehydrate
// them to Date objects to match locally-stored cards (and what ts-fsrs expects).
function rehydrate(fsrs) {
  const f = { ...fsrs };
  if (f.due) f.due = new Date(f.due);
  if (f.last_review) f.last_review = new Date(f.last_review);
  return f;
}

// A no-op adapter: the logged-out / not-deployed state. Keeps callers simple.
export class LocalOnlyAdapter {
  async isReady() { return false; }
  async listCardStates() { return []; }
  async upsertCardState() {}
  async createReviewLogs() {}
}

export class SyncEngine {
  constructor(store, adapter) {
    this.store = store;
    this.adapter = adapter;
    this._running = false;
  }

  setAdapter(adapter) { this.adapter = adapter; }

  // Reconcile local <-> remote. Returns a small summary, or {skipped:true} when
  // there's no backend / nobody signed in. Never throws into the UI: callers
  // can await it and surface errors via the returned object.
  async sync() {
    if (this._running) return { skipped: true, reason: "busy" };
    if (!(await this.adapter.isReady())) return { skipped: true, reason: "offline" };
    this._running = true;
    try {
      const pulled = await this._pull();
      const pushed = await this._push();
      const at = new Date().toISOString();
      await this.store.setMeta(META_LAST_SYNC, at);
      return { ok: true, at, ...pulled, ...pushed };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    } finally {
      this._running = false;
    }
  }

  // Pull remote card states; adopt any that are newer than local
  // (last-write-wins on the FSRS last_review timestamp).
  async _pull() {
    const remote = await this.adapter.listCardStates();
    const localRows = await this.store.getAllCards();
    const localById = new Map(localRows.map((r) => [r.id, r]));
    let adopted = 0;
    for (const r of remote) {
      if (!r || !r.cardId || !r.fsrs) continue;
      const local = localById.get(r.cardId);
      const remoteMs = lastReviewMs(r.fsrs);
      const localMs = local ? lastReviewMs(local.fsrs) : -1;
      if (remoteMs > localMs) {
        await this.store.putCardRemote(r.cardId, rehydrate(r.fsrs));
        adopted++;
      }
    }
    return { pulled: adopted };
  }

  // Push local changes. First sync pushes ALL local cards (covers a user who
  // studied offline before signing in); subsequent syncs push only the dirty
  // set. The review log is pushed by an append-only cursor.
  async _push() {
    const initialized = await this.store.getMeta(META_INITIALIZED);

    let cardIds;
    if (initialized) {
      cardIds = await this.store.getDirtyCardIds();
    } else {
      cardIds = (await this.store.getAllCards()).map((r) => r.id);
    }

    if (cardIds.length) {
      const rows = await this.store.getAllCards();
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of cardIds) {
        const row = byId.get(id);
        if (!row || !row.fsrs) continue;
        await this.adapter.upsertCardState({
          cardId: id,
          fsrs: row.fsrs,
          due: dueIso(row.fsrs),
          lastReview: row.fsrs.last_review ? new Date(row.fsrs.last_review).toISOString() : null,
        });
      }
      await this.store.clearDirty(cardIds);
    }
    if (!initialized) await this.store.setMeta(META_INITIALIZED, true);

    // Append-only log push, by cursor.
    const since = (await this.store.getMeta(META_LOG_CURSOR)) || 0;
    const rows = await this.store.getLogSince(since);
    if (rows.length) {
      const entries = rows.map((e) => ({
        clientSeq: e.seq,
        cardId: e.cardId,
        lemma: e.lemma ?? null,
        rating: e.rating ?? null,
        correct: e.correct ?? null,
        latency_ms: e.latency_ms ?? null,
        recall_ms: e.recall_ms ?? null,
        discarded: e.discarded ?? null,
        overridden: e.overridden ?? null,
        cram: e.cram ?? false,
        ts: e.ts ? new Date(e.ts).toISOString() : new Date().toISOString(),
      }));
      await this.adapter.createReviewLogs(entries);
      const maxSeq = rows.reduce((m, e) => Math.max(m, e.seq), since);
      await this.store.setMeta(META_LOG_CURSOR, maxSeq);
    }

    return { pushed: cardIds.length, logged: rows.length };
  }
}

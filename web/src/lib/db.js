// db.js — local-first persistence (DESIGN §5, §6). Dependency-free promise
// wrapper over IndexedDB. Three stores:
//   cards : { id, fsrs }                 → per-card FSRS state (the schedule)
//   log   : auto-id review records       → append-only raw-signal log (§4.5)
//   meta  : { key, value }               → settings / baseline seed
//
// FSRS card objects contain Date fields; IndexedDB uses structured clone, so
// Dates round-trip natively (no JSON serialization needed).

const DB_NAME = "der-die-das";
// v2 adds the `dirty` store: card ids changed locally and awaiting push (Phase 1
// sync). The store is intentionally just keys — the card body lives in `cards`.
const DB_VERSION = 2;

// iOS Safari occasionally fires neither `success` nor `error` on the first
// indexedDB.open() after a page reload, leaving the app hung on "Loading…" with
// no recovery short of clearing site data (issue #12). Guard every open with a
// short timeout: re-issue a fresh open() a few times, then surface a real error
// so the UI can show a retry instead of spinning forever.
const OPEN_TIMEOUT_MS = 500;
const OPEN_RETRIES = 4;

function openDB(attempt = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("log")) db.createObjectStore("log", { keyPath: "seq", autoIncrement: true });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("dirty")) db.createObjectStore("dirty", { keyPath: "id" });
    };
    req.onsuccess = () => finish(resolve, req.result);
    req.onerror = () => finish(reject, req.error);
    req.onblocked = () => {}; // an older connection is open; it will close and we'll proceed
    timer = setTimeout(() => {
      if (settled) return;
      if (attempt < OPEN_RETRIES) {
        // Abandon the stuck request; a fresh open() almost always settles.
        settled = true;
        resolve(openDB(attempt + 1));
      } else {
        finish(reject, new Error("IndexedDB open timed out"));
      }
    }, OPEN_TIMEOUT_MS);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const result = fn(s);
    t.oncomplete = () => resolve(result?.__value ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqValue(request) {
  // helper so tx() can resolve with an async request's result
  const box = { __value: undefined };
  request.onsuccess = () => (box.__value = request.result);
  return box;
}

export class Store {
  constructor(db) {
    this.db = db;
  }
  static async open() {
    return new Store(await openDB());
  }

  // --- card FSRS state ---
  getAllCards() {
    return tx(this.db, "cards", "readonly", (s) => reqValue(s.getAll()));
  }
  // Local write (a review) — marks the card dirty so sync will push it.
  async putCard(id, fsrs) {
    await tx(this.db, "cards", "readwrite", (s) => s.put({ id, fsrs, updated: new Date() }));
    await tx(this.db, "dirty", "readwrite", (s) => s.put({ id }));
  }
  // Remote write (sync pull) — does NOT mark dirty, so a pulled state is not
  // immediately bounced back to the server.
  putCardRemote(id, fsrs) {
    return tx(this.db, "cards", "readwrite", (s) => s.put({ id, fsrs, updated: new Date() }));
  }

  // --- dirty set (cards changed locally, awaiting push) ---
  getDirtyCardIds() {
    return tx(this.db, "dirty", "readonly", (s) => reqValue(s.getAllKeys()));
  }
  clearDirty(ids) {
    return tx(this.db, "dirty", "readwrite", (s) => { ids.forEach((id) => s.delete(id)); });
  }

  // --- append-only review log ---
  appendLog(entry) {
    return tx(this.db, "log", "readwrite", (s) => s.add({ ...entry, ts: new Date() }));
  }
  getRecentLog(limit = 200) {
    return tx(this.db, "log", "readonly", (s) => reqValue(s.getAll())).then((all) =>
      all.slice(-limit),
    );
  }
  // Log rows with autoincrement seq strictly greater than `since` (push cursor).
  getLogSince(since = 0) {
    return tx(this.db, "log", "readonly", (s) => reqValue(s.getAll())).then((all) =>
      all.filter((e) => e.seq > since),
    );
  }

  // --- meta key/value ---
  getMeta(key) {
    return tx(this.db, "meta", "readonly", (s) => reqValue(s.get(key))).then((r) => (r ? r.value : undefined));
  }
  setMeta(key, value) {
    return tx(this.db, "meta", "readwrite", (s) => s.put({ key, value }));
  }

  // --- danger: wipe (used by the Reset control) ---
  clearAll() {
    return Promise.all([
      tx(this.db, "cards", "readwrite", (s) => s.clear()),
      tx(this.db, "log", "readwrite", (s) => s.clear()),
      tx(this.db, "meta", "readwrite", (s) => s.clear()),
      tx(this.db, "dirty", "readwrite", (s) => s.clear()),
    ]);
  }
}

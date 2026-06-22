// db.js — local-first persistence (DESIGN §5, §6). Dependency-free promise
// wrapper over IndexedDB. Three stores:
//   cards : { id, fsrs }                 → per-card FSRS state (the schedule)
//   log   : auto-id review records       → append-only raw-signal log (§4.5)
//   meta  : { key, value }               → settings / baseline seed
//
// FSRS card objects contain Date fields; IndexedDB uses structured clone, so
// Dates round-trip natively (no JSON serialization needed).

const DB_NAME = "der-die-das";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("log")) db.createObjectStore("log", { keyPath: "seq", autoIncrement: true });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
  putCard(id, fsrs) {
    return tx(this.db, "cards", "readwrite", (s) => s.put({ id, fsrs, updated: new Date() }));
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
    ]);
  }
}

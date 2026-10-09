/* Chameleon — IndexedDB staging store for home → convert handoff.
   File/Blob objects cannot travel via URL or sessionStorage, so the home
   page stages them here and navigates to convert.html?staged=1&target=webp.
   The convert page reads (and clears) them. Falls back to an in-memory
   map when IndexedDB is unavailable (private mode) — handoff then only
   works without a reload, which we surface honestly. */

const DB = "chameleon";
const TABLE = "staging";
const VERSION = 1;

let memFallback = new Map();
let memMode = false;

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      memMode = true;
      reject(new Error("no-indexeddb"));
      return;
    }
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TABLE)) db.createObjectStore(TABLE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      memMode = true;
      reject(req.error || new Error("idb-open-failed"));
    };
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let store;
    try {
      store = db.transaction(TABLE, mode).objectStore(TABLE);
    } catch (err) {
      reject(err);
      return;
    }
    fn(store, resolve, reject);
  });
}

/** Stage files for handoff. Returns { ids, memoryOnly }. */
export async function putStaged(entries, target) {
  // entries: [{ file: File|Blob, name, size, type }]
  const ids = entries.map(
    (_, i) => "s" + Date.now().toString(36) + "-" + i + "-" + Math.random().toString(36).slice(2, 7)
  );
  try {
    const db = await openDb();
    await tx(db, "readwrite", (store, resolve, reject) => {
      // Clear previous staging first so convert page never mixes sessions.
      const clear = store.clear();
      clear.onsuccess = () => {
        let pending = entries.length;
        if (pending === 0) {
          resolve();
          return;
        }
        entries.forEach((e, i) => {
          const put = store.put(
            { id: ids[i], blob: e.file, name: e.name, size: e.size, type: e.type, target, ts: Date.now() },
            ids[i]
          );
          put.onsuccess = () => {
            if (--pending === 0) resolve();
          };
          put.onerror = () => reject(put.error || new Error("idb-put-failed"));
        });
      };
      clear.onerror = () => reject(clear.error || new Error("idb-clear-failed"));
    });
    try {
      sessionStorage.setItem("chameleon:staged-target", target);
      sessionStorage.setItem("chameleon:staged-ids", JSON.stringify(ids));
    } catch {
      // ignore — IndexedDB is the source of truth
    }
    db.close();
    return { ids, memoryOnly: false };
  } catch {
    memMode = true;
    memFallback = new Map(entries.map((e, i) => [ids[i], { ...e, id: ids[i], target, ts: Date.now() }]));
    return { ids, memoryOnly: true };
  }
}

/** Read staged entries. Returns [] when nothing staged. */
export async function getStaged() {
  if (memMode && memFallback.size) return [...memFallback.values()];
  try {
    const db = await openDb();
    const rows = await tx(db, "readonly", (store, resolve, reject) => {
      const out = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          resolve(out);
          return;
        }
        out.push(c.value);
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error || new Error("idb-read-failed"));
    });
    db.close();
    rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return rows;
  } catch {
    return [...memFallback.values()];
  }
}

export async function clearStaged() {
  memFallback = new Map();
  try {
    sessionStorage.removeItem("chameleon:staged-target");
    sessionStorage.removeItem("chameleon:staged-ids");
  } catch {
    // ignore
  }
  try {
    const db = await openDb();
    await tx(db, "readwrite", (store, resolve, reject) => {
      const r = store.clear();
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error || new Error("idb-clear-failed"));
    });
    db.close();
  } catch {
    // memory fallback already cleared
  }
}

export function stagedTargetFallback() {
  try {
    return sessionStorage.getItem("chameleon:staged-target") || "";
  } catch {
    return "";
  }
}

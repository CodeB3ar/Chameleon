/* Chameleon — recent-files history (shell build).
   Persists file *metadata* in localStorage (cap 10, newest first) so entries
   survive reloads. Live File objects cannot persist, so an entry offers a
   live link only while its file is still in the session queue — everything
   else is honestly marked expired. */

const KEY = "chameleon:history-v1";
const MAX = 10;

export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function store(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Storage unavailable (private mode) — history lives for this session only.
  }
}

export function pushHistory(entry) {
  const list = loadHistory();
  list.unshift({ state: "queued", ...entry, ts: Date.now() });
  store(list);
  return list;
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  return [];
}

export function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

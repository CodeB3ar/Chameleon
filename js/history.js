/* Chameleon — recent-files history.
   Persists file *metadata* in localStorage (cap 10, newest first).
   Live File objects cannot persist, so entries are metadata-only. */

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
    // private mode — history lives for this session only
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

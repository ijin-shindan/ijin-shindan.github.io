// Read/validation and the single storage write belong to the caller. This
// reducer only applies the ordered meet() transitions to a validated snapshot.
// isFree must return a boolean for every ID, including unknown IDs (false).
const DISCOVER_SRC = new Set(["me", "friend_diag"]);

export function applyZukanBatch(zukan, entries, isFree) {
  const next = Object.fromEntries(Object.entries(zukan).map(([id, record]) => [
    id,
    { ...record, ...(record.sources === undefined ? {} : { sources: [...record.sources] }) },
  ]));

  for (const entry of entries) {
    const { id, src, at } = entry ?? {};
    if (typeof id !== "string" || !id || typeof src !== "string" || !src
      || !Number.isFinite(at)) continue;
    const eligible = isFree(id);
    if (typeof eligible !== "boolean") throw new TypeError("isFree must return a boolean");
    if (!eligible) continue;

    const cur = next[id];
    const prevSources = cur?.sources ?? (cur ? [cur.src] : []);
    const sources = prevSources.includes(src) ? [...prevSources] : [...prevSources, src];
    const discovering = DISCOVER_SRC.has(src);
    const wasDiscovered = cur && DISCOVER_SRC.has(cur.src);

    if (!cur || discovering || !wasDiscovered) {
      next[id] = { src: discovering ? src : (wasDiscovered ? cur.src : src), sources, at };
    } else {
      next[id] = { ...cur, sources };
    }
  }

  return next;
}

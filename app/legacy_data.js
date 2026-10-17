// 旧版で「受け取った結果を自分の結果へ保存」した端末の非破壊移行。
// 元の記録は legacy.* に保存し、表示上は受信結果へ分ける。
export function separateLegacyLinkedResults(store, engines, validCode, hasFigure) {
  const oldFriends = store.get("friends", []);
  let friends = Array.isArray(oldFriends) ? [...oldFriends] : [];
  const oldSeen = store.get("seen_results", []);
  const seen = new Set(Array.isArray(oldSeen) ? oldSeen : []);
  let changed = false;
  for (const mode of ["normal", "love"]) {
    for (const slot of ["me.", "me.prev."]) {
      const key = slot + mode;
      const result = store.get(key);
      if (!result || result.via !== "link") continue;
      const backupKey = "legacy.linked." + key;
      store.set(backupKey, result);
      // 容量不足などで保存に失敗したら、元の記録を消さない。
      if (JSON.stringify(store.get(backupKey)) !== JSON.stringify(result)) continue;
      if (validCode(engines[mode], result.code) && hasFigure(result.fig) &&
          !friends.some((f) => f.mode === mode && f.code === result.code)) {
        const next = [{ mode, code: result.code, fig: result.fig, at: result.at || Date.now() }, ...friends];
        store.set("friends", next);
        if (JSON.stringify(store.get("friends")) !== JSON.stringify(next)) continue;
        friends = next;
      }
      store.del(key);
      changed = changed || !store.get(key);
    }
    if (!store.get("me." + mode)) {
      const previous = store.get("me.prev." + mode);
      if (previous && !previous.via && validCode(engines[mode], previous.code) &&
          hasFigure(previous.fig) && seen.has(mode + previous.code)) {
        store.set("me." + mode, previous);
        if (JSON.stringify(store.get("me." + mode)) === JSON.stringify(previous)) {
          store.del("me.prev." + mode);
        }
      }
    }
  }
  return changed;
}

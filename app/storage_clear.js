// このサイトの端末内記録だけを消し、残存キーまで確認する。
// Storage が使えない・削除を拒否する場合は成功と扱わない。
export function clearPrefixedStorage(getStorage, prefix = "ijin.") {
  try {
    const storage = getStorage();
    const targets = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (typeof key !== "string") return false;
      if (key.startsWith(prefix)) targets.push(key);
    }
    let removalFailed = false;
    for (const key of targets) {
      try { storage.removeItem(key); } catch { removalFailed = true; }
    }
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (typeof key !== "string") return false;
      if (key.startsWith(prefix)) return false;
    }
    return !removalFailed;
  } catch { return false; }
}

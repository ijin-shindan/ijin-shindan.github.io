// A deletion fence shared by future local-only writers. This helper does not
// acquire a lock: callers must hold the same records lock across initialization,
// epoch check, their data write, and clear-all. The 256-bit token contains no
// answer, figure ID, URL, or person identifier. A full browser reset can erase
// this key; a later token collision (ABA) remains theoretically possible.
export const CLEAR_EPOCH_KEY = "ijin-clear-epoch";
const TOKEN_RE = /^[a-f0-9]{64}$/;

function newToken(cryptoSource) {
  try {
    if (!cryptoSource || typeof cryptoSource.getRandomValues !== "function") return null;
    const bytes = new Uint8Array(32);
    cryptoSource.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export function readClearEpoch(storage) {
  try {
    const value = storage.getItem(CLEAR_EPOCH_KEY);
    if (value === null) return { status: "missing" };
    if (typeof value !== "string" || !TOKEN_RE.test(value)) return { status: "invalid" };
    return { status: "present", token: value };
  } catch {
    return { status: "unavailable" };
  }
}

// A writer must capture a present generation at start/resume. Missing is never
// a writer snapshot: otherwise reset-to-missing could falsely match stale work.
export function compareClearEpoch(storage, captured) {
  if (!captured || captured.status !== "present" ||
    typeof captured.token !== "string" || !TOKEN_RE.test(captured.token)) {
    return { status: "invalid_snapshot", matches: false };
  }
  const current = readClearEpoch(storage);
  if (current.status === "unavailable" || current.status === "invalid") {
    return { status: current.status, matches: false };
  }
  const matches = current.status === "present" && current.token === captured.token;
  return { status: matches ? "match" : "mismatch", matches };
}

// Call under the records lock before new work starts. If the key was removed
// by site-data deletion, a new random generation is established and read back.
// An invalid existing value requires explicit browser site-data deletion;
// it is never silently overwritten by this helper.
export function ensureClearEpoch(storage, cryptoSource = globalThis.crypto) {
  const before = readClearEpoch(storage);
  if (before.status === "unavailable" || before.status === "invalid") return { status: before.status };
  if (before.status === "present") return { status: "ready", token: before.token };
  const token = newToken(cryptoSource);
  if (!token) return { status: "entropy_unavailable" };
  try {
    storage.setItem(CLEAR_EPOCH_KEY, token);
  } catch {
    return { status: "write_failed" };
  }
  const after = readClearEpoch(storage);
  if (after.status !== "present" || after.token !== token) return { status: "verification_failed" };
  return { status: "initialized", token };
}

// Call under the same records lock, before removing ijin.* keys. The caller
// must not clear when this returns anything other than "advanced".
export function advanceClearEpoch(storage, cryptoSource = globalThis.crypto) {
  const before = readClearEpoch(storage);
  if (before.status !== "present") return { status: before.status };
  const token = newToken(cryptoSource);
  if (!token) return { status: "entropy_unavailable" };
  if (token === before.token) return { status: "collision" };
  try {
    storage.setItem(CLEAR_EPOCH_KEY, token);
  } catch {
    return { status: "write_failed" };
  }
  const after = readClearEpoch(storage);
  if (after.status !== "present" || after.token !== token) return { status: "verification_failed" };
  return { status: "advanced", token };
}

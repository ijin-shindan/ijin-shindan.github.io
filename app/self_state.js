// SELF の権威記録。旧キーは初回移行時だけ読み、移行後の書込には使わない。
export const SELF_KEY = "ijin.selfState.v1";
export const SELF_GATE_KEY = "ijin-self-migration-gate"; // 全削除後にも残る非 prefix の柵
const MODES = ["normal", "love"];
export const LEGACY_SELF_KEYS = [
  "ijin.me.normal", "ijin.me.prev.normal", "ijin.me.love", "ijin.me.prev.love",
  "ijin.diagLedger", "ijin.diagCount", "ijin.seen_results",
];
export const MAX_PENDING_ZUKAN = 64;
const copyState = (state) => JSON.parse(JSON.stringify(state));
const tokenOk = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const attemptOk = (value) => typeof value === "string" && value.length > 0 && value.length <= 100;
const emptyLegacySnapshot = () => Object.fromEntries(LEGACY_SELF_KEYS.map((key) => [key, null]));
function validLegacySnapshot(value) {
  return value && !Array.isArray(value) && typeof value === "object"
    && Object.keys(value).length === LEGACY_SELF_KEYS.length
    && LEGACY_SELF_KEYS.every((key) => Object.hasOwn(value, key)
      && (value[key] === null || typeof value[key] === "string"));
}

export function blankSelfState(epoch) {
  return { v: 1, epoch, current: { normal: null, love: null },
    previous: { normal: null, love: null }, count: 0,
    done: { normal: null, love: null }, seenResults: [],
    pendingZukan: [], legacyLinks: [], legacyUnverified: [], migrationWarnings: [],
    legacySnapshot: emptyLegacySnapshot() };
}

function validState(value, resultOk) {
  if (!value || value.v !== 1 || !tokenOk(value.epoch)
    || !Number.isSafeInteger(value.count) || value.count < 0
    || !value.current || !value.previous || !value.done || !Array.isArray(value.pendingZukan)
    || !Array.isArray(value.seenResults) || !Array.isArray(value.legacyLinks)
    || !Array.isArray(value.legacyUnverified ?? [])
    || !Array.isArray(value.migrationWarnings ?? [])) return false;
  // Pre-snapshot authorities remain readable for recovery, but are not writable
  // or considered safe by readSelfState. A malformed snapshot is damaged data.
  if (value.legacySnapshot !== undefined && !validLegacySnapshot(value.legacySnapshot)) return false;
  if ((value.migrationWarnings ?? []).length > 12
    || !(value.migrationWarnings ?? []).every((x) => typeof x === "string" && x.length <= 80)) return false;
  if (!value.seenResults.every((code) => typeof code === "string" && code.length <= 60)) return false;
  if (!value.legacyLinks.every((x) => x && MODES.includes(x.mode) && resultOk(x.mode, x))) return false;
  if (!(value.legacyUnverified ?? []).every((x) => x && MODES.includes(x.mode)
    && resultOk(x.mode, x))) return false;
  if (value.pendingZukan.length > MAX_PENDING_ZUKAN
    || !value.pendingZukan.every((pending) => pending && MODES.includes(pending.mode)
    && attemptOk(pending.attemptId) && typeof pending.code === "string" && pending.code.length <= 50
    && Array.isArray(pending.entries) && pending.entries.length <= 8
    && pending.entries.every((x) => x && typeof x.id === "string" && x.id.length <= 100
      && typeof x.src === "string" && x.src.length <= 50))) return false;
  return MODES.every((mode) => {
    const current = value.current[mode], previous = value.previous[mode], done = value.done[mode];
    return (current === null || resultOk(mode, current))
      && (previous === null || resultOk(mode, previous))
      && (done === null || (attemptOk(done.attemptId) && typeof done.code === "string" && done.code.length <= 50));
  });
}

function readRaw(storage, key) {
  try { return { status: "ok", raw: storage.getItem(key) }; }
  catch { return { status: "unavailable" }; }
}
function readLegacySnapshot(storage) {
  const snapshot = {};
  for (const key of LEGACY_SELF_KEYS) {
    const entry = readRaw(storage, key);
    if (entry.status !== "ok") return { status: "unavailable", field: key };
    snapshot[key] = entry.raw;
  }
  return { status: "ok", snapshot };
}
function parse(raw) {
  try { return JSON.parse(raw); } catch { return undefined; }
}
function readGate(storage) {
  const result = readRaw(storage, SELF_GATE_KEY);
  if (result.status !== "ok") return result;
  if (result.raw === null) return { status: "missing" };
  const gate = parse(result.raw);
  if (!gate || gate.v !== 1 || (gate.migratedEpoch !== null && !tokenOk(gate.migratedEpoch))
    || (gate.armedEpoch !== null && !tokenOk(gate.armedEpoch))) return { status: "damaged" };
  return { status: "ok", gate };
}
export function readSelfState(storage, epoch, resultOk) {
  if (!tokenOk(epoch)) return { status: "epoch_unavailable" };
  const entry = readRaw(storage, SELF_KEY);
  if (entry.status !== "ok") return entry;
  if (entry.raw !== null) {
    const state = parse(entry.raw);
    if (!validState(state, resultOk)) return { status: "damaged", raw: entry.raw };
    if (state.epoch !== epoch) return { status: "stale_epoch", raw: entry.raw };
    const gate = readGate(storage);
    // authority と gate が同じ削除世代で確定して初めて表示・保存を許す。
    // 全削除直後の新 authority と旧 gate も、確定前は読取専用に留める。
    if (gate.status !== "ok" || gate.gate.migratedEpoch !== epoch)
      return { status: "gate_unverified", state, raw: entry.raw };
    if (state.legacySnapshot === undefined)
      return { status: "legacy_unverified", state, raw: entry.raw };
    const legacy = readLegacySnapshot(storage);
    if (legacy.status !== "ok") return { ...legacy, state, raw: entry.raw };
    if (LEGACY_SELF_KEYS.some((key) => legacy.snapshot[key] !== state.legacySnapshot[key]))
      return { status: "legacy_changed", state, raw: entry.raw };
    return { status: "ok", state, raw: entry.raw };
  }
  const gate = readGate(storage);
  if (gate.status === "damaged" || gate.status === "unavailable") return gate;
  const g = gate.gate;
  // 移行を確定した同じ世代で authority だけが消えたなら、旧タブの全削除や
  // ストレージ異常の可能性がある。空の記録を自動作成して証拠を隠さない。
  if (g?.migratedEpoch === epoch) return { status: "missing_after_migration", raw: null };
  const legacyAllowed = !g || (!g.migratedEpoch && (!g.armedEpoch || g.armedEpoch === epoch));
  return { status: legacyAllowed ? "needs_legacy" : "needs_empty", raw: null };
}

function legacyJSON(snapshot, key) {
  const raw = snapshot[`ijin.${key}`];
  if (raw === null) return { status: "ok", value: null };
  const value = parse(raw);
  return value === undefined ? { status: "damaged" } : { status: "ok", value };
}
export function readLegacySelfState(storage, epoch, resultOk) {
  // Capture all seven exact raw values first. Derive the imported state only
  // from that snapshot, so a concurrent old-tab write is not silently merged.
  const captured = readLegacySnapshot(storage);
  if (captured.status !== "ok")
    return { status: "unavailable_legacy", field: captured.field.replace(/^ijin\./, "") };
  const state = blankSelfState(epoch);
  state.legacySnapshot = captured.snapshot;
  const promotionCandidates = {};
  for (const mode of MODES) {
    const current = legacyJSON(captured.snapshot, `me.${mode}`);
    const previous = legacyJSON(captured.snapshot, `me.prev.${mode}`);
    const safe = (record, key) => {
      if (record.status !== "ok" || (record.value !== null && !resultOk(mode, record.value))) {
        state.migrationWarnings.push(key);
        return null;
      }
      return record.value;
    };
    const currentValue = safe(current, `me.${mode}`);
    const previousValue = safe(previous, `me.prev.${mode}`);
    const ownCurrent = currentValue?.via === "link" ? null : currentValue;
    const ownPrevious = previousValue?.via === "link" ? null : previousValue;
    for (const entry of [currentValue, previousValue]) {
      if (entry?.via === "link") state.legacyLinks.push({ mode, ...entry });
    }
    state.current[mode] = ownCurrent || null;
    state.previous[mode] = ownCurrent ? ownPrevious : null;
    if (!ownCurrent && ownPrevious) promotionCandidates[mode] = ownPrevious;
  }
  const ledger = legacyJSON(captured.snapshot, "diagLedger");
  const ledgerValid = ledger.status === "ok" && ledger.value !== null && ledger.value
    && Number.isSafeInteger(ledger.value.count) && ledger.value.count >= 0 && ledger.value.done
    && MODES.every((mode) => ledger.value.done[mode] === null
      || (attemptOk(ledger.value.done[mode]?.attemptId)
        && typeof ledger.value.done[mode].code === "string"
        && ledger.value.done[mode].code.length <= 50));
  if (ledgerValid) {
    const value = ledger.value;
    state.count = value.count;
    state.done = { normal: value.done.normal, love: value.done.love };
  } else {
    if (ledger.status !== "ok" || ledger.value !== null) state.migrationWarnings.push("diagLedger");
    const count = legacyJSON(captured.snapshot, "diagCount");
    if (count.status !== "ok" || (count.value !== null
      && (!Number.isSafeInteger(count.value) || count.value < 0))) state.migrationWarnings.push("diagCount");
    else state.count = count.value ?? 0;
  }
  const seen = legacyJSON(captured.snapshot, "seen_results");
  if (seen.status !== "ok" || (seen.value !== null && !Array.isArray(seen.value)))
    state.migrationWarnings.push("seen_results");
  else state.seenResults = (seen.value ?? []).filter((x) => typeof x === "string" && x.length <= 60).slice(-30);
  for (const mode of MODES) {
    const candidate = promotionCandidates[mode];
    if (!candidate) continue;
    if (state.seenResults.includes(mode + candidate.code)) state.current[mode] = candidate;
    else {
      state.legacyUnverified.push({ mode, ...candidate });
      state.migrationWarnings.push(`me.prev.${mode}`);
    }
  }
  // 以前の試作で残った未確定 me は、ledger との一致が確認できなければ移行しない。
  for (const mode of MODES) {
    const current = state.current[mode];
    if (current?.commitState === "pending"
      && (state.done[mode]?.attemptId !== current.attemptId || state.done[mode]?.code !== current.code))
      return { status: "incomplete_legacy" };
  }
  return { status: "ok", state };
}

export function writeSelfState(storage, state, expectedRaw, resultOk) {
  if (!validState(state, resultOk) || !validLegacySnapshot(state.legacySnapshot)) return "invalid";
  const legacy = readLegacySnapshot(storage);
  if (legacy.status !== "ok") return "unavailable";
  if (LEGACY_SELF_KEYS.some((key) => legacy.snapshot[key] !== state.legacySnapshot[key]))
    return "legacy_changed";
  const before = readRaw(storage, SELF_KEY);
  if (before.status !== "ok") return "unavailable";
  if (before.raw !== expectedRaw) return "changed";
  const serialized = JSON.stringify(state);
  try { storage.setItem(SELF_KEY, serialized); }
  catch { return "write_failed"; }
  const after = readRaw(storage, SELF_KEY);
  return after.status === "ok" && after.raw === serialized ? "saved" : "verification_failed";
}

// Explicit recovery after the person has saved a backup and accepted that
// later legacy-tab writes will not be imported. This changes only the raw-key
// baseline; it never reads old answers into current/previous or deletes keys.
export function rebaselineLegacySelfState(storage, epoch, expectedRaw, expectedLegacyRaw, resultOk) {
  if (!tokenOk(epoch) || typeof expectedRaw !== "string"
    || !validLegacySnapshot(expectedLegacyRaw)) return { status: "invalid" };
  const observed = readSelfState(storage, epoch, resultOk);
  if (!["legacy_changed", "legacy_unverified"].includes(observed.status))
    return { status: observed.status === "ok" ? "not_needed" : observed.status };
  if (observed.raw !== expectedRaw) return { status: "changed" };
  const gateBefore = readRaw(storage, SELF_GATE_KEY);
  if (gateBefore.status !== "ok") return { status: "unavailable" };
  const gate = readGate(storage);
  if (gate.status !== "ok" || gate.gate.migratedEpoch !== epoch)
    return { status: "gate_unverified" };
  const legacyBefore = readLegacySnapshot(storage);
  if (legacyBefore.status !== "ok") return legacyBefore;
  if (LEGACY_SELF_KEYS.some((key) => legacyBefore.snapshot[key] !== expectedLegacyRaw[key]))
    return { status: "legacy_changed" };
  const authorityBefore = readRaw(storage, SELF_KEY);
  if (authorityBefore.status !== "ok") return { status: "unavailable" };
  if (authorityBefore.raw !== expectedRaw) return { status: "changed" };
  const gateAtWrite = readRaw(storage, SELF_GATE_KEY);
  if (gateAtWrite.status !== "ok") return { status: "unavailable" };
  if (gateAtWrite.raw !== gateBefore.raw) return { status: "gate_unverified" };
  const next = { ...observed.state, legacySnapshot: legacyBefore.snapshot };
  if (!validState(next, resultOk)) return { status: "invalid" };
  const serialized = JSON.stringify(next);
  try { storage.setItem(SELF_KEY, serialized); }
  catch { return { status: "write_failed" }; }
  const authorityAfter = readRaw(storage, SELF_KEY);
  if (authorityAfter.status !== "ok" || authorityAfter.raw !== serialized)
    return { status: "verification_failed" };
  const gateAfter = readRaw(storage, SELF_GATE_KEY);
  if (gateAfter.status !== "ok") return { status: "unavailable" };
  if (gateAfter.raw !== gateBefore.raw) return { status: "gate_unverified" };
  const legacyAfter = readLegacySnapshot(storage);
  if (legacyAfter.status !== "ok") return legacyAfter;
  if (LEGACY_SELF_KEYS.some((key) => legacyAfter.snapshot[key] !== expectedLegacyRaw[key]))
    return { status: "legacy_changed" };
  const verified = readSelfState(storage, epoch, resultOk);
  return verified.status === "ok" && verified.raw === serialized
    ? verified : { status: verified.status === "ok" ? "changed" : verified.status };
}

export function initializeSelfState(storage, epoch, resultOk) {
  const current = readSelfState(storage, epoch, resultOk);
  if (current.status === "ok") return current;
  if (!["needs_legacy", "needs_empty", "stale_epoch", "gate_unverified"].includes(current.status)) return current;
  const gate = readGate(storage);
  if (gate.status === "damaged" || gate.status === "unavailable") return gate;
  // 旧世代の authority が残った場合は、全削除の柵がある時だけ新世代で上書きする。
  if (current.status === "stale_epoch" && (!gate.gate?.armedEpoch || gate.gate.armedEpoch === epoch))
    return { status: "stale_epoch" };
  const legacy = current.status === "gate_unverified" ? { status: "ok", state: current.state }
    : current.status === "needs_legacy" ? readLegacySelfState(storage, epoch, resultOk)
    : { status: "ok", state: blankSelfState(epoch) };
  if (legacy.status !== "ok") return legacy;
  if (current.status !== "gate_unverified") {
    const saved = writeSelfState(storage, legacy.state, current.raw, resultOk);
    if (saved !== "saved") return { status: saved };
  }
  const nextGate = { v: 1, migratedEpoch: epoch, armedEpoch: gate.gate?.armedEpoch ?? null };
  const gateRaw = JSON.stringify(nextGate);
  try { storage.setItem(SELF_GATE_KEY, gateRaw); }
  catch { return { status: "gate_unverified" }; }
  if (readRaw(storage, SELF_GATE_KEY).raw !== gateRaw) return { status: "gate_unverified" };
  return readSelfState(storage, epoch, resultOk);
}

export function armSelfClear(storage, epoch) {
  if (!tokenOk(epoch)) return false;
  const prior = readGate(storage);
  if (!["missing", "ok"].includes(prior.status)) return false;
  const gate = { v: 1, migratedEpoch: prior.gate?.migratedEpoch ?? null, armedEpoch: epoch };
  const raw = JSON.stringify(gate);
  try { storage.setItem(SELF_GATE_KEY, raw); }
  catch { return false; }
  return readRaw(storage, SELF_GATE_KEY).raw === raw;
}

export function nextDiagnosisState(state, mode, attemptId, code, result, entries) {
  const done = state.done[mode];
  if (done?.attemptId === attemptId) return done.code !== code ? { status: "attempt_changed" }
    : state.current[mode]?.code === code ? { status: "duplicate", state }
      : { status: "already_completed_not_current" };
  if (state.pendingZukan.length >= MAX_PENDING_ZUKAN) return { status: "zukan_queue_full" };
  const next = copyState(state);
  const current = next.current[mode];
  if (current && current.code !== code) next.previous[mode] = current;
  next.current[mode] = result;
  next.count += 1;
  next.done[mode] = { attemptId, code };
  next.seenResults = [...new Set([...next.seenResults, mode + code])].slice(-30);
  next.pendingZukan.push({ mode, attemptId, code, entries });
  return { status: "ready", state: next };
}

export function nextRestoredState(state, mode, result) {
  const next = copyState(state);
  if (next.current[mode]?.code !== result.code && next.current[mode]) next.previous[mode] = next.current[mode];
  next.current[mode] = result;
  return next;
}

export function nextZukanSettledState(state, mode, attemptId) {
  if (!state.pendingZukan.some((x) => x.mode === mode && x.attemptId === attemptId)) return null;
  const next = copyState(state);
  next.pendingZukan = next.pendingZukan.filter((x) => !(x.mode === mode && x.attemptId === attemptId));
  return next;
}

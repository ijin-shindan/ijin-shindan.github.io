// 画面：トップ（#/）→ 質問（#/q/<mode>）→ 結果（#/r/<mode>/<回答>）／ 図鑑（#/zukan）
// 結果のURLには回答（1〜5の数字の列）が入るので、そのままシェアできる。
// 設計の根拠：docs/ui-redesign.md（デザイナー）、docs/game-design-review.md の P0（ゲーム開発者）
import { AXES, Shindan, loadData } from "./shindan.js?v=1b625ae-202610290220";
import { mountMotion } from "./motion.js?v=1b625ae-202610290220";
import { mountGuide } from "./guide.js?v=1b625ae-202610290220";
import { SELF_KEY, LEGACY_SELF_KEYS, blankSelfState, readSelfState, initializeSelfState, armSelfClear,
  writeSelfState, rebaselineLegacySelfState, nextDiagnosisState, nextRestoredState, nextZukanSettledState } from "./self_state.js?v=1b625ae-202610290220";
import { createInviteToken, validInviteToken, validFriendCode, makeFriendCode, friendAnswersFromCode, makeInviteUrl, makeReplyUrl, parseSocialHash, otherPilotAllowed } from "./social.js?v=1b625ae-202610290220";
import { orderOtherV1Questions, otherV1ProgressIndex } from "./other_v1.js?v=1b625ae-202610290220";
import { appendOtherReply, removeOtherReply } from "./other_replies.js?v=1b625ae-202610290220";
import { prependPersonCard, distinctCardFigures, figureSetProgress, cleanPersonCardLabel, personCardDisplayName, personCardNeedsLabel } from "./people.js?v=1b625ae-202610290220";
import { isSharedResultEntry, sharedResultViewPath, withoutSharedResultParam } from "./shared_entry.js?v=1b625ae-202610290220";
import { rememberSharedReturn, readSharedReturn } from "./shared_return.js?v=1b625ae-202610290220";
import { storedResultMatches, storedList } from "./stored_result.js?v=1b625ae-202610290220";
import { clearPrefixedStorage } from "./storage_clear.js?v=1b625ae-202610290220";
import { readClearEpoch, compareClearEpoch, ensureClearEpoch, advanceClearEpoch } from "./storage_epoch.js?v=1b625ae-202610290220";
import { applyZukanBatch } from "./zukan_batch.js?v=1b625ae-202610290220";

const $ = (s, el = document) => el.querySelector(s);
const app = $("#app"), overlay = $("#overlay"), sheet = $("#sheet");
const getJSON = (u) => fetch(u).then((r) => r.json());
async function loadInitialState() {
  try {
    const [data, meta] = await Promise.all([loadData(), getJSON("meta.json?v=1b625ae-202610290220")]);
    const engines = { normal: new Shindan(data, "free", "normal"), love: new Shindan(data, "free", "love") };
    // OTHER の設問は試験中。未較正の人物判定を実行せず、回答そのものを返す。
    const otherQuestions = orderOtherV1Questions(data.questions_friend.questions);
    const SD = engines.normal;
    const texts = data.texts.figures;
    const axisById = Object.fromEntries(data.axes.axes.map((a) => [a.id, a]));
    if (!meta?.themes || typeof meta.themes !== "object" ||
        SD.types.some(({ id }) => ["bg", "bg2", "bg3", "accent"].some(
          (key) => !/^#[0-9a-f]{6}$/i.test(meta.themes[id]?.[key] ?? "")))) {
      throw Error("invalid themes");
    }
    const THEMES = meta.themes;
    const MAX_TIER = SD.plan.max_tier;
    const FREE = Object.values(SD.figures).filter((f) => f.tier <= MAX_TIER);
    const LOCKED = Object.values(SD.figures).filter((f) => f.tier > MAX_TIER);
    return { data, meta, engines, otherQuestions, SD, texts, axisById, THEMES, MAX_TIER, FREE, LOCKED };
  } catch (e) {
    window.__ijinBootErrorHandled = true;
    app.innerHTML = `<section class="card" role="alert"><h1>ページを読み込めませんでした</h1>
      <p>通信状況を確かめて、もう一度読み込んでください。この操作では答えや端末の記録を消しません。</p>
      <button class="btn start" type="button" data-retry-load>もう一度読み込む</button></section>`;
    app.querySelector("[data-retry-load]").onclick = () => location.reload();
    throw e;
  }
}
const { data, meta, engines, otherQuestions, SD, texts, axisById, THEMES, MAX_TIER, FREE, LOCKED } = await loadInitialState();
// 他己用6軸の質問品質と補正値は未検証。公開サイトには出さず、ローカル試作だけで確認する。
const OTHER_PILOT = otherPilotAllowed(location.hostname);
const OTHER = { normal: "love", love: "normal" };
const THREE_HEROES = ["oda-nobunaga", "toyotomi-hideyoshi", "tokugawa-ieyasu"];

// ---------------- 小道具 ----------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem("ijin." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ijin." + k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem("ijin." + k); } catch {} },
};
// この公開版はローカル保存のみ。計測・ログイン・招待送信・課金は行わない。
const RETURNING = !!store.get("visited");
let currentMode = "none", nextSrc = null;
// 端末保存が使えない場合も、このタブ内の共有→診断の往復だけは続けられる。
const lastSharedInMemory = { normal: null, love: null };
function track() {} // この公開版ではアクセス・診断結果を計測しない。
let disposeGuide = () => {};
let disposeMotion = () => {};
function attachMotion(name) {
  disposeMotion();
  const stage = app.querySelector('.stage');
  if (!stage) return;
  let cleanup = () => {};
  let mounted = false;
  const observer = new MutationObserver(mountWhenReady);
  function mountWhenReady() {
    if (!mounted && stage.dataset.state === 'done') {
      mounted = true;
      observer.disconnect();
      cleanup = mountMotion(stage, { name });
    }
  }
  observer.observe(stage, {attributes:true, attributeFilter:['data-state']});
  disposeMotion = () => { observer.disconnect(); cleanup(); };
  mountWhenReady();
}
let timers = [];
const later = (ms, fn) => timers.push(setTimeout(fn, ms));
const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
let sheetReturnFocus = null, sheetObjectUrl = null;
function closeSheet(restoreFocus = true) {
  sheet.hidden = true;
  sheet.innerHTML = "";
  app.inert = false;
  if (sheetObjectUrl) URL.revokeObjectURL(sheetObjectUrl);
  sheetObjectUrl = null;
  const target = sheetReturnFocus;
  sheetReturnFocus = null;
  if (restoreFocus && target?.isConnected) target.focus();
  // A card list changed in another tab while this dialog was open. Keep the
  // draft intact until the dialog closes, then reconcile the visible list.
  if (location.hash === "#/people" && activePeopleCardsView?.pending) {
    queueMicrotask(refreshPeopleCardsAfterExternalChange);
  }
  if (activePersonCardView?.pending && location.hash === activePersonCardView.hash) {
    queueMicrotask(refreshPersonCardAfterExternalChange);
  }
}
function openSheet(html, trigger, objectUrl = null) {
  closeSheet(false);
  sheetReturnFocus = trigger ?? document.activeElement;
  sheetObjectUrl = objectUrl;
  sheet.innerHTML = html;
  sheet.hidden = false;
  app.inert = true;
  const panel = $(".panel", sheet);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "sheet-title");
  panel.tabIndex = -1;
  panel.focus();
  sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
  $(".close", sheet).onclick = () => closeSheet();
}
const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const fig = (id) => SD.figures[id];
const isFree = (id) => !!SD.figures[id] && SD.figures[id].tier <= MAX_TIER;
const avatar = (id, sil = false) => (isFree(id) ? (sil ? `avatars/full/sil/${id}.svg?v=2` : `avatars/full/${id}.svg?v=2`) : `avatars/sil/${id}.svg`);
const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
// 系統色の上の文字は、白と黒のうち読みやすいほう（コントラスト比が大きいほう）にする
const onAccent = (hex) => ((lum(hex) + 0.05) / 0.05 > 1.05 / (lum(hex) + 0.05) ? "#26221d" : "#fff");
const themeVars = (typeId) => { const t = THEMES[typeId]; return `--t-bg:${t.bg};--t-bg2:${t.bg2};--t-bg3:${t.bg3};--t-accent:${t.accent};--t-on:${onAccent(t.accent)}`; };
const typeLabel = (t, mode) => (mode === "love" ? { name: t.love_name, catch: t.love_catch } : { name: t.name, catch: t.catch });
const mainLine = (id, mode) => (mode === "love" ? texts[id]?.love?.line : texts[id]?.serif) ?? "";
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast"; el.setAttribute("role", "status"); el.textContent = msg;
  const resultStack = document.querySelector(".result-float-stack");
  resultStack?.querySelector(".toast")?.remove();
  (resultStack || document.body).append(el);
  setTimeout(() => el.remove(), 2400);
}
function ordered(sd) {  // 軸が偏らないよう、各軸の質問を交互に並べる
  const byAxis = AXES.map((a) => sd.questions.filter((q) => q.axis === a));
  const out = [];
  for (let i = 0; byAxis.some((l) => l[i]); i++) byAxis.forEach((l) => l[i] && out.push(l[i]));
  return out;
}
// 回答コードは「版の番号.数字の列」。質問の並びを変えたら CODE_VER を上げ、古い版の読み方を残す
const CODE_VER = "1";
const makeCode = (answers) => `${CODE_VER}.${answers.join("")}`;
const digits = (code) => { const m = /^(?:(\d+)\.)?([1-5]+)$/.exec(code || ""); return m && (m[1] ?? "1") === CODE_VER ? m[2] : null; };
const answersOf = (sd, code) => { const d = digits(code); return Object.fromEntries(ordered(sd).map((q, i) => [q.id, Number(d[i])])); };
const validCode = (sd, code) => { const d = digits(code); return !!d && d.length === ordered(sd).length; };
// 人物カード保存と全記録削除の順序を共有する。
// API非対応時は従来の照合へ戻るが、別タブとの原子的な順序は保証しない。
// ロックの取得失敗時は無ロックで再実行しない。
async function withSiteRecordsLock(action) {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return action();
  try { return await navigator.locks.request("ijin.site.records", { mode: "exclusive" }, action); }
  catch { return "lock_error"; }
}
// SELF の単一キー更新は、別タブを直列化できない環境では永続保存しない。
function selfLockAvailable() {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
}
function currentClearEpoch() {
  try { return readClearEpoch(localStorage); }
  catch { return { status: "unavailable" }; }
}
function clearEpochMatches(captured) {
  try { return compareClearEpoch(localStorage, captured).matches; }
  catch { return false; }
}
function viewEpochMatches(captured) {
  return captured.status === "present" ? clearEpochMatches(captured)
    : currentClearEpoch().status === captured.status;
}
function personCardEpochStatus(captured) {
  if (captured?.status !== "present") return "epoch_unavailable";
  try {
    const result = compareClearEpoch(localStorage, captured);
    if (result.status === "mismatch") return "stale_epoch";
    if (result.status !== "match") return "epoch_unavailable";
    // An older tab can erase SELF without advancing the deletion epoch. Do not
    // recreate person cards, quiz progress or zukan from a still-open new tab.
    return selfStateSnapshot().status === "ok" ? "current" : "state_unverified";
  } catch { return "epoch_unavailable"; }
}
// ロック待ちは画面表示を止めない。初回に世代がなかった画面だけ、
// 同じ初期化処理が自分で作った token を待つ。他タブが先に作った世代や
// クリック時の新しい世代は採用しない（削除後の旧画面を復活させない）。
const initialEpochAtStart = currentClearEpoch();
const initialEpochPromise = withSiteRecordsLock(() => ensureClearEpoch(localStorage));
function capturePersonCardEpoch() {
  const atRender = currentClearEpoch();
  if (atRender.status !== "missing") return atRender;
  if (initialEpochAtStart.status !== "missing") return atRender;
  return initialEpochPromise.then((result) => result?.status === "initialized"
    ? { status: "present", token: result.token } : { status: "unavailable" });
}
// 削除世代の更新を確認できなければ、保存記録には触れない。
async function clearSiteRecords(stillConfirmed = () => true) {
  if (!selfLockAvailable()) return "lock_error";
  return withSiteRecordsLock(() => {
    if (!stillConfirmed()) return "cancelled";
    const before = currentClearEpoch();
    if (before.status !== "present" || !armSelfClear(localStorage, before.token)) return "epoch_error";
    let advanced;
    try { advanced = advanceClearEpoch(localStorage); }
    catch { return "epoch_error"; }
    if (advanced.status !== "advanced") return "epoch_error";
    const localOk = clearPrefixedStorage(() => localStorage);
    const sessionOk = clearPrefixedStorage(() => sessionStorage);
    if (sessionOk) externalSessionClearFailed = false;
    let selfOk = false;
    try {
      const raw = localStorage.getItem(SELF_KEY);
      const validSelfResult = (mode, entry) => storedResultMatches(mode, entry, engines,
        SD.figures, validCode, answersOf);
      if (writeSelfState(localStorage, blankSelfState(advanced.token), raw, validSelfResult) === "saved") {
        // 新世代の authority だけでは未確定。gate まで書き戻してから成功とする。
        selfOk = initializeSelfState(localStorage, advanced.token, validSelfResult).status === "ok";
      }
    } catch {}
    quiz = null;
    justFinished = null;
    otherQuiz = null;
    confirmedOtherToken = null;
    nextSrc = null;
    lastSharedInMemory.normal = null;
    lastSharedInMemory.love = null;
    personSnapshot = null;
    shareCache = { key: null, blob: null };
    selfViewGeneration++;
    trustedEpoch = advanced.token;
    lastRevokedState = null;
    return localOk && sessionOk && selfOk ? "cleared" : "partial";
  });
}
const validProgress = (p) => p && Number.isFinite(p.t) && Array.isArray(p.answers) && p.answers.length <= 12
  && p.answers.every((v) => Number.isInteger(v) && v >= 1 && v <= 5);
const quizProgressKey = (mode) => `ijin.progress.${mode}`;
// 全記録削除との順序は常に site → 当該診断の progress の順にする。
async function withSiteQuizLock(mode, action) {
  return withSiteRecordsLock(() => withQuizProgressLock(mode, action));
}
function quizAttemptId(mode, saved) {
  if (typeof saved?.attemptId === "string" && /^[a-zA-Z0-9:._-]{1,100}$/.test(saved.attemptId)) return saved.attemptId;
  // 旧版の進行記録は同じ保存値から同じ ID を作り、再試行で診断回数を増やさない。
  if (saved) return `legacy:${mode}:${saved.t}:${saved.answers.join("")}`;
  return `new:${mode}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}
async function capturedQuizEpoch(activeQuiz) {
  try { return await activeQuiz.epoch; }
  catch { return { status: "unavailable" }; }
}
function readQuizProgress(mode) {
  let raw;
  try { raw = localStorage.getItem(quizProgressKey(mode)); }
  catch { return { status: "unavailable" }; }
  if (raw === null) return { status: "ok", raw, progress: null };
  try {
    const progress = JSON.parse(raw);
    return validProgress(progress) ? { status: "ok", raw, progress } : { status: "invalid", raw };
  } catch { return { status: "invalid", raw }; }
}
function quizEntryLabel(mode, idleText) {
  const snapshot = readQuizProgress(mode);
  const label = mode === "love" ? "恋愛診断" : "性格診断";
  if (snapshot.status === "invalid") return `${label}の途中記録を確認する`;
  if (snapshot.status === "unavailable") return `${label}を開く`;
  const saved = snapshot.progress;
  if (!validProgress(saved) || saved.answers.length === 0 || Date.now() - saved.t >= 864e5) return idleText;
  return `${label}の${saved.answers.length === 12 ? "回答を見直す" : "続きから"}（${saved.answers.length} / 12）`;
}
// 生の保存値を比較する。Web Locks非対応のブラウザーでは最終照合と書込は原子的にならない。
function quizProgressFreshness(mode, expectedRaw) {
  const current = readQuizProgress(mode);
  if (current.status === "unavailable") return "unavailable";
  // 読み取り不能から復旧し、空の保存先を確認できた場合だけメモリ内の続行を許す。
  return current.status === "ok" && (current.raw === expectedRaw || (expectedRaw === undefined && current.raw === null)) ? "ok" : "changed";
}
// 対応ブラウザーでは同じ診断版のタブ間で read→write/remove を直列化する。
// Web Locks非対応時は従来の保存値照合を維持し、ロック取得失敗時は書き込まない。
async function withQuizProgressLock(mode, action) {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return action();
  try { return await navigator.locks.request(`ijin.quiz.progress.${mode}`, { mode: "exclusive" }, action); }
  catch { return "lock_error"; }
}
function saveQuizProgress(mode, activeQuiz, progress, expectedRaw = activeQuiz.progressRaw) {
  const freshness = quizProgressFreshness(mode, expectedRaw);
  if (freshness !== "ok") return freshness;
  const raw = JSON.stringify(progress);
  try { localStorage.setItem(quizProgressKey(mode), raw); }
  catch { return "unavailable"; }
  activeQuiz.progressRaw = raw;
  return "saved";
}
function quizUnsavedWarning(activeQuiz) {
  if (!activeQuiz.persistenceUnavailable) return "";
  const role = activeQuiz.unsavedWarningShown ? "" : ' role="alert"';
  activeQuiz.unsavedWarningShown = true;
  return `<p class="quiz-save-warning"${role}>回答の途中保存ができません。診断を途中でやめる・再読み込みすると、保存できなかった回答は消えます。結果は見られますが、このサイトの端末記録には残りません。</p>`;
}
function quizSharedReturnWarning(activeQuiz) {
  if (activeQuiz.source !== "friend"
    || readSharedReturn(() => sessionStorage, activeQuiz.mode,
      currentClearEpoch(), activeQuiz.attemptId)) return "";
  const role = activeQuiz.sharedReturnWarningShown ? "" : ' role="alert"';
  activeQuiz.sharedReturnWarningShown = true;
  return `<p class="quiz-save-warning"${role}>元の結果への戻り先をこのタブで確認できません。診断を終えたあと、元の結果に戻るボタンが出ないことがあります。</p>`;
}
function clearQuizCursor(mode) {
  try { sessionStorage.removeItem(quizCursorKey(mode)); } catch {}
}
function showQuizProgressConflict(mode, invalid = false, epochAtView = capturePersonCardEpoch()) {
  clearTimers();
  quiz = null;
  clearQuizCursor(mode);
  const openLatestQuiz = () => {
    if (location.hash === `#/q/${mode}`) renderQuiz(mode);
    else location.hash = `#/q/${mode}`;
  };
  const damagedSnapshot = invalid ? readQuizProgress(mode) : null;
  app.innerHTML = `<section class="card"><h1>${invalid ? "途中の記録を読み込めません" : "別のタブで診断の記録が変わりました"}</h1>
    <p class="note">${invalid
      ? "この端末の途中記録は消していません。消して最初から答えることもできます。"
      : "この画面の古い回答は保存していません。開き直すと、この端末に続きがあれば再開できます。"}</p>
    ${invalid ? '<button class="btn start" type="button" data-clear-invalid>読めない途中記録を消して最初から答える</button><a class="btn sub" href="#/">トップへ戻る</a>' : '<button class="btn start" type="button" data-reload-quiz>診断を開き直す</button>'}</section>`;
  window.scrollTo(0, 0);
  $(".card h1").tabIndex = -1;
  $(".card h1").focus({ preventScroll: true });
  if (!invalid) $("[data-reload-quiz]").onclick = openLatestQuiz;
  else $("[data-clear-invalid]").onclick = async () => {
    const button = $("[data-clear-invalid]");
    button.disabled = true;
    const captured = await epochAtView;
    const status = await withSiteQuizLock(mode, () => {
      if (button.isConnected === false) return "cancelled";
      const epochStatus = personCardEpochStatus(captured);
      if (epochStatus !== "current") return epochStatus;
      const latest = readQuizProgress(mode);
      if (latest.status !== "invalid" || latest.raw !== damagedSnapshot.raw) return "changed";
      try {
        localStorage.removeItem(quizProgressKey(mode));
        if (localStorage.getItem(quizProgressKey(mode)) !== null) throw new Error("progress not cleared");
      } catch { return "unavailable"; }
      return "cleared";
    });
    if (button.isConnected === false || status === "cancelled") return;
    if (status === "changed" || status === "stale_epoch") return showQuizProgressConflict(mode, readQuizProgress(mode).status === "invalid");
    if (status !== "cleared") { button.disabled = false; return toast("途中の記録を消せませんでした。端末の保存設定を確認してください"); }
    openLatestQuiz();
  };
}
function showFreshQuizClearFailure(link) {
  let warning = link.nextElementSibling;
  if (!warning?.matches("[data-fresh-clear-warning]")) {
    warning = document.createElement("p");
    warning.className = "quiz-save-warning";
    warning.dataset.freshClearWarning = "";
    link.insertAdjacentElement("afterend", warning);
  }
  warning.textContent = "途中の記録が消えたか確認できませんでした。新しい診断は始めていません。端末の保存設定を確認してください。";
  warning.setAttribute("role", "alert");
}
function showFreshQuizMemoryOnlyNotice(link) {
  let warning = link.nextElementSibling;
  if (!warning?.matches("[data-fresh-memory-only-warning]")) {
    warning = document.createElement("p");
    warning.className = "quiz-save-warning";
    warning.dataset.freshMemoryOnlyWarning = "";
    link.insertAdjacentElement("afterend", warning);
  }
  warning.textContent = "この端末の途中記録を確認できません。保存済みの答えは消さず、この1回は保存なしで診断できます。途中で閉じると回答は消え、結果はこのサイトの端末記録には残りません。";
}
function bindFreshQuizLinks() {
  app.querySelectorAll("[data-fresh]").forEach((entry) => {
    // Starting over may delete saved answers. Make it an action instead of a
    // navigable link so a new tab cannot bypass the same-tab clear guard.
    const destination = entry.getAttribute?.("href") || `#/q/${entry.dataset.fresh}`;
    let link = entry;
    if (entry.tagName === "A") {
      link = document.createElement("button");
      link.type = "button";
      for (const { name, value } of entry.attributes) {
        if (name !== "href") link.setAttribute(name, value);
      }
      link.innerHTML = entry.innerHTML;
      entry.replaceWith(link);
    }
    const mode = link.dataset.fresh;
    const epochAtView = capturePersonCardEpoch();
    const snapshot = readQuizProgress(mode);
    if (snapshot.status === "ok" && validProgress(snapshot.progress) && snapshot.progress.answers.length > 0) {
      const label = mode === "love" ? "恋愛診断" : "性格診断";
      link.textContent = `${label}の保存された答えを消して最初から診断する`;
    }
    if (snapshot.status === "unavailable") {
      const label = mode === "love" ? "恋愛診断" : "性格診断";
      link.textContent = `${label}を保存なしで始める`;
      const saveNote = link.nextElementSibling;
      if (saveNote?.matches("[data-fresh-save-note]"))
        saveNote.textContent = "今回はこのサイトの端末記録に保存されません。いまの自分の結果も変わりません。";
      showFreshQuizMemoryOnlyNotice(link);
    }
    link.addEventListener("click", async (event) => {
      if ((event.button !== undefined && event.button !== 0) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        event.preventDefault();
        nextSrc = null;
        toast("最初から始めるには、キーを押さずにボタンを押してください");
        return;
      }
      event.preventDefault();
      const fromHash = location.hash;
      const captured = await epochAtView;
      const status = await withSiteQuizLock(mode, () => {
        if (location.hash !== fromHash || link.isConnected === false) return "cancelled";
        const epochStatus = personCardEpochStatus(captured);
        if (epochStatus === "stale_epoch") return epochStatus;
        if (snapshot.status === "unavailable") return "memory_only";
        if (epochStatus !== "current") return epochStatus;
        const freshness = quizProgressFreshness(mode, snapshot.raw);
        if (snapshot.status === "invalid" || freshness === "changed") return "changed";
        if (freshness === "unavailable") return "unavailable";
        if (freshness === "ok") {
          try {
            localStorage.removeItem(quizProgressKey(mode));
            if (localStorage.getItem(quizProgressKey(mode)) !== null) throw new Error("progress not cleared");
          } catch { return "unavailable"; }
        }
        return "cleared";
      });
      if (location.hash !== fromHash || link.isConnected === false) { nextSrc = null; return; }
      if (status === "cancelled") { nextSrc = null; return; }
      if (status === "changed" || status === "stale_epoch") { nextSrc = null; showQuizProgressConflict(mode, readQuizProgress(mode).status === "invalid"); return; }
      if (status !== "cleared" && status !== "memory_only") { nextSrc = null; showFreshQuizClearFailure(link); return; }
      if (status === "cleared") clearQuizCursor(mode);
      quiz = null;
      nextSrc = link.dataset.src ?? null;
      // Only an explicit start from a shared result keeps the return link
      // through a reload. Viewing the result alone never stores its answers.
      if (location.hash !== destination) location.hash = destination;
      // Start this attempt directly in memory. There is no pending route flag
      // that a later navigation could accidentally reuse after storage recovers.
      if (status === "memory_only") renderQuiz(mode, false, true);
      else if (location.hash === fromHash) renderQuiz(mode);
    });
  });
}
// 見直し位置はタブ内だけに保存し、別タブの回答記録を上書きしない。
const quizCursorKey = (mode) => `ijin.quiz.cursor.${mode}`;
function rememberQuizCursor(mode, progress, index) {
  if (!validProgress(progress)) return;
  try { sessionStorage.setItem(quizCursorKey(mode), JSON.stringify({ t: progress.t, length: progress.answers.length, index })); } catch {}
}
function resumeQuizIndex(mode, progress, questionCount) {
  const fallback = Math.min(progress.answers.length, questionCount - 1);
  try {
    const cursor = JSON.parse(sessionStorage.getItem(quizCursorKey(mode)));
    if (cursor?.t === progress.t && cursor.length === progress.answers.length
      && Number.isInteger(cursor.index) && cursor.index >= 0 && cursor.index <= fallback) return cursor.index;
  } catch {}
  return fallback;
}
function checkpointPending(activeQuiz) {
  const n = activeQuiz?.i;
  return (n === 4 || n === 8) && activeQuiz.answers.length === n
    && (activeQuiz.checkpointConfirmed || 0) < n
    && (activeQuiz.checkpointRequired === n || !store.get("seen_checkpoint", false));
}
const friendAnswerCode = (code) => validFriendCode(code);
const inviteToken = () => { const token = store.get("other.invite"); return validInviteToken(token) ? token : null; };
const otherReplies = () => {
  const xs = store.get("other.replies", []);
  return Array.isArray(xs) ? xs.filter((x) => x && validInviteToken(x.token) && friendAnswerCode(x.code)) : [];
};
const usablePersonCard = (x) => x && (x.mode === "normal" || x.mode === "love")
  && typeof x.code === "string" && validCode(engines[x.mode], x.code) && typeof x.fig === "string"
  && Object.prototype.hasOwnProperty.call(SD.figures, x.fig);
// 旧カードの識別子はタブ内だけに置く。表示やルート解決で保存を書き換えない。
// raw配列の内容・順序が変われば全旧handleを失効し、別カードへの誤接続を防ぐ。
let personSnapshot = null;
const legacyHandles = new Map(); // raw index -> opaque, tab-local ID
const personCardsFromRaw = (xs) => {
  if (!Array.isArray(xs)) return { cards: [], indexes: [] };
  const snapshot = JSON.stringify(xs);
  if (snapshot !== personSnapshot) {
    personSnapshot = snapshot;
    legacyHandles.clear();
  }
  const counts = new Map();
  xs.forEach((card) => {
    if (usablePersonCard(card) && validInviteToken(card.id)) counts.set(card.id, (counts.get(card.id) || 0) + 1);
  });
  const cards = [], indexes = [];
  xs.forEach((card, rawIndex) => {
    if (!usablePersonCard(card)) return;
    let id = card.id;
    if (!validInviteToken(id) || counts.get(id) !== 1) {
      if (!legacyHandles.has(rawIndex)) legacyHandles.set(rawIndex, `legacy-${createInviteToken()}`);
      id = legacyHandles.get(rawIndex);
    }
    cards.push({ ...card, id });
    indexes.push(rawIndex);
  });
  return { cards, indexes };
};
const peopleCards = () => personCardsFromRaw(store.get("people.cards", [])).cards;
const rawPersonAt = (displayIndex) => {
  const all = store.get("people.cards", []);
  if (!Array.isArray(all)) return { all: [], index: -1 };
  const { cards, indexes } = personCardsFromRaw(all);
  return { all, index: indexes[displayIndex] ?? -1, displayedId: cards[displayIndex]?.id };
};
const personDeleteConfirmMessage = (card, displayIndex, verifiedFigureName = "") => {
  // 一覧と同じ短い可視名を使い、不可視の旧保存値なら固定目印へ戻す。
  const name = personCardDisplayName(card, displayIndex);
  const mode = card.mode === "love" ? "恋愛版" : "性格版";
  const result = verifiedFigureName || "結果を確認できないカード";
  return `「${name}」（${displayIndex + 1}枚目・${result}・${mode}）をこの端末から削除しますか？`;
};
// 同じ回答コードでも別の人であり得る。カードの識別子は回答と分ける。
function readPersonCardStorage() {
  // store.get は壊れた JSON を [] として返すため、追加や一覧では生値を区別する。
  let raw;
  try { raw = localStorage.getItem("ijin.people.cards"); }
  catch { return { status: "unavailable" }; }
  if (raw === null) return { status: "ok", raw, cards: [] };
  let cards;
  try { cards = JSON.parse(raw); }
  catch { return { status: "damaged", raw }; }
  return Array.isArray(cards) ? { status: "ok", raw, cards } : { status: "damaged", raw };
}
function exportDamagedPersonCardRaw(raw) {
  const url = URL.createObjectURL(new Blob([raw], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = "ijin-people-cards-original.txt";
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
function showPersonCardAddFailure(button, status) {
  if (status === "full") return toast("人物カードは50枚まで。追加するには人物カード画面で不要なカードを削除してください");
  if (status === "stale_epoch") return toast("この画面を開いた後に端末の記録が消されました。画面を開き直してください");
  if (status === "state_unverified") return toast("端末の記録を確認できないため、カードの保存を止めました。この端末の記録をご確認ください");
  if (status === "epoch_unavailable") return toast("保存の準備を確認できません。少し待って画面を開き直してください");
  if (status === "lock_error" || status === "lock_unsupported") return toast("安全に保存できませんでした。別のタブを閉じてから再読み込みしてください");
  if (status !== "damaged") return toast("この端末に保存できませんでした");
  let warning = button.parentElement.querySelector("[data-person-save-error]");
  if (!warning) {
    warning = document.createElement("p");
    warning.className = "note";
    warning.setAttribute("role", "alert");
    warning.dataset.personSaveError = "";
    button.insertAdjacentElement("afterend", warning);
  }
  warning.textContent = "保存済みの人物カードを読み込めないため、追加を止めました。この端末の記録を消さずに保管し、人物カード画面の案内をご確認ください。";
}
function addPersonCard(mode, code, figureId) {
  const snapshot = readPersonCardStorage();
  if (snapshot.status !== "ok") return snapshot.status === "damaged" ? "damaged" : "error";
  const { raw, cards } = snapshot;
  const id = createInviteToken();
  const next = prependPersonCard(cards, { id, mode, code, fig: figureId, at: Date.now() }, 50, usablePersonCard);
  if (!next) return "full";
  try { if (localStorage.getItem("ijin.people.cards") !== raw) return "error"; } catch { return "error"; }
  if (!store.set("people.cards", next)) return "error";
  return peopleCards().some((card) => card.id === id) ? "saved" : "error";
}
// 対応ブラウザーではカードの追加・呼び名変更・削除を同じロックで直列化する。
// API非対応時は既存の保存値照合へ戻す。取得失敗時は無ロックで再実行しない。
async function withPersonCardsLock(action) {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return action();
  try { return await navigator.locks.request("ijin.people.cards", { mode: "exclusive" }, action); }
  catch { return "lock_error"; }
}
function personCardActionCurrent(button, hash, sheetButton = null) {
  return button.isConnected !== false && location.hash === hash
    && (!sheetButton || (sheet.hidden !== true && sheetButton.isConnected !== false));
}
function personCardSnapshotUnchanged(raw) {
  const latest = readPersonCardStorage();
  return latest.status === "ok" && latest.raw === raw ? latest.cards : null;
}
function personCardTargetUnchanged(cards, displayIndex, rawIndex, displayedId) {
  const resolved = personCardsFromRaw(cards);
  return resolved.indexes[displayIndex] === rawIndex && resolved.cards[displayIndex]?.id === displayedId
    && usablePersonCard(cards[rawIndex]);
}
async function addPersonCardFromButton(button, mode, code, figureId, capturedEpoch) {
  if (button.disabled) return "cancelled";
  const hash = location.hash;
  button.disabled = true;
  const stop = (status) => { button.disabled = false; return status; };
  const captured = await capturedEpoch;
  if (!personCardActionCurrent(button, hash)) return stop("cancelled");
  if (captured?.status !== "present") return stop("epoch_unavailable");
  if (!clearEpochMatches(captured)) return stop("stale_epoch");
  const before = readPersonCardStorage();
  if (before.status !== "ok") return stop(before.status === "damaged" ? "damaged" : "error");
  const duplicate = personCardsFromRaw(before.cards).cards.some((card) => card.mode === mode && card.code === code);
  // 確認ダイアログ中にロックを保持しない。
  if (duplicate && !confirm("同じ回答のカードが既にあります。別の人のカードとしてもう1枚追加しますか？")) return stop("cancelled");
  if (!personCardActionCurrent(button, hash)) return stop("cancelled");
  // ロック順は必ず site → people。カード保存後の図鑑 KNOWN 登録も
  // site ロック内で行い、全記録削除を間に挟ませない。
  const status = await withSiteRecordsLock(async () => {
    if (!personCardActionCurrent(button, hash)) return "cancelled";
    if (!clearEpochMatches(captured)) return "stale_epoch";
    return withPersonCardsLock(() => {
      if (!personCardActionCurrent(button, hash)) return "cancelled";
      if (!clearEpochMatches(captured)) return "stale_epoch";
      const latest = readPersonCardStorage();
      if (latest.status !== "ok") return latest.status === "damaged" ? "damaged" : "error";
      if (before.raw !== null && latest.raw === null) return "changed";
      // 別カードの追加なら最新配列から再計算する。新たな同一回答は再確認を促す。
      const duplicateNow = personCardsFromRaw(latest.cards).cards.some((card) => card.mode === mode && card.code === code);
      if (latest.raw !== before.raw && duplicateNow && !duplicate) return "changed";
      const saved = addPersonCard(mode, code, figureId);
      if (saved !== "saved") return saved;
      // 別キーなので部分失敗は残り得るが、削除による割込みはここでは起きない。
      return meet(figureId, "friend") ? "saved" : "saved_without_zukan";
    });
  });
  if (status !== "saved" && status !== "saved_without_zukan") button.disabled = false;
  return personCardActionCurrent(button, hash) ? status : "cancelled";
}

const verifiedResult = (mode, entry) => storedResultMatches(mode, entry, engines, SD.figures, validCode, answersOf);
function selfStateSnapshot() {
  const epoch = currentClearEpoch();
  return readSelfState(localStorage, epoch.status === "present" ? epoch.token : null, verifiedResult);
}
// gate_unverified は内部に妥当な state を持つことがあるが、表示には使わない。
const verifiedSelfState = () => {
  const snapshot = selfStateSnapshot();
  return snapshot.status === "ok" ? snapshot.state : null;
};
const savedResult = (mode) => verifiedSelfState()?.current[mode] ?? null;
const previousResult = (mode) => verifiedSelfState()?.previous[mode] ?? null;
const seenSelfResults = () => verifiedSelfState()?.seenResults ?? [];
function exportSelfOriginalRaw() {
  const keys = [SELF_KEY, ...LEGACY_SELF_KEYS];
  const originals = Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]));
  const url = URL.createObjectURL(new Blob([JSON.stringify(originals, null, 2)],
    { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = "ijin-self-original.txt";
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return Object.fromEntries(LEGACY_SELF_KEYS.map((key) => [key, originals[key]]));
}

// 図鑑：{figureId: {src: "me|friend_diag|match|next|friend", sources: string[], at}}
// src は「今のところいちばん強い発見経路」（後方互換のため残す）。sources は出会った経路を全部ためる配列（新設）
const DISCOVER_SRC = new Set(["me", "friend_diag"]); // この2つだけが正式な図鑑「発見」（旧データの src:"me" もそのまま discovered 扱い）
function readZukanStorage() {
  let raw;
  try { raw = localStorage.getItem("ijin.zukan"); }
  catch { return { status: "unavailable", zukan: {} }; }
  if (raw === null) return { status: "ok", raw, zukan: {} };
  let zukan;
  try { zukan = JSON.parse(raw); }
  catch { return { status: "damaged", raw, zukan: {} }; }
  if (!zukan || typeof zukan !== "object" || Array.isArray(zukan)
    || Object.values(zukan).some((e) => !e || typeof e !== "object" || Array.isArray(e)
      || typeof e.src !== "string" || (e.sources !== undefined
        && (!Array.isArray(e.sources) || e.sources.some((s) => typeof s !== "string"))))) {
    return { status: "damaged", raw, zukan: {} };
  }
  return { status: "ok", raw, zukan };
}
const zukanData = () => readZukanStorage().zukan;
const zukanStorageAlert = () => {
  const status = readZukanStorage().status;
  if (status === "ok") return "";
  const message = status === "damaged"
    ? "保存済みの図鑑記録を読み込めません。画面の発見数は正確ではありません。元の記録は変更せず、新しい図鑑登録を止めています。図鑑画面で元の記録のファイル保存を試せます。"
    : "この端末では図鑑記録を読み込めません。画面の発見数は正確ではありません。図鑑の登録を止めています。";
  return `<p class="note" role="alert">${message}</p>`;
};
function exportDamagedZukanRaw(raw) {
  const url = URL.createObjectURL(new Blob([raw], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = "ijin-zukan-original.txt";
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
function meetBatch(entries) {
  if (selfStateSnapshot().status !== "ok") return false;
  const eligible = entries.filter(({ id }) => id && isFree(id));
  if (!eligible.length) return false;
  const snapshot = readZukanStorage();
  if (snapshot.status !== "ok") return false;
  let z;
  try { z = applyZukanBatch(snapshot.zukan, eligible.map((entry) => ({ ...entry, at: Date.now() })), isFree); }
  catch { return false; }
  // 読込後からこの照合時点までの別タブ更新を検出したら、古い内容を書かない。
  try { if (localStorage.getItem("ijin.zukan") !== snapshot.raw) return false; } catch { return false; }
  return store.set("zukan", z);
}
const meet = (id, src) => meetBatch([{ id, src }]);
// 図鑑の状態（保存形式は変えない。src の意味で3段階に読み分ける）
//   DISCOVERED：自分の正式な診断結果（通常・恋愛）src "me"、または友達診断で登録 src "friend_diag"。全身画像・説明・動きを見せる
//   KNOWN     ：相性・もしも・共有結果などで名前だけ知った ＝ src "match" | "next" | "friend"。名前＋シルエット＋🔒未発見
//   UNKNOWN   ：まだ記録がない。？？？＋シルエット
const zState = (id) => { const e = zukanData()[id]; return !e ? "unknown" : DISCOVER_SRC.has(e.src) ? "discovered" : "known"; };
const isDiscovered = (id) => zState(id) === "discovered";
const zukanCount = () => Object.entries(zukanData()).filter(([id, e]) => DISCOVER_SRC.has(e.src) && SD.figures[id] && isFree(id)).length;
const knownCount = () => Object.entries(zukanData()).filter(([id, e]) => !DISCOVER_SRC.has(e.src) && SD.figures[id] && isFree(id)).length;
// 図鑑の「取得元」を日本語表示用に（discoveredな経路だけ）
const SRC_LABEL = { me: "自分の診断", friend_diag: "旧版の友達診断" };
const sourceLabels = (id) => { const e = zukanData()[id]; return [...new Set(e?.sources ?? (e ? [e.src] : []))].map((s) => SRC_LABEL[s]).filter(Boolean); };
// 関連表示（相性・もしも・友達）の顔：発見済みだけ通常の絵、それ以外はシルエット＋「🔒 未発見」
const relFace = (id) => avatar(id, !isDiscovered(id));
const undiscTag = (id) => (isDiscovered(id) ? "" : `<span class="undisc">🔒 未発見</span>`);

// ---------------- トップ ----------------
function completedQuizProgress(mode, saved, snapshot) {
  if (saved.answers.length !== 12 || typeof saved.attemptId !== "string"
    || !/^[a-zA-Z0-9:._-]{1,100}$/.test(saved.attemptId) || snapshot?.status !== "ok") return false;
  const done = snapshot.state.done[mode];
  return done?.attemptId === saved.attemptId && done.code === makeCode(saved.answers)
    && snapshot.state.current[mode]?.code === done.code;
}
let topResumeSnapshots = {};
let topQuizCtaMarkup = "";
function topQuizCtas() {
  topResumeSnapshots = Object.fromEntries(["normal", "love"].map((mode) => [mode, readQuizProgress(mode)]));
  const savedProgress = Object.fromEntries(["normal", "love"].map((mode) => {
    const snapshot = topResumeSnapshots[mode];
    const saved = snapshot.status === "ok" ? snapshot.progress : null;
    return [mode, validProgress(saved) && Date.now() - saved.t < 864e5 && saved.answers.length > 0 ? saved : null];
  }));
  const completedSnapshot = ["normal", "love"].some((mode) => savedProgress[mode]?.answers.length === 12)
    ? selfStateSnapshot() : null;
  const completed = Object.fromEntries(["normal", "love"].map((mode) =>
    [mode, !!savedProgress[mode] && completedQuizProgress(mode, savedProgress[mode], completedSnapshot)]));
  const progress = Object.fromEntries(["normal", "love"].map((mode) =>
    [mode, completed[mode] ? null : savedProgress[mode]]));
  const resumable = ["normal", "love"].filter((mode) => progress[mode]);
  const primary = resumable[0] ?? "normal";
  const resumeLinks = resumable.map((mode) => `<button class="btn ${mode === primary ? "start" : "sub"}" type="button" data-resume-top="${mode}">${mode === "love" ? "恋愛診断" : "性格診断"}${progress[mode].answers.length === 12 ? "の回答を見直す" : "の続きから"}（${progress[mode].answers.length} / 12）</button>`).join("");
  const freshLinks = ["normal", "love"].map((mode) => {
    const label = mode === "love" ? "恋愛診断" : "性格診断";
    const text = `${mode === "love" && !progress[mode] ? "💘 " : ""}${label}を${progress[mode] ? "最初から" : ""}始める`;
    const cls = mode === primary && !progress[mode] ? "start" : mode === "love" ? "love-sub" : "sub";
    return `<a class="btn ${cls}" data-fresh="${mode}" data-src="top" href="#/q/${mode}">${text}</a>${completed[mode] ? `<p class="quiz-save-warning" data-fresh-clear-warning>${label}の結果は保存済みです。新しく始めるには、残っている途中の記録を消す必要があります。消せない場合は端末の保存設定を確認してください。</p>` : ""}`;
  }).join("");
  topQuizCtaMarkup = resumeLinks + freshLinks;
  return topQuizCtaMarkup;
}
function refreshTopQuizCtas() {
  const container = app.querySelector(".cta");
  if (!container || !app.querySelector(".hero")) return;
  const previousMarkup = topQuizCtaMarkup;
  const previousSnapshots = topResumeSnapshots;
  const nextMarkup = topQuizCtas();
  const progressChanged = ["normal", "love"].some((mode) =>
    topResumeSnapshots[mode]?.status !== previousSnapshots[mode]?.status
      || topResumeSnapshots[mode]?.raw !== previousSnapshots[mode]?.raw);
  if (nextMarkup === previousMarkup && !progressChanged) return;
  const focused = document.activeElement;
  const focusedMode = focused && container.contains(focused) ? focused.dataset.resumeTop ?? focused.dataset.fresh : null;
  const focusedKind = focused?.dataset?.resumeTop ? "resume" : "fresh";
  const scrollY = window.scrollY;
  container.innerHTML = nextMarkup;
  bindFreshQuizLinks();
  bindResultErrorResumeLinks("[data-resume-top]", topResumeSnapshots);
  if (focusedMode) {
    const next = container.querySelector(`[data-${focusedKind === "resume" ? "resume-top" : "fresh"}="${focusedMode}"]`)
      ?? container.querySelector(`[data-fresh="${focusedMode}"]`);
    next?.focus({ preventScroll: true });
  }
  window.scrollTo(0, scrollY);
}
function topCurrentResultsHtml(me) {
  if (!me.normal && !me.love) return "";
  return `<div class="again">
      ${["normal", "love"].filter((m) => me[m]).map((m) => `
        <a class="row" href="#/r/${m}/${me[m].code}" style="text-decoration:none;color:inherit">
          <img class="tile" src="${avatar(me[m].fig)}" alt="" style="${themeVars(fig(me[m].fig).type)}">
          <div><div class="lbl">いまの${m === "love" ? "恋愛診断" : "性格診断"}の結果${me[m].via === "link" ? "（リンクから保存）" : ""}</div><div class="nm">${esc(fig(me[m].fig).name)}</div></div>
        </a>`).join("")}
      <a class="btn sub" href="#/zukan">図鑑を見る（${zukanCount()} / ${FREE.length}）</a>
      <a class="btn sub" href="#/me">この端末の記録（自分・受け取った結果）</a>
    </div>`;
}
function renderTop() {
  document.title = "世界の偉人性格診断";
  captureSelfOverview();
  const me = { normal: savedResult("normal"), love: savedResult("love") };
  app.innerHTML = `
    <section class="hero">
      <div class="seal">偉</div>
      <div id="guide"></div>
      <h1>${FREE.length}人の偉人のうち、<br>あなたは誰？</h1>
      <p class="sub">12問・約1分半・登録なし</p>
    </section>
    ${zukanStorageAlert()}
    <div class="cta">
      ${topQuizCtas()}
    </div>
    <section class="social-entry">
      <div class="social-badge">友達と遊ぶ</div>
      <h2>人を知るほど、偉人が増える。</h2>
      <p>人物カードには、友達から届いた自己診断結果を集めます。${OTHER_PILOT ? "友達があなたについて答える他己分析は、試作として確認できます。" : "友達があなたについて答える他己分析は、まだ使えません。"}</p>
      ${OTHER_PILOT ? '<a class="btn sub" href="#/ask">友達に12問答えてもらう（試作）</a>' : '<span class="dev-badge">他己分析　※開発中</span>'}
      <a class="btn sub" href="#/people">人物カードを見る</a>
    </section>
    <div data-self-overview>${topCurrentResultsHtml(me)}</div>
    <div class="teaser"></div>
    <button class="btn-text teaser-toggle" type="button" data-teaser-toggle>一言を止める</button>
    <div class="type-strip" aria-hidden="true">${SD.types.map((t) => `<i style="background:${THEMES[t.id].bg2}"></i>`).join("")}</div>
    <p class="note">${LOCKED.length ? `無料で出会えるのは${FREE.length}人。ほか${LOCKED.length}人はシルエットで待機中。` : `${FREE.length}人すべてに、無料で出会えます。`}<br>逸話には伝承や諸説あるものを含みます。</p>
    <p class="note"><a href="#/how">使い方</a>　・　<a href="#/me">この端末の記録</a>　・　<a href="#/about">このサイトについて</a></p>`;
  bindFreshQuizLinks();
  bindResultErrorResumeLinks("[data-resume-top]", topResumeSnapshots);
  disposeGuide = mountGuide($("#guide"));
  window.scrollTo(0, 0);
  // 決め台詞は読み切れる間隔で切り替える。動きを抑える設定では静止。
  const teaser = $(".teaser");
  const toggle = $("[data-teaser-toggle]");
  const pool = pick(FREE, 12);
  let k = 0;
  let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let teaserTimer;
  const show = () => {
    const f = pool[k++ % pool.length];
    teaser.classList.remove("fade"); void teaser.offsetWidth; teaser.classList.add("fade");
    teaser.innerHTML = `<img class="tile" src="${avatar(f.id)}" alt="" style="${themeVars(f.type)}">
      <div><div class="who">${esc(f.name)}タイプの人は</div><div class="line">「${esc(texts[f.id].serif)}」</div><small>演出の一言・本人の発言とは限りません</small></div>`;
    if (!paused) { teaserTimer = setTimeout(show, 5000); timers.push(teaserTimer); }
  };
  const syncToggle = () => { toggle.textContent = paused ? "一言を動かす" : "一言を止める"; toggle.setAttribute("aria-pressed", String(paused)); };
  toggle.onclick = () => {
    paused = !paused;
    if (paused) clearTimeout(teaserTimer);
    syncToggle();
    if (!paused) show();
  };
  syncToggle();
  show();
}

// ---------------- 質問 ----------------
let quiz = null;
let justFinished = null;  // 演出を出すのは、いま答え終えた結果だけ
let pendingGuardedResume = null;

function showGuardedResumeReadFailure() {
  app.innerHTML = `<section class="card"><h1>途中の記録を今は読み込めません</h1><p>この操作では答えを消していません。トップに戻り、端末の保存設定を確認してからもう一度試してください。</p><a class="btn start" href="#/">トップへ戻る</a></section>`;
  window.scrollTo(0, 0);
  const heading = app.querySelector(".card h1");
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}
function showGuardedResumeExpired() {
  app.innerHTML = `<section class="card"><h1>この途中記録からは再開できません</h1><p>途中記録の期限が切れたか、結果が保存済みです。この操作では答えを消していません。トップに戻り、端末の記録を確認してください。</p><a class="btn start" href="#/">トップへ戻る</a></section>`;
  window.scrollTo(0, 0);
  const heading = app.querySelector(".card h1");
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

function partialU(sd, answers) {  // 途中までの回答で軸スコアを出す（未回答の軸は0）
  return AXES.map((a) => {
    const xs = sd.questions.filter((q) => q.axis === a && answers[q.id]).map((q) => ((answers[q.id] - 3) / 2) * q.key);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
  });
}
function rankTypes(sd, u) {
  const n = Math.hypot(...u) || 1e-9, bias = sd.calib.type_bias;
  return sd.types.filter((t) => t.unit)
    .map((t) => [u.reduce((s, x, i) => s + x * t.unit[i], 0) / n + (bias[t.id] || 0), t])
    .sort((a, b) => b[0] - a[0]).map((p) => p[1]);
}

function renderQuiz(mode, anim = false, memoryOnlyStart = false) {
  const sd = engines[mode];
  if (!quiz || quiz.mode !== mode) {
    // 世代を進行記録より先に捕捉する。初期化待ちでも旧画面が新世代を再捕捉しない。
    const epoch = capturePersonCardEpoch();
    const snapshot = memoryOnlyStart
      ? { status: "unavailable", raw: undefined, progress: null }
      : readQuizProgress(mode);
    const expectedResume = pendingGuardedResume;
    pendingGuardedResume = null;
    if (expectedResume?.mode === mode) {
      if (snapshot.status === "unavailable") return showGuardedResumeReadFailure();
      if (snapshot.status !== "ok" || snapshot.raw !== expectedResume.raw)
        return showQuizProgressConflict(mode, snapshot.status === "invalid", epoch);
      const savedForGuard = snapshot.progress;
      if (!validProgress(savedForGuard) || savedForGuard.answers.length === 0 || Date.now() - savedForGuard.t >= 864e5
        || (savedForGuard.answers.length === 12 && completedQuizProgress(mode, savedForGuard, selfStateSnapshot())))
        return showGuardedResumeExpired();
    }
    if (snapshot.status === "invalid") return showQuizProgressConflict(mode, true, epoch);
    const saved = snapshot.progress;
    const qs = ordered(sd);
    const resumed = validProgress(saved) && saved.answers.length > 0 && Date.now() - saved.t < 864e5;
    const confirmed = resumed && [4, 8].includes(saved.checkpointConfirmed)
      && saved.checkpointConfirmed <= saved.answers.length ? saved.checkpointConfirmed : 0;
    // 旧途中記録は確認欄がないため、ちょうど境界で止まった試行を未確認として扱う。
    const required = resumed && [4, 8].includes(saved.answers.length) && saved.checkpointConfirmed === undefined
      ? saved.answers.length : resumed && [4, 8].includes(saved.checkpointRequired)
        && saved.checkpointRequired <= saved.answers.length ? saved.checkpointRequired : 0;
    quiz = { mode, qs, answers: [], i: 0, progressRaw: snapshot.raw,
      persistenceUnavailable: memoryOnlyStart || snapshot.status === "unavailable",
      checkpointConfirmed: confirmed, checkpointRequired: required,
      epoch, attemptId: quizAttemptId(mode, resumed ? saved : null) };
    // 旧版には試行 ID がない。12回答と保存済みの自分の結果が一致する場合、
    // 旧版で完了後に進行記録だけ消せなかった可能性があり、二重加算できない。
    if (resumed && saved.answers.length === qs.length && !saved.attemptId
      && savedResult(mode)?.code === makeCode(saved.answers)) {
      quiz.legacyPossibleDuplicateCode = makeCode(saved.answers);
    }
    if (resumed) { quiz.answers = saved.answers; quiz.i = resumeQuizIndex(mode, saved, qs.length); }
    quiz.source = resumed ? saved.source ?? "resume" : nextSrc ?? "top";
    if (!resumed && quiz.source === "friend") {
      // Bind the temporary return link to this exact quiz. A failed write for
      // a later quiz must never reuse an earlier friend's answer code.
      const origin = lastSharedInMemory[mode];
      if (origin?.epoch && clearEpochMatches(origin.epoch)) {
        rememberSharedReturn(() => sessionStorage, mode, origin,
          origin.epoch, quiz.attemptId);
      }
    }
    nextSrc = null;
    if (!resumed) track("quiz_start", { mode, source: quiz.source });
  }
  quiz.busy = false;
  // 回答保存後に再読込・画面移動しても、未確認の中間画面を飛ばさない。
  if (checkpointPending(quiz)) return renderCheckpoint(mode, quiz.i);
  const { qs, answers, i } = quiz;
  const q = qs[i];
  document.title = `質問 ${i + 1}｜${sd.modeConf.name}`;
  const intro = mode === "love" && i === 0 ? `<div class="intro">${esc(data.questions_love.intro)}</div>` : "";
  app.innerHTML = `
    <div class="qhead self-qhead">
      ${i === 0 ? '<a class="back" href="#/">← トップへ</a>' : '<button class="back">← 戻る</button>'}
      <span class="self-qhead-meta"><span class="count" aria-hidden="true"><b>${i + 1}</b> / ${qs.length}</span><span class="mystery" style="--p:${(i / qs.length) * 100}%" aria-hidden="true">?</span></span>
    </div>
    <div class="segs">${qs.map((_, k) => `<i class="${k < i ? "done" : k === i ? "now" : ""} ${[3, 7, 11].includes(k) ? "chest" : ""}"></i>`).join("")}</div>
    <div class="qbox ${anim ? "in" : ""}">
      ${intro}
      <h1 class="qtext" id="current-question" tabindex="-1" aria-label="${i + 1}問目、全${qs.length}問。${esc(q.text)}">${esc(q.text)}</h1>
      ${quizUnsavedWarning(quiz)}
      ${quizSharedReturnWarning(quiz)}
      <p class="qhint">いちばん近いものを1つ選んでね。押すと次へ進みます。</p>
      <div class="scale5" role="group" aria-labelledby="current-question">
        ${[1, 2, 3, 4, 5].map((v) => `<button class="dotbtn v${v} ${answers[i] === v ? "sel" : ""}" data-v="${v}" aria-label="${esc(sd.data.questions.scale[v - 1])}${answers[i] === v ? "（前の回答）" : ""}"><i aria-hidden="true"></i><span>${esc(sd.data.questions.scale[v - 1])}</span></button>`).join("")}
      </div>
    </div>`;
  window.scrollTo(0, 0);
  $(".qtext").focus({ preventScroll: true });
  if (i > 0) $(".back").onclick = () => {
    if (!quiz.persistenceUnavailable && quizProgressFreshness(mode, quiz.progressRaw) === "changed") return showQuizProgressConflict(mode);
    clearTimers(); quiz.busy = false; quiz.i--;
    if (!quiz.persistenceUnavailable) {
      const saved = readQuizProgress(mode).progress;
      if (validProgress(saved) && saved.answers.length === quiz.answers.length
        && saved.answers.every((answer, index) => answer === quiz.answers[index])) rememberQuizCursor(mode, saved, quiz.i);
    }
    renderQuiz(mode, true);
  };
  app.querySelectorAll(".dotbtn").forEach((b) => (b.onclick = async () => {
    if (quiz.busy) return;
    if (!quiz.persistenceUnavailable && quizProgressFreshness(mode, quiz.progressRaw) === "changed") return showQuizProgressConflict(mode);
    quiz.busy = true;
    const activeQuiz = quiz;
    const nextAnswers = quiz.answers.slice();
    nextAnswers[i] = Number(b.dataset.v);
    nextAnswers.length = Math.max(nextAnswers.length, i + 1);
    app.querySelectorAll(".dotbtn").forEach((choice) => {
      choice.classList.remove("sel");
      choice.setAttribute("aria-label", choice.querySelector("span").textContent);
    });
    b.classList.add("sel");
    b.setAttribute("aria-label", `${b.querySelector("span").textContent}（選択中）`);
    navigator.vibrate?.(8);
    const nextCheckpoint = (i + 1 === 4 || i + 1 === 8) && !store.get("seen_checkpoint", false)
      ? i + 1 : quiz.checkpointRequired;
    const progress = { answers: nextAnswers, t: Date.now(), source: quiz.source, attemptId: quiz.attemptId,
      checkpointConfirmed: quiz.checkpointConfirmed, checkpointRequired: nextCheckpoint };
    const expectedRaw = activeQuiz.progressRaw;
    const generation = activeQuiz.saveGeneration = (activeQuiz.saveGeneration || 0) + 1;
    const captured = await capturedQuizEpoch(activeQuiz);
    const saveStatus = await withSiteQuizLock(mode, () => {
      if (quiz !== activeQuiz || activeQuiz.i !== i || activeQuiz.saveGeneration !== generation || b.isConnected === false
        || location.hash !== `#/q/${mode}`) return "cancelled";
      const epochStatus = personCardEpochStatus(captured);
      if (epochStatus === "stale_epoch") return "changed";
      if (epochStatus !== "current" || activeQuiz.persistenceUnavailable) return "unavailable";
      return saveQuizProgress(mode, activeQuiz, progress, expectedRaw);
    });
    if (quiz !== activeQuiz || activeQuiz.i !== i || activeQuiz.saveGeneration !== generation || b.isConnected === false
      || location.hash !== `#/q/${mode}`) return;
    if (saveStatus === "cancelled") return;
    if (saveStatus === "changed") return showQuizProgressConflict(mode);
    if (saveStatus === "lock_error") {
      quiz.busy = false;
      renderQuiz(mode);
      toast("途中の記録を保存できませんでした。もう一度押してください");
      return;
    }
    activeQuiz.answers = nextAnswers;
    activeQuiz.checkpointRequired = nextCheckpoint;
    if (saveStatus === "unavailable") activeQuiz.persistenceUnavailable = true;
    if (saveStatus === "saved") rememberQuizCursor(mode, progress, Math.min(i + 1, qs.length - 1));
    later(120, () => { if (quiz === activeQuiz && quiz.i === i && location.hash === `#/q/${mode}`) $(".qbox")?.classList.add("out"); });
    later(300, () => {
      if (quiz !== activeQuiz || quiz.i !== i || location.hash !== `#/q/${mode}`) return;
      if (i + 1 >= qs.length) return finishQuiz(mode);
      quiz.busy = false;
      quiz.i++;
      if (checkpointPending(quiz)) return renderCheckpoint(mode, i + 1);
      renderQuiz(mode, true);
    }, 300);
  }));
}

function renderCheckpoint(mode, n) {
  const sd = engines[mode];
  const ans = Object.fromEntries(quiz.qs.map((q, k) => [q.id, quiz.answers[k]]).filter(([, v]) => v));
  const u = partialU(sd, ans);
  // 方向が相殺された回答から、補正値だけで「有力候補」を見せない。
  const hasDirection = Math.hypot(...u) > 0;
  const ranked = hasDirection ? rankTypes(sd, u) : [];
  let body;
  if (!hasDirection) {
    body = `<h2>まだ候補を絞れません</h2><p class="note">ここまでの回答では系統に差がついていません。残りの質問も、いちばん近い答えを選んでね。</p>`;
  } else if (n === 4) {
    const hot = new Set(ranked.slice(0, 5).map((t) => t.id));
    body = `<h2>4問答えた！いまの答えに近い系統</h2><p class="note">光る印は途中のヒント。12問ぜんぶ答えたら、偉人が決まります。</p>
      <div class="emblems" aria-hidden="true">${sd.types.filter((t) => t.unit).map((t) =>
        `<span class="emb ${hot.has(t.id) ? "hot" : ""}" style="background:${THEMES[t.id].accent}">${esc(t.name[0])}</span>`).join("")}</div>`;
  } else {
    const three = ranked.slice(0, 3);
    body = `<h2>8問答えた！いまの答えに近い3系統</h2><p class="note">まだ途中です。残り4問で変わることがあります。絵は系統の目印で、偉人は最後に決まります。</p>
      <div class="sils">${three.map((t) => `<div><img class="tile" src="${avatar(t.figures[0].id, true)}" alt="" style="${themeVars(t.id)}">
        <div class="note" style="margin-top:4px">${esc(typeLabel(t, mode).name)}</div></div>`).join("")}</div>`;
  }
  app.innerHTML = `<div class="checkpoint">${body}${quizUnsavedWarning(quiz)}<div class="checkpoint-nav"><button class="back" type="button">← 直前の質問へ</button></div><button class="btn start" type="button">続ける（あと${quiz.qs.length - n}問）</button></div>`;
  window.scrollTo(0, 0);
  $(".checkpoint h2").tabIndex = -1;
  $(".checkpoint h2").focus({ preventScroll: true });
  const backButton = $(".checkpoint .back");
  backButton.onclick = () => {
    if (quiz?.mode !== mode || quiz.i !== n || backButton.isConnected === false
      || location.hash !== `#/q/${mode}`) return;
    if (!quiz.persistenceUnavailable && quizProgressFreshness(mode, quiz.progressRaw) === "changed") return showQuizProgressConflict(mode);
    clearTimers();
    quiz.busy = false;
    quiz.i = n - 1;
    if (!quiz.persistenceUnavailable) {
      const saved = readQuizProgress(mode).progress;
      if (validProgress(saved) && saved.answers.length === quiz.answers.length
        && saved.answers.every((answer, index) => answer === quiz.answers[index])) rememberQuizCursor(mode, saved, quiz.i);
    }
    renderQuiz(mode, true);
  };
  const continueButton = $(".checkpoint .start");
  continueButton.onclick = async () => {
    if (continueButton.disabled) return;
    continueButton.disabled = true;
    const activeQuiz = quiz;
    const captured = await capturedQuizEpoch(activeQuiz);
    const status = await withSiteQuizLock(mode, () => {
      if (quiz !== activeQuiz || activeQuiz.i !== n || continueButton.isConnected === false
        || location.hash !== `#/q/${mode}`) return "cancelled";
      const epochStatus = personCardEpochStatus(captured);
      if (epochStatus === "stale_epoch") return "changed";
      if (epochStatus !== "current" || activeQuiz.persistenceUnavailable) return "unavailable";
      const latest = readQuizProgress(mode);
      const progress = { answers: activeQuiz.answers, t: latest.progress?.t ?? Date.now(),
        source: activeQuiz.source, attemptId: activeQuiz.attemptId,
        checkpointConfirmed: n, checkpointRequired: activeQuiz.checkpointRequired };
      return saveQuizProgress(mode, activeQuiz, progress);
    });
    if (quiz !== activeQuiz || continueButton.isConnected === false || location.hash !== `#/q/${mode}`) return;
    if (status === "cancelled") { continueButton.disabled = false; return; }
    if (status === "changed") return showQuizProgressConflict(mode);
    if (status === "lock_error") {
      continueButton.disabled = false;
      return toast("途中の記録を保存できませんでした。もう一度押してください");
    }
    if (status === "unavailable") activeQuiz.persistenceUnavailable = true;
    activeQuiz.checkpointConfirmed = n;
    if (n === 8 && !activeQuiz.persistenceUnavailable) {
      const seenStatus = await withSiteRecordsLock(() => {
        if (quiz !== activeQuiz || activeQuiz.i !== n || continueButton.isConnected === false
          || location.hash !== `#/q/${mode}`) return "cancelled";
        return personCardEpochStatus(captured) === "current" && store.set("seen_checkpoint", true)
          ? "saved" : "unavailable";
      });
      if (seenStatus === "cancelled") return;
      if (personCardEpochStatus(captured) === "stale_epoch") return showQuizProgressConflict(mode);
    }
    if (quiz === activeQuiz && activeQuiz.i === n && continueButton.isConnected !== false
      && location.hash === `#/q/${mode}`) renderQuiz(mode, true);
  };
}

// SELFの現在・前回・回数・履歴は1つの権威キーで確定する。
function diagnosisCount() {
  const snapshot = selfStateSnapshot();
  return snapshot.status === "ok" ? snapshot.state.count : 0;
}
function commitFreshSelfResult(mode, activeQuiz, code, captured) {
  if (!selfLockAvailable()) return "memory_only";
  const snapshot = readSelfState(localStorage, captured.token, verifiedResult);
  if (["damaged", "gate_unverified", "missing_after_migration", "legacy_changed", "legacy_unverified"].includes(snapshot.status))
    return "state_unverified";
  if (snapshot.status !== "ok") return "memory_only";
  let committed = snapshot;
  const sd = engines[mode];
  const r = sd.diagnose(answersOf(sd, code));
  const f = r.figure;
  const fate = fateOf(f.id);
  const ms = sd.matchups(r.u, r.type, r.tier, f.id, sd.types.length);
  const strongId = ms.strong.find((id) => id !== fate?.other);
  const weakId = ms.weak.find((id) => id !== fate?.other && id !== strongId);
  const entries = [
    { id: f.id, src: "me" },
    ...[strongId, weakId, fate?.other].map((id) => ({ id, src: "match" })),
    ...(r.levelup && !r.levelup.locked ? [{ id: r.levelup.to, src: "next" }] : []),
  ].filter((entry) => !!entry.id);
  const plan = nextDiagnosisState(snapshot.state, mode, activeQuiz.attemptId, code,
    { code, fig: f.id, at: Date.now() }, entries);
  if (plan.status === "attempt_changed") return "attempt_changed";
  if (plan.status === "already_completed_not_current") return "already_completed_not_current";
  if (plan.status === "zukan_queue_full") return "zukan_queue_full";
  if (plan.status === "ready") {
    if (personCardEpochStatus(captured) !== "current") return "changed";
    const write = writeSelfState(localStorage, plan.state, snapshot.raw, verifiedResult);
    if (write !== "saved") return write === "changed" ? "changed" : "save_unverified";
    committed = readSelfState(localStorage, captured.token, verifiedResult);
    if (committed.status !== "ok" || committed.state.done[mode]?.attemptId !== activeQuiz.attemptId)
      return "save_unverified";
  }
  const pending = committed.state.pendingZukan.find((entry) => entry.mode === mode
    && entry.attemptId === activeQuiz.attemptId);
  if (!pending) return "saved";
  if (!meetBatch(pending.entries)) return "saved_zukan_pending";
  if (personCardEpochStatus(captured) !== "current") return "saved_zukan_pending";
  const settled = nextZukanSettledState(committed.state, mode, activeQuiz.attemptId);
  return settled && writeSelfState(localStorage, settled, committed.raw, verifiedResult) === "saved"
    ? "saved" : "saved_zukan_pending";
}
async function retryPendingZukan(captured, match = () => true) {
  if (!selfLockAvailable()) return "unavailable";
  return withSiteRecordsLock(() => {
    if (personCardEpochStatus(captured) !== "current") return "changed";
    let snapshot = selfStateSnapshot();
    if (snapshot.status !== "ok") return "unavailable";
    for (const pending of snapshot.state.pendingZukan.filter(match)) {
      if (!meetBatch(pending.entries)) return "pending";
      const settled = nextZukanSettledState(snapshot.state, pending.mode, pending.attemptId);
      if (!settled || writeSelfState(localStorage, settled, snapshot.raw, verifiedResult) !== "saved")
        return "pending";
      snapshot = selfStateSnapshot();
      if (snapshot.status !== "ok") return "pending";
    }
    return "saved";
  });
}

async function finishQuiz(mode) {
  const activeQuiz = quiz;
  if (!activeQuiz || activeQuiz.mode !== mode) return;
  const questionNode = $(".qtext");
  activeQuiz.busy = true;
  const expectedRaw = activeQuiz.progressRaw;
  const generation = activeQuiz.saveGeneration;
  const captured = await capturedQuizEpoch(activeQuiz);
  const code = makeCode(activeQuiz.answers);
  const status = await withSiteQuizLock(mode, () => {
    if (quiz !== activeQuiz || activeQuiz.saveGeneration !== generation || questionNode?.isConnected === false
      || location.hash !== `#/q/${mode}`) return "cancelled";
    const epochStatus = personCardEpochStatus(captured);
    if (epochStatus === "stale_epoch") return "changed";
    activeQuiz.wasSeen = seenSelfResults().includes(mode + code);
    if (epochStatus !== "current" || activeQuiz.persistenceUnavailable) return "memory_only";
    const freshness = quizProgressFreshness(mode, expectedRaw);
    if (freshness === "changed") return "changed";
    // 保存が使えないときは、結果表示だけに進み永続記録を一切新規作成しない。
    if (freshness === "unavailable") return "memory_only";
    if (activeQuiz.legacyPossibleDuplicateCode === code) return "legacy_possible_duplicate";
    const commit = commitFreshSelfResult(mode, activeQuiz, code, captured);
    if (commit !== "saved" && commit !== "saved_zukan_pending") return commit;
    activeQuiz.progressDeleteUnconfirmed = false;
    try {
      localStorage.removeItem(quizProgressKey(mode));
      if (localStorage.getItem(quizProgressKey(mode)) !== null) throw new Error("progress not cleared");
    } catch {
      activeQuiz.progressDeleteUnconfirmed = true;
      return commit === "saved" ? "saved_progress_uncleared" : "saved_zukan_pending";
    }
    return commit;
  });
  if (quiz !== activeQuiz || activeQuiz.saveGeneration !== generation || questionNode?.isConnected === false
    || location.hash !== `#/q/${mode}`) return;
  if (status === "cancelled") return;
  if (status === "changed") return showQuizProgressConflict(mode);
  if (status !== "saved" && status !== "saved_progress_uncleared" && status !== "saved_zukan_pending"
    && status !== "save_unverified" && status !== "memory_only" && status !== "state_unverified"
    && status !== "zukan_queue_full"
    && status !== "partial" && status !== "attempt_changed" && status !== "already_completed_not_current"
    && status !== "legacy_possible_duplicate") {
    activeQuiz.busy = false;
    toast("診断を完了できませんでした。もう一度押してください");
    return;
  }
  clearQuizCursor(mode);
  justFinished = { mode, code, source: activeQuiz.source, epoch: captured,
    attemptId: activeQuiz.attemptId,
    saveStatus: status, wasSeen: !!activeQuiz.wasSeen,
    progressDeleteUnconfirmed: status === "saved_progress_uncleared" || !!activeQuiz.progressDeleteUnconfirmed };
  quiz = null;
  location.hash = `#/r/${mode}/${code}`;
}

// ---------------- 結果 ----------------
function radar(scores, { grow = false } = {}) {
  const cx = 150, cy = 140, R = 95;
  const pt = (k, r) => { const a = -Math.PI / 2 + (k * 2 * Math.PI) / 6; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const ring = (f) => AXES.map((_, k) => pt(k, R * f).join(",")).join(" ");
  const poly = AXES.map((a, k) => pt(k, (R * (grow ? 0 : scores[a])) / 100).join(",")).join(" ");
  const labels = AXES.map((a, k) => {
    const [x, y] = pt(k, R + 22);
    return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${esc(axisById[a].name)}</text>
            ${grow ? "" : `<text class="val" x="${x}" y="${y + 14}" text-anchor="middle" dominant-baseline="middle">${scores[a]}</text>`}`;
  }).join("");
  // 演出中の未完成グラフは読ませず、結果画面では6軸の確定値をまとめて伝える。
  const accessibility = grow ? 'aria-hidden="true"' : `role="img" aria-label="${esc(`6つの軸の値。0から100の目盛りで、50が中間。${AXES.map((a) => `${axisById[a].name}は${scores[a]}`).join("、")}`)}"`;
  return `<svg class="radar" viewBox="0 0 300 290" ${accessibility}>
    ${[1, 0.66, 0.33].map((f) => `<polygon points="${ring(f)}" fill="none" stroke="currentColor" stroke-opacity=".25"/>`).join("")}
    <polygon class="shape" points="${poly}" fill="var(--t-accent)" fill-opacity=".3" stroke="var(--t-accent)" stroke-width="2"/>
    ${labels}</svg>`;
}
function radarPoints(values) {
  const cx = 150, cy = 140, R = 95;
  return values.map((v, k) => { const a = -Math.PI / 2 + (k * 2 * Math.PI) / 6; return [cx + R * v / 100 * Math.cos(a), cy + R * v / 100 * Math.sin(a)].join(","); }).join(" ");
}

const pole = (ax, x) => axisById[ax][x > 0 ? "high" : "low"].label;
function reasonText(sd, a, b, strong, names = ["あなた", "相手"]) {  // 勝敗にいちばん効いた軸の組み合わせ
  let best = null;
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    if (!sd.M[i][j]) continue;
    const v = a[i] * sd.M[i][j] * b[j];
    if (!best || (strong ? v > best.v : v < best.v)) best = { v, i, j };
  }
  const mine = pole(AXES[best.i], a[best.i]), theirs = pole(AXES[best.j], b[best.j]);
  const [A, B] = names;
  return strong ? `${A}の【${mine}】が、${B}の【${theirs}】に強みを出しやすい` : `${A}の【${mine}】は、${B}の【${theirs}】に押されやすい`;
}

// 相性の関係図：左はいつも「あなた」。矢印の向きで、どちらのタイプが得意かを見せる（性格タイプの組み合わせ。史実の勝ち負けではない）
//   dir: "right"＝あなた→相手（得意） / "left"＝相手→あなた（苦手） / "both"＝互角
function relRow({ label, me, other, dir, verb, cls, why, meWho = "あなた", otherWho = "相手", otherFace }) {
  const side = (id, who, src) => `<div class="rel-side"><img class="tile" src="${src ?? relFace(id)}" alt="" style="${themeVars(fig(id).type)}">
      <div class="rel-who">${esc(who)}</div><div class="rel-nm">${esc(fig(id).name)}</div>${src ? "" : undiscTag(id)}</div>`;
  const ar = dir === "right" ? "→" : dir === "left" ? "←" : "⇄";
  return `<div class="rel ${cls}">${label ? `<div class="rel-lbl">${esc(label)}</div>` : ""}
    ${side(me, meWho, avatar(me))}<div class="rel-arrow" aria-label="${esc(verb)}"><span class="rel-verb">${esc(verb)}</span><span class="rel-ar" aria-hidden="true">${ar}</span></div>${side(other, otherWho, otherFace)}
    ${why ? `<p class="rel-why">${esc(why)}</p>` : ""}</div>`;
}
const verbsOf = (sd) => sd.modeConf.matchup_verbs ?? { strong: "得意", weak: "苦手" };  // 古いデータが残っていても動くように
// 2人の性格タイプの相性（v = battle(あなた, 相手)）を関係図にする
function duelRow(sd, mu, ou, meId, otherId, { label, otherWho, otherFace }) {
  const v = sd.battle(mu, ou), vb = verbsOf(sd);
  if (Math.abs(v) < 0.05) return relRow({ label: `${label}：互角`, me: meId, other: otherId, dir: "both", verb: "互角", cls: "even", why: "この組み合わせでは、どちらか一方が有利とは言いにくい", otherWho, otherFace });
  const lead = sd.mode === "love" ? (v > 0 ? "あなたがリードしやすい" : `${otherWho}に振り回されやすい`) : (v > 0 ? "あなたのタイプが少し有利" : `${otherWho}のタイプが少し有利`);
  return relRow({ label: `${label}：${lead}`, me: meId, other: otherId,
    dir: v > 0 ? "right" : "left", verb: v > 0 ? vb.strong : vb.weak, cls: v > 0 ? "good" : "bad",
    why: reasonText(sd, mu, ou, v > 0, ["あなた", otherWho]), otherWho, otherFace });
}

function stars(tier) {
  return `<span class="stars" role="img" aria-label="濃さ ${tier + 1}">${[0, 1, 2, 3, 4].map((k) =>
    k <= tier ? '<span class="on" aria-hidden="true">★</span>' : k <= MAX_TIER ? '<span class="off" aria-hidden="true">★</span>' : '<span class="lock" aria-hidden="true">🔒</span>').join("")}</span>`;
}

function resultCard(r, mode, who, reveal) {
  const f = r.figure, t = r.type, tl = typeLabel(t, mode);
  const artNote = (f.id === "washington" ? '<p class="note">※ 斧と桜は史実ではなく、後世の伝説を図案化したものです</p>' : "")
    + (f.id === "mori-motonari" ? '<p class="note">※ 三本の矢は後世の伝説を図案化したものです</p>' : "")
    + (f.id === "natsume-soseki" && mode === "love" ? '<p class="note">※「月が綺麗ですね」を漱石が訳したという出典は確認されていません</p>' : "");
  const lead = who === "unverified" ? "古い保存欄にある回答（本人か未確認）" : who === "readonly" ? "以前の保存結果（照合前・読取専用）" : who === "friend" ? "リンクに含まれる回答から見える姿" : who === "past" ? "以前のあなたの回答から見える姿" : who === "saved" ? "リンクから保存した、この端末の「自分の結果」" : (mode === "love" ? "恋愛についての回答から見えるあなた" : "あなた自身の回答から見えるあなた");
  return `
  <section class="rcard ${reveal ? "reveal-wait" : ""}" style="${themeVars(t.id)}">
    <p class="anata">${lead}</p>
    <div class="stage" data-state="${reveal ? "sil" : "done"}">
      <img class="avatar sil" src="${avatar(f.id, true)}" alt="">
      <img class="avatar color" src="${avatar(f.id)}" alt="${esc(f.name)}のイラスト（${esc(meta.alt[f.id] ?? "")}）">
      <div class="burst" aria-hidden="true">${"<i></i>".repeat(8)}</div>
    </div>
    ${artNote}
    <h1 class="fig-name" style="--len:${[...f.name].length}">${esc(f.name).replace(/・/g, "・<wbr>")}</h1>
    <div class="type-line"><span class="emblem">${esc(t.name[0])}</span><span class="type-name">${esc(tl.name)}</span></div>
    <p class="type-catch">${esc(tl.catch)}</p>
    <p class="serif-quote">${esc(mainLine(f.id, mode))}</p>
    <p class="note">※ 診断用の演出です。本人の発言とは限りません</p>
    <div class="meta-row">${stars(r.tier)}<span class="lv ${r.capped ? "capped" : ""}">Lv.<b>${reveal ? 1 : r.lv}</b></span></div>
    <div class="brand"><i>偉</i>世界の偉人性格診断　${esc(location.host)}</div>
  </section>`;
}

// 外部（SNS・メッセージアプリ）へ渡す共有URLに付ける目印。
// LINEはこのパラメータ付きリンクをタップすると外部ブラウザ（Safari等）へ出し、
// X・Instagramはそのままアプリ内ブラウザで開く（実機で確認済み）。既存のquery/hashは壊さない。
function withExternalBrowserParam(url) {
  try {
    const u = new URL(url);
    u.searchParams.set("openExternalBrowser", "1");
    return u.href;
  } catch { return url; }
}
function shareUrl(mode, id, code) {
  // SNS のカード画像を偉人ごとに出すため、静的ページ s/<mode>/<id>.html を経由させる
  // 形は固定：s/<mode>/<id>.html?c=<版>.<回答>。公開後は変えない（README 参照）
  const url = new URL(`s/${mode}/${id}.html?c=${encodeURIComponent(code)}`, location.href.split("#")[0]).href;
  return withExternalBrowserParam(url);
}
function shareText(r, mode, fate) {
  const f = r.figure;
  return `${mode === "love" ? "恋をした私は" : "私は"}「${f.name}」タイプだった\n「${mainLine(f.id, mode)}」\n※ 本人の発言とは限りません\n`
    + (mode === "love" && f.id === "natsume-soseki" ? "※漱石訳という出典は未確認\n" : "")
    + (f.id === "mori-motonari" ? "※三本の矢は後世の伝説イメージ\n" : "")
    + (fate ? `因縁の相手：${fig(fate.other).name}（${fate.label}）\n` : "")
    + `あなたはどの偉人？ 12問でわかる👇\n#${engines[mode].modeConf.name}`;
}

function fateOf(id) {
  const o = data.rules.battle.overrides.find((x) => x.winner === id || x.loser === id);
  return o ? { ...o, win: o.winner === id, other: o.winner === id ? o.loser : o.winner } : null;
}

function resultErrorQuizLinks(mode, freshText) {
  const snapshot = readQuizProgress(mode);
  const saved = snapshot.status === "ok" && validProgress(snapshot.progress) ? snapshot.progress : null;
  const hasAnswers = !!saved?.answers.length;
  const resumable = hasAnswers && Date.now() - saved.t < 864e5
    && !(saved.answers.length === 12 && completedQuizProgress(mode, saved, selfStateSnapshot()));
  const label = mode === "love" ? "恋愛診断" : "性格診断";
  const resumeText = resumable ? `${label}の${saved.answers.length === 12 ? "回答を見直す" : "続きから"}（${saved.answers.length} / 12）` : "";
  const freshLink = `<a class="btn ${resumable ? "sub" : "start"}" href="#/q/${mode}" data-fresh="${mode}">${hasAnswers ? "途中の答えを消して最初から診断する" : freshText}</a>`;
  const resumeLink = resumable ? `<button class="btn start" type="button" data-resume-result-error="${mode}">${resumeText}</button>` : "";
  return resumeLink + freshLink;
}
function showResultResumeUnavailable(link, reason = "expired") {
  let warning = link.nextElementSibling;
  if (!warning?.matches("[data-result-resume-warning]")) {
    warning = document.createElement("p");
    warning.className = "quiz-save-warning";
    warning.dataset.resultResumeWarning = "";
    link.insertAdjacentElement("afterend", warning);
  }
  warning.textContent = reason === "storage"
    ? "端末の途中記録を今は読み込めません。この操作では答えを消していません。もう一度試すか、端末の保存設定を確認してください。"
    : reason === "snapshot"
      ? "この画面で途中記録を確認できませんでした。この操作では答えを消していません。画面を開き直してから、もう一度試してください。"
    : "途中の記録の期限が切れたか、結果が保存済みです。続きは開かず、最初から診断するかトップで記録を確認してください。";
  warning.setAttribute("role", "alert");
}
function bindResultErrorResumeLinks(selector = "[data-resume-result-error]", snapshots = null) {
  app.querySelectorAll(selector).forEach((link) => {
    const mode = link.dataset.resumeTop ?? link.dataset.resumeResultError;
    const snapshotAtView = snapshots?.[mode] ?? readQuizProgress(mode);
    link.addEventListener("click", (event) => {
      if ((event.button !== undefined && event.button !== 0) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.isConnected === false) return;
      const latest = readQuizProgress(mode);
      if (latest.status === "unavailable") {
        event.preventDefault();
        showResultResumeUnavailable(link, "storage");
        return;
      }
      if (snapshotAtView.status === "unavailable") {
        event.preventDefault();
        showResultResumeUnavailable(link, "snapshot");
        return;
      }
      if (latest.status !== "ok" || latest.raw !== snapshotAtView.raw) {
        event.preventDefault();
        showQuizProgressConflict(mode, latest.status === "invalid");
        return;
      }
      const saved = latest.progress;
      if (!validProgress(saved) || saved.answers.length === 0 || Date.now() - saved.t >= 864e5
        || (saved.answers.length === 12 && completedQuizProgress(mode, saved, selfStateSnapshot()))) {
        event.preventDefault();
        showResultResumeUnavailable(link);
        return;
      }
      // Result routes can leave an older in-memory quiz alive. Load the latest
      // saved answers, including after another tab changed them.
      quiz = null;
      nextSrc = null;
      clearQuizCursor(mode);
      pendingGuardedResume = { mode, raw: latest.raw };
      location.hash = `#/q/${mode}`;
    });
  });
}

function renderResult(mode, code) {
  const sd = engines[mode];
  if (!validCode(sd, code)) {
    document.title = "結果リンクを開けません｜世界の偉人性格診断";
    app.style.cssText = "";
    app.innerHTML = `<section class="card"><h1>この結果リンクは開けませんでした</h1><p>リンクが途中で切れているか、対応していない形式です。</p>${resultErrorQuizLinks(mode, "新しく診断する")}<a class="btn sub" style="margin-top:10px" href="#/">トップへ</a></section>`;
    bindFreshQuizLinks();
    bindResultErrorResumeLinks();
    return;
  }
  const r = sd.diagnose(answersOf(sd, code));
  const f = r.figure;
  // 共有ページから診断へ進んでも query は残る。新たに Q12 を終えた結果を
  // 偶然同じ回答コードだった受信リンクとして扱わない。
  const fromSharedPage = !(justFinished && justFinished.mode === mode && justFinished.code === code)
    && isSharedResultEntry(location.href, mode, code);
  // 静的な共有カードの人物と、回答コードから計算した人物を照合する。
  // shared_fig / shared_mode は共有URLには含めず、静的ページからアプリへの内部遷移だけで渡す。
  const sharedUrl = new URL(location.href);
  const expectedSharedFigure = sharedUrl.searchParams.get("shared_fig");
  const expectedSharedMode = sharedUrl.searchParams.get("shared_mode");
  if (fromSharedPage && (
    (sharedUrl.searchParams.has("shared_fig")
      && (!Object.prototype.hasOwnProperty.call(SD.figures, expectedSharedFigure)
        || expectedSharedFigure !== f.id))
    || (sharedUrl.searchParams.has("shared_mode") && expectedSharedMode !== mode)
  )) {
    justFinished = null;
    document.title = "共有結果を確認できません｜世界の偉人性格診断";
    app.style.cssText = "";
    app.innerHTML = `<section class="card"><h1>この共有結果は確認できません</h1><p>カードの人物か診断の種類が、回答結果と一致しません。送った人にリンクを作り直してもらってください。</p>${resultErrorQuizLinks(mode, "自分を診断する")}<a class="btn sub" style="margin-top:10px" href="#/">トップへ</a></section>`;
    bindFreshQuizLinks();
    bindResultErrorResumeLinks();
    return;
  }
  const pendingFresh = justFinished && justFinished.mode === mode && justFinished.code === code ? justFinished : null;
  const renderEpochStatus = pendingFresh?.epoch?.status === "present"
    ? personCardEpochStatus(pendingFresh.epoch) : "epoch_unavailable";
  if (pendingFresh && renderEpochStatus === "stale_epoch") {
    justFinished = null;
    document.title = "診断の記録が変わりました｜世界の偉人性格診断";
    app.style.cssText = "";
    app.innerHTML = `<section class="card"><h1>別のタブで端末の記録が変わりました</h1><p>この画面の診断結果は、保存済みの自分の結果として表示しません。途中の答えがあれば続きから開くか、新しく診断するか、この端末の記録を開き直してください。</p>${resultErrorQuizLinks(mode, "新しく診断する")}<a class="btn sub" href="#/me">この端末の記録を見る</a></section>`;
    bindFreshQuizLinks();
    bindResultErrorResumeLinks();
    return;
  }
  // Q12 の保存後でも、画面遷移までに別タブが以前の結果を戻せる。
  // 保存成功を記憶しただけでは「現在の結果」と断定せず、表示直前の権威記録で確認する。
  const committedFresh = pendingFresh && ["saved", "saved_progress_uncleared", "saved_zukan_pending"].includes(pendingFresh.saveStatus);
  const stateAtResult = committedFresh ? selfStateSnapshot() : null;
  if (committedFresh && stateAtResult.status !== "ok") {
    justFinished = null;
    document.title = "診断の記録を確認できません｜世界の偉人性格診断";
    app.style.cssText = "";
    app.innerHTML = `<section class="card"><h1>この端末の結果を確認できません</h1><p>診断結果を保存しましたが、いまの保存状態を読み取れません。今回の結果が現在の結果かは確認できないため、この画面では表示しません。必要ならこのページのURLを控え、端末の記録を確認してください。</p><p class="note">このURLを知る人は12問の答えを読み取れます。</p><a class="btn sub" href="#/me">この端末の記録を見る</a><a class="btn sub" href="#/">トップへ</a></section>`;
    return;
  }
  if (committedFresh && stateAtResult.state.current[mode]?.code !== code) {
    justFinished = null;
    document.title = `${f.name}タイプ｜${sd.modeConf.name}`;
    return renderFriend(sd, mode, code, r, null, fromSharedPage);
  }
  const mine = stateAtResult?.state.current[mode] ?? savedResult(mode);
  const fresh = !!pendingFresh;
  const freshSource = fresh ? pendingFresh.source : null;
  const progressDeleteUnconfirmed = fresh && pendingFresh.progressDeleteUnconfirmed;
  const freshSaveStatus = fresh && renderEpochStatus === "epoch_unavailable"
    && (["saved", "saved_progress_uncleared", "saved_zukan_pending"].includes(pendingFresh.saveStatus))
    ? "save_unverified" : fresh ? pendingFresh.saveStatus : null;
  const shortReveal = fresh && !!pendingFresh.wasSeen;
  justFinished = null;
  const who = fromSharedPage ? "friend" : (fresh || mine?.code === code ? "me" : "friend");
  const reveal = fresh;
  document.title = `${f.name}タイプ｜${sd.modeConf.name}`;
  if (fresh) track("quiz_complete", { mode, source: freshSource, figure: f.id, type: r.type.id, tier: r.tier + 1, capped: r.capped ? "yes" : "no" });

  if (who === "friend") return renderFriend(sd, mode, code, r, null, fromSharedPage);
  const pendingSnapshot = selfStateSnapshot();
  const pendingFigure = pendingSnapshot.status === "ok"
    && pendingSnapshot.state.pendingZukan.some((entry) => entry.mode === mode && entry.code === code);

  const fate = fateOf(f.id);
  const ms = sd.matchups(r.u, r.type, r.tier, f.id, sd.types.length);
  const strongId = ms.strong.find((id) => id !== fate?.other);
  const weakId = ms.weak.find((id) => id !== fate?.other && id !== strongId);
  // 新規結果の保存は診断完了時の site → quiz ロック内で確定済み。表示時は読み取り専用。
  const localSaveOk = !fresh || ["saved", "saved_progress_uncleared"].includes(freshSaveStatus);
  const resultAttemptId = pendingFresh?.attemptId
    || (pendingSnapshot.status === "ok" && pendingSnapshot.state.done[mode]?.code === code
      ? pendingSnapshot.state.done[mode].attemptId : null);
  const startedFromShared = readSharedReturn(() => sessionStorage, mode,
    currentClearEpoch(), resultAttemptId);
  const memoryFriend = lastSharedInMemory[mode];
  const friend = startedFromShared || (memoryFriend?.epoch && viewEpochMatches(memoryFriend.epoch)
    ? memoryFriend : null);
  const validFriend = friend && typeof friend.code === "string" && typeof friend.fig === "string"
    && SD.figures[friend.fig] && validCode(sd, friend.code)
    && sd.diagnose(answersOf(sd, friend.code)).figure.id === friend.fig;
  const other = savedResult(OTHER[mode]);

  const tx = texts[f.id];
  const search = (s) => `https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(s)}`;
  const matchRow = (kind, id) => id ? relRow({ label: labels[kind], me: f.id, other: id, dir: kind === "strong" ? "right" : "left",
    verb: verbsOf(sd)[kind], cls: kind === "strong" ? "good" : "bad",
    why: reasonText(sd, r.u, unit(id), kind === "strong") }) : "";
  const unit = (id) => sd.type(fig(id).type).unit;
  const labels = sd.modeConf.matchup_labels;
  const fateHtml = fate ? `
    <div class="fate"><img class="tile" src="${relFace(fate.other)}" alt="" style="${themeVars(fig(fate.other).type)}">
      <div><div class="lbl">⚔️ 史実の因縁 ― ${esc(fate.label)}（史実ネタ。性格の相性とは別）</div>
        <div class="nm">${esc(fig(fate.other).name)}${undiscTag(fate.other)}</div><div class="tx">${esc(fate.text)}</div></div></div>` : "";
  let friendHtml = "";
  if (validFriend && friend.code !== code) {
    const fu = sd.score(answersOf(sd, friend.code));
    friendHtml = duelRow(sd, r.u, fu, f.id, friend.fig, { label: "以前に開いた共有リンク", otherWho: "リンクの結果" });
  }
  const h = r.levelup;
  let levelHtml;
  if (!h) levelHtml = `<p>この系統の<b>最高段階</b>です。</p>`;
  else {
    let lead;
    if (h.reason === "plan_cap") lead = `無料版の上限 <b>Lv.${r.lv}</b> に到達。この上に、まだ偉人が待っている。`;
    else if (h.reason === "too_many_neutral") lead = `もし「どちらとも言えない」がもう少し少なかったら…`;
    else if (h.points == null) lead = `もしあなたの軸が、もう少しずつ伸びていたら…`;
    else if (h.direction === "center") lead = `もしあなたの【<span class="hint-axis">${esc(axisById[h.axis].name)}</span>】の偏りが <b>${h.points}点</b> 小さかったら…`;
    else lead = `もしあなたの【<span class="hint-axis">${esc(axisById[h.axis][h.direction === "up" ? "high" : "low"].hint)}</span>】が あと <b>+${h.points}</b> だったら…`;
    const nf = fig(h.to);
    levelHtml = `<p>${lead}</p>` + (h.locked
      ? `<div class="next"><div class="next-tile" style="--t-bg:${THEMES[nf.type].bg}"><img src="${avatar(h.to, true)}" alt="まだ見ぬ偉人のシルエット"><span class="lock">🔒</span></div>
           <div><div class="qq">？？？</div><div class="hint">ヒント：${esc(texts[h.to]?.silhouette_hint)}</div></div></div>
         <p class="note">この人物は現在の診断結果ではありません。</p>`
      : `<div class="next"><div class="next-tile" style="--t-bg:${THEMES[nf.type].bg}"><img src="${relFace(h.to)}" alt=""></div>
           <div><div class="hint">あなたは</div><div class="qq">${esc(nf.name)}</div><div class="hint">になっていた${undiscTag(h.to)}</div></div></div>`);
  }
  const sc = r.scores, hi = AXES.reduce((a, b) => (sc[b] > sc[a] ? b : a)), lo = AXES.reduce((a, b) => (sc[b] < sc[a] ? b : a));
  const scoreTags = sc[hi] - sc[lo] < 5
    ? '<span class="tag good">6つの軸に大きな差はありません</span>'
    : `<span class="tag good">高め：${esc(pole(hi, 1))}</span><span class="tag weak">低め：${esc(axisById[lo].name)}</span>`;
  const returnSharedHtml = validFriend ? `<div class="recent-shared-return ${reveal ? "reveal-hide" : ""}">
      <a class="btn sub" href="${esc(sharedResultViewPath(mode, friend.code))}">共有リンクの結果を見る：${esc(fig(friend.fig).name)}</a>
      <p class="social-note">${startedFromShared ? "このタブで診断を始めたときの共有結果です。" : "以前にこのブラウザーで開いた共有結果です。"}自分のリンクも含み、送り主は確認できません。友達のカードはリンク先で手動で追加できます。</p></div>` : "";
  // An unsaved fresh result cannot be reconstructed as SELF after a re-render;
  // do not pair it with the other saved mode as if it were the current result.
  const otherHtml = mine?.code === code && other && validCode(engines[OTHER[mode]], other.code) ? (() => {
    const [n, l] = mode === "normal" ? [f.id, other.fig] : [other.fig, f.id];
    return `<section class="card"><h2>${n === l ? "ふだんも恋も同じ偉人" : "表の顔 × 恋の顔"}</h2>
      <div class="duo"><div><img class="tile" src="${avatar(n)}" alt="" style="${themeVars(fig(n).type)}"><div class="lbl">ふだんは</div><div class="nm">${esc(fig(n).name)}</div></div>
        <div class="x">${n === l ? "＝" : "×"}</div>
        <div><img class="tile" src="${avatar(l)}" alt="" style="${themeVars(fig(l).type)}"><div class="lbl">恋をすると</div><div class="nm">${esc(fig(l).name)}</div></div></div>
      <p class="social-note">Xではふだんと恋愛の偉人名を紹介します。リンクで開けるのは、いま表示中の${mode === "normal" ? "性格" : "恋愛"}診断の結果だけです。リンクを知る人は、その12問の答えを読み取れます。</p>
      <button class="btn sub" style="margin-top:12px" data-duo="${n},${l}">${n === l ? "同じ偉人だったとXに投稿" : "偉人の組み合わせをXに投稿"}</button></section>`;
  })() : `<section class="card"><h2>${mode === "normal" ? "恋愛バージョン" : "性格バージョン"}</h2>
      <p style="margin:0 0 12px">${mode === "normal" ? "恋をしたら、あなたは別の偉人かも？" : "ふだんのあなたは、どの偉人？"}（約1分半）</p>
      <a class="btn ${mode === "normal" ? "love-sub" : "sub"}" data-fresh="${OTHER[mode]}" data-src="other_mode" href="#/q/${OTHER[mode]}">${mode === "normal" ? "💘 恋愛診断をやる" : "性格診断をやる"}</a></section>`;
  app.style.cssText = themeVars(r.type.id);
  app.innerHTML = `
    ${resultCard(r, mode, !fresh && mine?.via === "link" ? "saved" : "me", reveal)}
    ${freshSaveStatus === "memory_only" ? '<p class="note" role="alert">結果はこの画面で見られますが、この端末への保存はできませんでした。図鑑にも登録していません。必要ならページのリンクを控えてください。</p>' : ""}
    ${freshSaveStatus === "state_unverified" ? '<p class="note" role="alert">元の自己診断記録を確認できないため、今回の結果は保存していません。元の記録は上書きしていません。「この端末の記録」で状態を確認し、結果リンクも控えてください。</p>' : ""}
    ${freshSaveStatus === "zukan_queue_full" ? '<p class="note" role="alert">図鑑に未反映の結果がたまっているため、今回の結果は保存していません。「この端末の記録」で図鑑登録を再試行してください。元の結果は変更していません。</p>' : ""}
    ${freshSaveStatus === "save_unverified" ? '<p class="note" role="alert">診断結果を保存できたか確認できませんでした。途中の回答は残してあります。リンクを控え、端末の記録を確認してから再試行してください。</p>' : ""}
    ${freshSaveStatus === "partial" ? '<p class="note" role="alert">結果は表示できますが、端末への保存は一部だけ成功した可能性があります。診断回数・自分の結果・図鑑が一致しない場合があります。途中の回答は削除していません。必要ならこの結果リンクを控えてください。</p>' : ""}
    ${freshSaveStatus === "saved_zukan_pending" ? '<p class="note" role="alert">自分の結果・診断回数・履歴は保存済みですが、図鑑への登録を確認できませんでした。下のボタンから図鑑登録だけを再試行できます。</p>' : ""}
    ${pendingFigure && !fresh ? '<p class="note" role="alert">この結果の図鑑への登録は未確認です。下のボタンで再試行できます。</p>' : ""}
    ${freshSaveStatus === "attempt_changed" ? '<p class="note" role="alert">この診断は前の回答で保存済みです。回答を変えた今回の結果は端末に保存していません。結果リンクを控えるか、新しく診断を始めてください。</p>' : ""}
    ${freshSaveStatus === "already_completed_not_current" ? '<p class="note" role="alert">この途中記録の診断は以前に完了しています。その後、自分の結果は別のものに戻されています。今回の画面は保存済みの現在結果ではなく、診断回数も増やしていません。</p>' : ""}
    ${freshSaveStatus === "legacy_possible_duplicate" ? '<p class="note" role="alert">旧版の途中記録と同じ回答の結果が、すでにこの端末にあります。前回の完了記録か判別できないため、診断回数を増やさず、途中記録も残しました。この結果は表示のみです。</p>' : ""}
    ${progressDeleteUnconfirmed ? '<p class="note" role="alert">途中の記録が消えたか確認できませんでした。この端末に残っている可能性があります。結果は表示できます。</p>' : ""}
    ${freshSource === "friend" ? returnSharedHtml : ""}
    <p class="note share-warning ${reveal ? "reveal-hide" : ""}" style="margin:12px 0 4px">${freshSource === "friend" ? "結果は自動では届きません。最初にリンクをくれた友達を選んで送ってください。" : "結果は自動では届きません。友達からリンクをもらった場合は、その相手を選んで返してください。"}結果リンクを知る人は、12問の答えを読み取れます。</p>
    <div class="share-row after ${reveal ? "reveal-hide" : ""}">
      <button class="btn primary wide" data-share="friend">${typeof navigator.share === "function"
        ? (freshSource === "friend" ? "友達に結果を返す" : "友達に結果を送る")
        : "送る文章とリンクをコピー"}</button>
      <button class="btn sub" data-share="line">LINEで送る</button>
      <button class="btn sub" data-share="x">Xでポスト</button>
      <button class="btn sub" data-share="image">画像を保存</button>
      <button class="btn sub" data-share="copy">リンクをコピー</button>
    </div>
    <p class="note ${reveal ? "reveal-hide" : ""}" style="margin:4px 0 12px">画像だけでは友達が結果を開けません。${freshSource === "friend" ? "最初にリンクをくれた友達へ結果リンクを返してください。結果は自動では届きません。" : "友達には結果リンクを送ってください。"}${typeof navigator.share !== "function" ? "コピーした文章とリンクは、LINEなどの会話に貼り付けて送ってください。" : ""}</p>
    ${!localSaveOk && freshSaveStatus !== "saved_zukan_pending" ? '<p class="note" role="alert">このブラウザでは結果または図鑑の登録を確認できませんでした。必要なら、このページのリンクを控えてください。</p>' : ""}
    ${freshSource !== "friend" ? returnSharedHtml : ""}
    ${(() => { const prev = previousResult(mode); return verifiedResult(mode, prev) && prev.code !== code
      ? `<p class="note prev-link">前の結果：<a href="#/r/${mode}/${prev.code}">${esc(fig(prev.fig).name)}（見る・戻す）</a></p>` : ""; })()}
    <section class="card"><h2>偉人に重ねたあなたの物語</h2>
      ${mode === "love" && tx.love.note ? `<p class="love-note">※${esc(tx.love.note)}</p>` : ""}
      <p class="body">${esc(tx.body)}</p>
      <details><summary>元ネタを見る</summary><p>${esc(tx.motoneta.text)}</p>
        <div class="chips">${tx.motoneta.search.map((s) => `<a class="chip" href="${search(s)}" target="_blank" rel="noopener">🔍 ${esc(s)}</a>`).join("")}</div></details>
    </section>
    <section class="card"><h2>相性</h2>
      <p class="rel-note">性格タイプの組み合わせで見た相性です（史実の勝ち負けではありません）。矢印の先が、押されやすい側。</p>
      <div class="rels">${friendHtml}${matchRow("strong", strongId)}${matchRow("weak", weakId)}${!friendHtml && !strongId && !weakId ? '<p class="note">この回答では、相性の候補を表示できませんでした。</p>' : ""}</div>
      ${fateHtml ? `<div class="fate-wrap">${fateHtml}</div>` : ""}
    </section>
    <section class="card levelup"><h2>もしも…</h2>${levelHtml}</section>
    <section class="card"><h2>あなたの6つの軸</h2>${radar(sc)}
      <div class="tags">${scoreTags}</div></section>
    <p class="note">★とLv.は同じ系統内の診断段階です。偉人の優劣ではありません。</p>
    ${otherHtml}
    ${OTHER_PILOT ? `<section class="card social-entry"><h2>友達から見た自分も、聞いてみる？</h2>
      <p>友達に12問答えてもらい、その答えを受け取る試作です。人物への当てはめはまだ行いません。</p>
      <a class="btn sub" href="#/ask">友達に12問答えてもらう（試作）</a></section>` : ""}
    <details class="card social-entry"><summary>友達から同じ結果リンクが届いた？</summary>
      <p>自分の共有リンクを開いた場合もこの画面になります。実際に別の人から届いた結果のときだけ、人物カードへ追加してください。追加すると、この端末にカード名と回答入りの結果リンクが保存されます。返事を送りたい場合は、自分の結果リンクをコピーして会話に貼り付けて送ってください。</p>
      <button class="btn sub" data-add-same-person>友達の人物カードに追加</button>
      <button class="btn sub" data-share="copy">自分の結果リンクをコピー</button></details>
    <section class="card"><h2>図鑑</h2>${zukanStorageAlert()}
      <div class="progress-line"><span><b>${zukanCount()}</b> / ${FREE.length}人を発見</span><div class="bar"><i style="width:${(zukanCount() / FREE.length) * 100}%"></i></div></div>
      <a class="btn sub" style="margin-top:12px" href="#/zukan">図鑑を見る</a>
      </section>
    <div style="display:grid;gap:10px;margin-top:20px">
      ${pendingFigure ? '<button class="btn sub" data-retry-self-zukan>図鑑への登録を再試行</button>' : ""}
      ${["partial", "save_unverified", "zukan_queue_full", "state_unverified"].includes(freshSaveStatus) ? `<a class="btn sub" href="#/q/${mode}">途中の回答に戻って保存を再試行</a>` : ""}
      <a class="btn sub" data-fresh="${mode}" data-src="retry" href="#/q/${mode}">もう一度診断する</a>
      ${["partial", "save_unverified", "saved_zukan_pending", "state_unverified", "zukan_queue_full", "attempt_changed", "already_completed_not_current", "legacy_possible_duplicate"].includes(freshSaveStatus)
        ? '<p class="note" style="margin:0">「もう一度診断する」は残っている途中の回答を消し、1問目から始めます。結果を残したい場合は先にリンクを控えてください。</p>' : ""}
      <a class="btn sub" href="#/me">この端末の記録</a>
      <a class="btn sub" href="#/">トップへ</a></div>
    <p class="note" style="margin-top:16px"><a href="#/about">このサイトについて</a></p>
    <div class="result-float-stack"><button class="fab" data-share="friend" hidden>${typeof navigator.share === "function" ? "結果リンクを送る" : "送る文章とリンクをコピー"}</button></div>`;

  // ボタンだけを拾う読み上げ操作でも、回答コードを含むリンクの注意が伝わるようにする。
  app.querySelectorAll('[data-share="friend"], [data-share="line"], [data-share="x"], [data-share="copy"]').forEach((b) => {
    b.setAttribute("aria-label", `${b.textContent.trim()}。結果リンクを知る人は12問の答えを読み取れます`);
  });
  const duoShareButton = $("[data-duo]");
  duoShareButton?.setAttribute("aria-label", `${duoShareButton.textContent.trim()}。リンクで開けるのは、いま表示中の${mode === "normal" ? "性格" : "恋愛"}診断の結果だけです。リンクを知る人は12問の答えを読み取れます`);
  // シェア
  const url = shareUrl(mode, f.id, code), text = shareText(r, mode, fate);
  const currentResultView = capturedSelfResultViewGuard(mode, code, mine?.code === code);
  const otherFigureAtRender = other?.fig ?? null;
  const currentDuoView = () => {
    const snapshot = selfStateSnapshot();
    return currentResultView() && snapshot.status === "ok"
      && (snapshot.state.current[OTHER[mode]]?.fig ?? null) === otherFigureAtRender;
  };
  const resultHashAtRender = location.hash;
  app.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", async (e) => {
    e.preventDefault();
    const currentShareView = () => b.isConnected !== false
      && location.hash === resultHashAtRender && currentResultView();
    if (!currentShareView()) {
      revokeStaleSelfView();
      route();
      return;
    }
    const ch = b.dataset.share;
    track("share_click", { channel: ch, mode, figure: f.id });
    if (ch === "friend") shareLink(url, `私は「${f.name}」タイプだった！あなたも診断して、結果リンクを返してね。`, currentShareView);
    if (ch === "copy") copyLink(url, "リンクをコピーしました", currentShareView);
    if (ch === "image") shareImage(r, mode, b, currentShareView);
    if (ch === "x") open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, "_blank", "noopener");
    if (ch === "line") open(`https://line.me/R/share?text=${encodeURIComponent(`${f.name}タイプだった😂 あなたは誰？ ${url}`)}`, "_blank", "noopener");
  }));
  bindFreshQuizLinks();
  const retryFigureEpoch = capturePersonCardEpoch();
  $("[data-retry-self-zukan]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const status = await retryPendingZukan(await retryFigureEpoch,
      (entry) => entry.mode === mode && entry.code === code);
    if (!button.isConnected) return;
    button.disabled = false;
    if (status !== "saved") return toast("図鑑への登録を確認できませんでした。端末の記録を確認してください");
    route();
    toast("図鑑への登録を確認しました");
  });
  const personCardEpoch = capturePersonCardEpoch();
  $("[data-add-same-person]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const status = await addPersonCardFromButton(button, mode, code, f.id, personCardEpoch);
    if (status === "cancelled") return;
    if (status === "changed") return toast("別タブでカードが変わりました。もう一度押してください");
    if (status === "saved_without_zukan") return toast("カードは保存しました。図鑑への名前登録は確認できませんでした");
    if (status !== "saved") return showPersonCardAddFailure(button, status);
    toast("友達の人物カードを1枚追加しました");
  });
  const duoButton = $("[data-duo]");
  duoButton?.addEventListener("click", () => {
    if (duoButton.isConnected === false || location.hash !== resultHashAtRender || !currentDuoView()) {
      route();
      return;
    }
    const [n, l] = duoButton.dataset.duo.split(",");
    track("share_click", { channel: "duo", figure: f.id });
    const t = `ふだんの私は「${fig(n).name}」、恋をすると「${fig(l).name}」でした。\nリンクで見られるのは${mode === "normal" ? "ふだん" : "恋愛"}の結果だけ。あなたは？👇\n#偉人性格診断`;
    open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}&url=${encodeURIComponent(url)}`, "_blank", "noopener");
  });
  // スクロールしても消えないシェアボタン
  const fab = $(".fab"), row = $(".share-row");
  // 古いWebViewでは監視APIがない。通常の共有ボタン行はそのまま使える。
  if (typeof IntersectionObserver === "function")
    new IntersectionObserver(([e]) => (fab.hidden = e.isIntersecting || e.boundingClientRect.top > 0)).observe(row);
  prerenderShare(r, mode);
  window.scrollTo(0, 0);
  if (reveal) runReveal(r, mode, shortReveal, localSaveOk ? () => {
    if (currentResultView()) toast(`図鑑に登録しました（${zukanCount()} / ${FREE.length}）`);
  } : null);
  else later(0, () => { $(".stage").dataset.state = "done"; });
  attachMotion(f.name);
  // The label and controls on this page describe the current saved SELF only
  // while the same-mode authority still points to this answer code.
  activeSelfResult = mine?.code === code ? { mode, code, otherFigure: otherFigureAtRender, unverified: false } : null;
}

// 結果リンクの表示。URLだけでは送り主が友達か本人か判断できない。
function renderFriend(sd, mode, code, r, personCard = null, fromSharedPage = false) {
  const f = r.figure;
  const own = seenSelfResults().includes(mode + code);  // この端末で自分で診断したことがある結果
  const prevE = previousResult(mode);
  const prevHere = verifiedResult(mode, prevE) && prevE.code === code; // 入れかえ前の結果
  const prevLink = !personCard && !fromSharedPage && !own && prevHere && prevE.via === "link"; // 入れかえ前の結果が、リンクから保存したもの
  const past = !personCard && !fromSharedPage && (own || (prevHere && !prevLink)); // 以前のあなた自身の結果
  if (fromSharedPage && !personCard) {
    // 共有ページ経由の往復だけタブ内に保持。直URLや過去結果を受信扱いしない。
    lastSharedInMemory[mode] = { code, fig: f.id, epoch: currentClearEpoch() };
  }
  const tx = texts[f.id];
  app.style.cssText = themeVars(r.type.id);
  const mine = savedResult(mode);
  const ownReply = mine && mine.via !== "link" && validCode(sd, mine.code);
  let compat = "";
  if (!past && mine && mine.code === code) {
    compat = `<p class="social-note">この端末の自分の回答と同じ結果です。回答コードだけでは同じ人かどうか分かりません。</p>`;
  } else if (!past && mine) {
    const mu = sd.score(answersOf(sd, mine.code));
    compat = `<section class="card"><h2>あなたとの相性</h2>
      <p class="rel-note">性格タイプの組み合わせで見た相性です（史実の勝ち負けではありません）。矢印の先が、押されやすい側。</p>
      <div class="rels">${duelRow(sd, mu, r.u, mine.fig, f.id, { label: "結果リンクの偉人", otherWho: "リンクの結果", otherFace: avatar(f.id) })}</div></section>`;
  }
  if (fromSharedPage && !personCard && !past && !prevLink) track("friend_view", { mode, figure: f.id, has_mine: mine && validCode(sd, mine.code) ? "yes" : "no" });
  const personCta = personCard ? `<section class="card social-entry"><h2>保存した人物カード</h2>
    <p>${esc(personCard.label || "友達カード")}の共有結果です。あなた自身の診断結果とは別に保存しています。</p>
    <a class="btn sub" href="#/people">人物カード一覧へ</a></section>` : past || prevLink ? `<details class="card social-entry"><summary>友達がこの結果と同じだった場合</summary>
    <p>以前の自分や保存したリンクと同じ回答でも、別の友達から届いた結果なら人物カードに追加できます。追加すると、この端末にカード名と回答入りの結果リンクが保存されます。</p>
    <button class="btn sub" data-add-person>友達の人物カードに追加する</button></details>` : `<section class="card social-entry"><h2>結果リンクを人物カードへ</h2>
    <p>友達から届いた結果だけカードに追加してください。リンクの送り主は確認できません。追加すると、この端末にカード名と回答入りの結果リンクが、あなたの結果とは別に保存されます。</p>
    ${peopleCards().some((x) => x.mode === mode && x.code === code)
      ? '<p class="social-note">同じ回答のカードが保存されています。別の人から届いた結果なら、もう1枚追加できます。</p>'
      : ""}<button class="btn sub" data-add-person>人物カードに追加する</button></section>`;
  app.innerHTML = `
    <div class="friend-head">${personCard
      ? `<h1>${esc(personCard.label || "友達カード")}の結果<br>「${esc(f.name)}」<span class="friend-result-kind">タイプ</span></h1><p class="note friend-origin-note">人物カードに保存した共有結果です。あなたの結果とは別です。</p>`
      : past || prevLink
      ? `<h1>${prevLink ? "前に保存した、リンクの結果" : "以前のあなたの結果"}<br>「${esc(f.name)}」<span class="friend-result-kind">タイプ</span></h1><p class="note friend-origin-note">この端末にも同じ答えがあります。送り主は分かりません。</p>${mine ? `<p class="note" style="margin:6px 0 0">いまの自分の結果は「${esc(fig(mine.fig).name)}」です</p>` : ""}`
      : `<h1>結果リンクの偉人は<br>「${esc(f.name)}」<span class="friend-result-kind">タイプ</span></h1><p class="note friend-origin-note">このリンクに記録された回答の結果です。送り主は確認できず、あなた自身の結果と同じになることもあります。</p>`}
      <p class="back-links">${mine && validCode(sd, mine.code) ? `<a href="${esc(fromSharedPage && mine.code === code ? withoutSharedResultParam(location.href) : `#/r/${mode}/${mine.code}`)}">← 自分の結果（${esc(fig(mine.fig).name)}）へ戻る</a>` : ""}<a href="#/me">この端末の記録</a></p></div>
    ${resultCard(r, mode, past ? "past" : prevLink ? "saved" : "friend", false)}
    ${personCta}
    ${fromSharedPage && !personCard && !past && !prevLink && ownReply ? `<section class="card social-entry"><h2>自分の結果を友達に返す</h2>
      <p>友達から届いたリンクなら、最初にリンクを送った友達を選んで、自分の結果リンクを返してください。結果は自動では届きません。自分で開いたリンクなら操作は不要です。</p>
      <p class="social-note">送る結果リンクを知る人は、あなたの12問の答えを読み取れます。</p>
      <button class="btn start" data-return-self>${typeof navigator.share === "function" ? "自分の結果リンクを送る" : "返す文章とリンクをコピー"}</button>
      ${typeof navigator.share !== "function" ? '<p class="social-note">コピーした文章とリンクは、LINEなどの会話に貼り付けて送ってください。</p>' : ""}</section>` : ""}
    <div style="display:grid;gap:8px;margin:16px 0">
      ${mine ? (past || prevLink ? "" : `<a class="btn sub" data-fresh="${mode}" data-src="${fromSharedPage ? "friend" : "result_link"}" href="#/q/${mode}">もう一度12問で診断する</a><p class="note" data-fresh-save-note style="margin:0">新しい結果が、この端末の現在の結果になります。</p>${compat}`) : `<a class="btn start" data-fresh="${mode}" data-src="${fromSharedPage ? "friend" : "result_link"}" href="#/q/${mode}">あなたは誰？ 12問で診断する</a>
      <p class="note" style="margin:0">答えたら自分の結果リンクを共有できます。友達から届いたなら、その友達へ返せます。</p>`}
    </div>
    <details class="card"><summary>${esc(f.name)}タイプってどんな人？</summary><p class="body">${esc(tx.body)}</p></details>
    <div class="claim">${past
      ? `<button class="btn sub" data-restore-self>以前の自己診断結果を、現在の自分の結果に戻す</button>`
      : `<p class="note">${personCard ? "人物カードに保存した結果です。自分の診断結果は上書きしません。" : prevLink ? "以前リンクから保存した結果です。自分の診断結果は上書きしません。" : "結果リンクを見ています。この回答は、見るだけでは端末の結果記録へ追加せず、自分の診断結果も上書きしません。"}</p>`}</div>`;
  bindFreshQuizLinks();
  $("[data-return-self]")?.setAttribute("aria-label", `${typeof navigator.share === "function" ? "自分の結果リンクを送る" : "返す文章とリンクをコピー"}。リンクを知る人は12問の答えを読み取れます`);
  const returnSelfButton = $("[data-return-self]");
  const returnSelfView = capturedSelfViewGuard();
  const returnSelfHash = location.hash;
  const canReturnSelf = () => returnSelfView() && returnSelfButton?.isConnected
    && location.hash === returnSelfHash && savedResult(mode)?.code === mine?.code;
  returnSelfButton?.addEventListener("click", () => {
    if (!canReturnSelf()) { route(); return; }
    shareLink(shareUrl(mode, mine.fig, mine.code), "あなたから届いた結果を見たよ。私の結果も送るね。", canReturnSelf);
  });
  const personCardEpoch = capturePersonCardEpoch();
  $("[data-add-person]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const status = await addPersonCardFromButton(button, mode, code, f.id, personCardEpoch);
    if (status === "cancelled") return;
    if (status === "changed") return toast("別タブでカードが変わりました。もう一度押してください");
    if (status === "saved_without_zukan") {
      location.hash = "#/people";
      return toast("カードは保存しました。図鑑への名前登録は確認できませんでした");
    }
    if (status !== "saved") return showPersonCardAddFailure(button, status);
    location.hash = "#/people";
    toast("人物カードに保存しました");
  });
  if (past) {
    const stateAtDisplay = selfStateSnapshot();
    const restoreEpoch = capturePersonCardEpoch();
    const refreshChanged = () => {
      route();
      focusPageHeading();
      toast("別タブで自己診断結果が変わりました。更新して選び直してください");
    };
    const restoreButton = $("[data-restore-self]");
    restoreButton.onclick = async () => {
      const captured = await restoreEpoch;
      if (!selfLockAvailable()) return toast("このブラウザーでは結果を安全に戻せません。別のブラウザーでお試しください");
      if (stateAtDisplay.status !== "ok" || personCardEpochStatus(captured) !== "current"
        || selfStateSnapshot().raw !== stateAtDisplay.raw) return refreshChanged();
      if (!confirm(`以前の自己診断結果（${f.name}）を、現在の自分の結果に戻しますか？`)) return;
      const status = await withSiteRecordsLock(() => {
        if (!restoreButton.isConnected || personCardEpochStatus(captured) !== "current") return "changed";
        const latest = selfStateSnapshot();
        if (latest.status !== "ok" || latest.raw !== stateAtDisplay.raw) return "changed";
        const next = nextRestoredState(latest.state, mode, { code, fig: f.id, at: Date.now() });
        return writeSelfState(localStorage, next, latest.raw, verifiedResult);
      });
      if (!restoreButton.isConnected) return;
      if (status === "changed") return refreshChanged();
      if (status !== "saved") return toast("結果を戻したか確認できませんでした。端末の記録を確認してください");
      route();
      focusPageHeading();
    };
  }
  $(".stage").dataset.state = "done";
  attachMotion(f.name);
  window.scrollTo(0, 0);
}

// 人物カード固有IDから開く。回答コードが自分と同じでも、友達の表示文脈を保つ。
function renderPersonCard(id, snapshot = readPersonCardStorage()) {
  activePersonCardView = { hash: location.hash, id, status: snapshot.status,
    raw: snapshot.raw ?? null, pending: false };
  if (snapshot.status !== "ok") return renderPersonCardUnreadable(snapshot.status);
  const cards = personCardsFromRaw(snapshot.cards).cards;
  const index = cards.findIndex((x) => x.id === id);
  const card = cards[index];
  if (!card) {
    activePersonCardView.invalidated = true;
    return renderUnavailable();
  }
  activePersonCardView.identity = { mode: card.mode, code: card.code, fig: card.fig, at: card.at };
  const displayCard = { ...card, label: personCardDisplayName(card, index) };
  const sd = engines[card.mode];
  let r;
  try { r = sd.diagnose(answersOf(sd, card.code)); }
  catch {
    activePersonCardView.invalidated = true;
    return renderUnavailable();
  }
  if (r.figure.id !== card.fig) {
    activePersonCardView.invalidated = true;
    return renderUnavailable();
  }
  document.title = `${displayCard.label}｜${r.figure.name}タイプ`;
  renderFriend(sd, card.mode, card.code, r, displayCard);
}

function renderPersonCardUnreadable(status) {
  document.title = "人物カードを確認できません｜世界の偉人性格診断";
  app.style.cssText = "";
  app.innerHTML = `<section class="card"><h1>人物カードを確認できません</h1>
    <p role="alert">${status === "damaged"
      ? "この端末の人物カード記録が壊れているため、このカードが消えたとは判断できません。サイトデータを消さずに保管してください。"
      : "この端末の保存領域を読み込めません。このカードが消えたとは判断できません。"}</p>
    <a class="btn sub" href="#/people">人物カード一覧へ</a></section>`;
  window.scrollTo(0, 0);
}

// 結果が出る瞬間の演出（約5秒。どこをタップしても最後まで飛ぶ）
function runReveal(r, mode, short, onFinish = null) {
  const sd = engines[mode];
  const card = $(".rcard"), stage = $(".stage"), lvEl = $(".meta-row .lv b");
  const t = r.type, tl = typeLabel(t, mode);
  let done = false;
  const focusResult = () => {
    const heading = card.querySelector("h1");
    if (heading?.isConnected) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  };
  const finish = (skipped) => {
    if (done) return;
    done = true;
    clearTimers();
    const focusWasOverlay = overlay.contains(document.activeElement);
    overlay.hidden = true; overlay.className = ""; overlay.innerHTML = "";
    app.inert = false;
    stage.dataset.state = "done"; card.classList.remove("reveal");
    card.querySelectorAll(".stars .on").forEach((el) => (el.style.opacity = ""));
    document.querySelectorAll(".reveal-hide").forEach((el) => el.classList.remove("reveal-hide"));
    lvEl.textContent = r.lv;
    if (focusWasOverlay || document.activeElement === document.body) focusResult();
    onFinish?.();
  };
  overlay.onclick = () => finish(true);
  card.addEventListener("pointerdown", () => finish(true), { once: true });
  const cardPhase = (t0) => {
    later(t0, () => { overlay.hidden = true; app.inert = false; card.classList.add("reveal"); stage.dataset.state = "sil"; focusResult(); });
    later(t0 + 500, () => { stage.dataset.state = "color"; });
    card.querySelectorAll(".stars .on").forEach((el, k) => { el.style.opacity = 0; later(t0 + 700 + k * 180, () => (el.style.opacity = 1)); });
    later(t0 + 1100, () => countUp(lvEl, r.lv, 450));
    if (r.capped) later(t0 + 1600, () => { const lv = card.querySelector(".lv"); lv.classList.remove("capped"); void lv.offsetWidth; lv.classList.add("capped"); });
    later(t0 + 1700, () => finish(false));
  };
  if (short || matchMedia("(prefers-reduced-motion: reduce)").matches) { overlay.hidden = true; return cardPhase(0); }
  // 前半：鑑定中（暗転 → レーダーが1軸ずつ伸びる → 系統のルーレット → 系統色が広がる）
  overlay.hidden = false;
  app.inert = true;
  overlay.style.cssText = themeVars(t.id);
  overlay.innerHTML = `<div><div class="msg">あなたの魂を鑑定中…</div>${radar(r.scores, { grow: true })}
    <div class="roulette">？</div><div class="tname"></div></div><button type="button" class="skip">結果を見る（演出をスキップ）</button>`;
  $(".skip", overlay).focus({ preventScroll: true });
  const shape = $(".shape", overlay), rou = $(".roulette", overlay), tname = $(".tname", overlay);
  const vals = [0, 0, 0, 0, 0, 0];
  AXES.forEach((a, k) => later(200 + k * 150, () => { vals[k] = r.scores[a]; shape.setAttribute("points", radarPoints(vals)); }));
  const types = sd.types.filter((x) => x.unit || x.special);
  let at = 1150;
  for (let k = 0; k < 12; k++) {
    const x = k === 11 ? t : types[(k * 7 + 3) % types.length];
    later(at, () => { rou.textContent = x.name[0]; rou.style.background = THEMES[x.id].accent; rou.style.color = "#fff"; });
    at += 60 + k * 22;
  }
  later(at, () => { overlay.classList.add("spread"); tname.textContent = tl.name; });
  cardPhase(at + 800);
}
function countUp(el, to, ms) {
  const t0 = performance.now();
  const step = (now) => { const p = Math.min(1, (now - t0) / ms); el.textContent = Math.max(1, Math.round(to * p * (2 - p))); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// ---------------- シェア画像（1080×1350、端末の中で作る） ----------------
let shareCache = { key: null, blob: null, pending: null };
const shareKey = (r, mode) => `${mode}:${r.figure.id}:${r.lv}`;
const loadImg = (src) => new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = ng; im.src = src; });
function shareQuoteRows(line, x, figureId, mode) {
  const chars = [...line], width = 940, memo = new Map();
  x.font = '900 48px "Noto Serif JP", serif';
  const natural = {
    "love:uesugi-kenshin": ["弱っているときに、", "つけこんだりしない。", "口説くのは、あなたが元気な日に。"],
    "love:tesla": ["あなたとのデート、頭の中で", "もう3回シミュレーションしました。"],
  }[`${mode}:${figureId}`];
  if (natural && natural.join("") === line) {
    const rows = natural.map((row, i) => `${i === 0 ? "「" : ""}${row}${i === natural.length - 1 ? "」" : ""}`);
    if (rows.every((row) => x.measureText(row).width <= width)) return rows;
  }
  const solve = (start, left) => {
    const key = `${start}:${left}`;
    if (memo.has(key)) return memo.get(key);
    if (start === chars.length) return left === 0 ? { cost: 0, rows: [] } : null;
    if (left === 0) return null;
    let best = null;
    for (let end = start + 1; end <= chars.length - left + 1; end++) {
      const row = chars.slice(start, end).join("");
      const shown = `${start === 0 ? "「" : ""}${row}${end === chars.length ? "」" : ""}`;
      const used = x.measureText(shown).width;
      if (used > width) continue;
      const tail = solve(end, left - 1);
      if (!tail) continue;
      const before = chars[end - 1], after = chars[end];
      const breakCost = end === chars.length ? (start > 0 && row.length < 4 ? 100 : 0)
        : (/[。！？…、）]/.test(before) ? -10 : /[はがをにでへとも]/.test(before) ? 8 : 35)
          + (/[、。！？…）」っゃゅょぁぃぅぇぉ]/.test(after) || /[（「]/.test(before) ? 100 : 0);
      const cost = ((width - used) / 48) ** 2 * 0.2 + breakCost + tail.cost;
      if (!best || cost < best.cost) best = { cost, rows: [shown, ...tail.rows] };
    }
    memo.set(key, best);
    return best;
  };
  for (let count = 1; count <= 3; count++) {
    const rows = solve(0, count)?.rows;
    if (rows) return rows;
  }
  throw Error("share quote does not fit");
}
async function drawShare(r, mode) {
  await document.fonts?.ready;
  const W = 1080, H = 1350, th = THEMES[r.type.id], c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  x.fillStyle = th.bg3; x.fillRect(0, 0, W, H);
  x.fillStyle = th.bg2; x.fillRect(0, 0, W, 16);
  const im = await loadImg(avatar(r.figure.id));
  const S = 620, X = (W - S) / 2, Y = 120;
  x.save(); x.beginPath(); x.roundRect(X, Y, S, S, 64); x.clip(); x.fillStyle = "#F5F2EB"; x.fillRect(X, Y, S, S); const artWidth = S * im.naturalWidth / im.naturalHeight; x.drawImage(im, X + (S-artWidth)/2, Y, artWidth, S); x.restore();
  const center = (txt, y, font, color) => { x.font = font; x.fillStyle = color; x.textAlign = "center"; x.fillText(txt, W / 2, y); };
  center(mode === "love" ? "恋をした私は" : "私は", 90, '500 36px "M PLUS Rounded 1c", sans-serif', "#6b6358");
  x.font = '700 30px "M PLUS Rounded 1c", sans-serif';
  x.fillStyle = "#6b6358"; x.textAlign = "right";
  x.fillText("演出のひとこと", W - 52, 90);
  const name = r.figure.name, fs = Math.min(110, Math.floor(900 / [...name].length));
  center(name, Y + S + 40 + fs, `900 ${fs}px "Noto Serif JP", serif`, "#26221d");
  const tl = typeLabel(r.type, mode);
  center(`${tl.name}｜${tl.catch}`, Y + S + 90 + fs + 20, '800 36px "M PLUS Rounded 1c", sans-serif', "#26221d");
  const rows = shareQuoteRows(mainLine(r.figure.id, mode), x, r.figure.id, mode);
  const firstY = rows.length === 3 ? 1020 : rows.length === 2 ? 1030 : 1040;
  rows.forEach((row, i) => center(row, firstY + i * 50, '900 48px "Noto Serif JP", serif', "#26221d"));
  if (r.figure.id === "washington") center("※ 斧と桜は後世の伝説イメージ", H - 170, '500 27px "M PLUS Rounded 1c", sans-serif', "#6b6358");
  if (r.figure.id === "mori-motonari") center("※ 三本の矢は後世の伝説イメージ", H - 170, '500 27px "M PLUS Rounded 1c", sans-serif', "#6b6358");
  if (r.figure.id === "natsume-soseki" && mode === "love") center("※ 漱石訳という出典は確認されていません", H - 170, '500 27px "M PLUS Rounded 1c", sans-serif', "#6b6358");
  center(`${"★".repeat(r.tier + 1)}${"☆".repeat(MAX_TIER - r.tier)}　Lv.${r.lv}`, H - 110, '800 36px "M PLUS Rounded 1c", sans-serif', "#b08a3e");
  center(`世界の偉人性格診断　${location.host}`, H - 44, '500 30px "M PLUS Rounded 1c", sans-serif', "#6b6358");
  return new Promise((ok) => c.toBlob(ok, "image/png"));
}
function renderShareBlob(r, mode) {
  const key = shareKey(r, mode);
  if (shareCache.key !== key) shareCache = { key, blob: null, pending: null };
  const cache = shareCache;
  if (cache.blob) return Promise.resolve(cache.blob);
  if (!cache.pending) {
    const pending = drawShare(r, mode).then((blob) => {
      if (shareCache === cache) cache.blob = blob;
      return blob;
    }).finally(() => {
      if (shareCache === cache && cache.pending === pending) cache.pending = null;
    });
    cache.pending = pending;
  }
  return cache.pending;
}
function prerenderShare(r, mode) {
  shareCache = { key: shareKey(r, mode), blob: null, pending: null };
  renderShareBlob(r, mode).catch(() => {});
}
async function shareImage(r, mode, trigger = null, stillValid = () => true) {
  if (trigger?.disabled) return;
  const previousLabel = trigger?.textContent;
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = "画像を準備中…";
    trigger.setAttribute?.("aria-busy", "true");
  }
  try {
    const generation = selfViewGeneration;
    const epoch = currentClearEpoch();
    const stateStatus = selfStateSnapshot().status;
    let blob;
    try {
      blob = await renderShareBlob(r, mode);
      if (!blob) throw new Error("画像の生成に失敗しました");
    } catch {
      if (!stillValid()) return;
      track("share_image_done", { method: "fail" });
      return toast("画像を作れませんでした。スクショで保存してください");
    }
    // Image/font loading can finish after another tab has deleted this result.
    // Never present a stale image or start a download in that case.
    if (!stillValid() || generation !== selfViewGeneration || !viewEpochMatches(epoch)
      || stateStatus === "missing_after_migration" || selfStateSnapshot().status !== stateStatus
      || (trigger && !trigger.isConnected)) return;
    const src = URL.createObjectURL(blob);
    if (/Line\/|Instagram|FBAN|FBAV|Twitter|; wv\)/i.test(navigator.userAgent)) {
      // アプリ内ブラウザはダウンロードできないので、画像を出して長押しで保存してもらう
      openSheet(`<div class="panel"><h2 id="sheet-title">画像を長押しして保存</h2><img src="${src}" alt="保存用の結果画像" style="width:100%;border-radius:12px">
        <button class="btn sub close" style="margin-top:12px">閉じる</button></div>`, trigger, src);
      track("share_image_done", { method: "inapp" });
      return;
    }
    const a = document.createElement("a");
    a.href = src; a.download = `ijin-${mode}-${r.figure.id}-lv${r.lv}.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(src), 60_000);
    track("share_image_done", { method: "download" });
    toast("画像の保存を開始しました。端末のダウンロード先を確認してください");
  } finally {
    if (trigger?.isConnected) {
      trigger.disabled = false;
      trigger.textContent = previousLabel;
      trigger.removeAttribute?.("aria-busy");
    }
  }
}

function capturedSelfViewGuard() {
  const generation = selfViewGeneration;
  const epoch = currentClearEpoch();
  const stateStatus = selfStateSnapshot().status;
  return () => generation === selfViewGeneration && viewEpochMatches(epoch)
    && stateStatus !== "missing_after_migration" && selfStateSnapshot().status === stateStatus;
}
function capturedSelfResultViewGuard(mode, code, requireCurrent) {
  const view = capturedSelfViewGuard();
  const atRender = selfStateSnapshot();
  const currentCode = atRender.status === "ok" ? atRender.state.current[mode]?.code ?? null : null;
  return () => {
    if (!view()) return false;
    const latest = selfStateSnapshot();
    if (latest.status !== atRender.status) return false;
    if (atRender.status !== "ok") return !requireCurrent;
    return latest.state.current[mode]?.code === currentCode
      && (!requireCurrent || currentCode === code);
  };
}

// ---------------- 図鑑 ----------------
function renderZukan() {
  document.title = "図鑑｜世界の偉人性格診断";
  const snapshot = readZukanStorage();
  const z = snapshot.zukan;
  app.style.cssText = "";
  const zPct = Math.round((zukanCount() / Math.max(1, FREE.length)) * 100);
  app.innerHTML = `
    <div class="zhead"><h1>偉人図鑑</h1><span class="cnt">発見 <b>${zukanCount()}</b> / ${FREE.length}${LOCKED.length ? `（＋鍵つき ${LOCKED.length}）` : ""}</span></div>
    ${zukanStorageAlert()}
    ${snapshot.status === "damaged" ? '<p class="note">元の記録に診断結果が含まれる場合があります。ファイルは人に送らず保管してください。保存してもサイト内の記録は変わりません。押した後、ファイルが保存されたか確認してください。</p><button class="btn sub" data-export-zukan>元の図鑑記録をファイルに保存</button>' : ""}
    <div class="progress-line" style="margin:0 0 10px"><div class="bar"><i style="width:${zPct}%"></i></div></div>
    <p class="note" style="text-align:left">全100人を無料で発見できます。🔒は課金ではなく、自分の診断ではまだ出会っていない印です。自分の診断（通常・恋愛）で出た偉人が「発見」としてこの端末に登録されます。相性や共有リンクで名前を見かけただけの偉人は未発見のまま（${knownCount()}人）。</p>
    ${SD.types.map((t) => `<div class="zrow"><h2><i style="background:${THEMES[t.id].accent}"></i>${esc(t.name)}</h2>
      <div class="zcells">${t.figures.map((f, k) => {
        const st = k > MAX_TIER ? "locked" : z[f.id] ? (DISCOVER_SRC.has(z[f.id].src) ? "me" : "known") : "unseen";
        return `<button class="zcell ${st}" data-id="${f.id}" data-st="${st}" style="--t-bg:${THEMES[t.id].bg}"
          aria-label="${st === "me" ? `${esc(f.name)}（${esc(t.name)} ★${k + 1} 発見済み）` : st === "known" ? `${esc(f.name)}（${esc(t.name)} ★${k + 1} 未発見）` : `${esc(t.name)} ★${k + 1} 未発見`}"><img src="${avatar(f.id, st !== "me")}" alt="">
          <span class="star">★${k + 1}</span>${st === "known" ? `<span class="znm">${esc(f.name)}</span>` : ""}${st === "locked" || st === "known" ? '<span class="lock">🔒</span>' : ""}</button>`;
      }).join("")}</div></div>`).join("")}
    <div style="display:grid;gap:10px"><a class="btn sub" href="#/me">この端末の記録</a><a class="btn sub" href="#/">トップへ</a></div>`;
  app.querySelector("[data-export-zukan]")?.addEventListener("click", () => {
    const latest = readZukanStorage();
    if (latest.status !== "damaged" || latest.raw !== snapshot.raw) return toast("図鑑記録が変わりました。画面を開き直して確認してください");
    try { exportDamagedZukanRaw(snapshot.raw); }
    catch { toast("元の図鑑記録を保存できませんでした"); }
  });
  app.querySelectorAll(".zcell").forEach((b) => (b.onclick = () => {
    const { id, st } = b.dataset;
    if (st === "locked") return toast("この人物は現在の図鑑では表示できません");
    if (st === "unseen") return toast("まだ出会っていません");
    if (st === "known") return toast(`${fig(id).name}：あなた自身の診断結果に出ると、図鑑に登録されます`);
    const tx = texts[id];
    const srcTxt = sourceLabels(id).join("・");
    openSheet(`<div class="panel"><div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
        <img class="tile" src="${avatar(id)}" alt="" style="width:72px;height:72px;${themeVars(fig(id).type)}">
        <div><h2 id="sheet-title" style="margin:0">${esc(fig(id).name)}</h2><div class="note" style="text-align:left">${esc(sd_type(id).name)}・★${fig(id).tier + 1}</div>
          ${srcTxt ? `<div class="note" style="text-align:left">取得元：${esc(srcTxt)}</div>` : ""}</div></div>
      <p style="font-family:var(--serif);font-weight:900;margin:0 0 8px">「${esc(tx.serif)}」</p><p class="body">${esc(tx.body)}</p>
      ${id === "washington" ? '<p class="note">※ 斧と桜は史実ではなく、後世の伝説を図案化したものです</p>' : ""}
      ${id === "mori-motonari" ? '<p class="note">※ 三本の矢は後世の伝説を図案化したものです</p>' : ""}
      <details><summary>元ネタを見る</summary><p>${esc(tx.motoneta.text)}</p></details>
      <button class="btn sub close" style="margin-top:14px">閉じる</button></div>`, b);
  }));
  window.scrollTo(0, 0);
}
const sd_type = (id) => SD.type(fig(id).type);

// ---------------- マイページ（#/me）：この端末の保存データを読むだけ。新しい保存はしない ----------------
function accountCard() {
  return `<section class="card login-card"><h2>この端末の図鑑</h2><p class="note" style="text-align:left;margin:0">診断結果と図鑑は、このブラウザに保存されます。ログインは不要です。</p></section>`;
}
// 図鑑の集まり具合を大きく見せる（マイページ・優先順位2位）
function zukanSummaryCard() {
  const n = zukanCount(), total = FREE.length, pct = Math.round((n / Math.max(1, total)) * 100);
  return `<section class="card zukan-summary">
      <h2 style="margin:0 0 10px">偉人図鑑</h2>
      ${zukanStorageAlert()}
      <div class="zukan-big"><b>${n}</b><span>/ ${total}</span></div>
      <div class="progress-line" style="margin:10px 0 4px"><div class="bar"><i style="width:${pct}%"></i></div></div>
      <p class="note" style="text-align:left;margin:8px 0 14px">名前だけ知っている偉人　🔒 ${knownCount()}人</p>
      <a class="btn sub" href="#/zukan">図鑑を見る</a></section>`;
}
function renderMe() {
  document.title = "この端末の記録｜世界の偉人性格診断";
  app.style.cssText = "";
  const MODES = [["normal", "性格診断"], ["love", "恋愛診断"]];
  const ok = (m, e) => verifiedResult(m, e);
  const date = (t) => {
    const d = new Date(t);
    return t && Number.isFinite(d.getTime()) ? d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }) : "";
  };
  const row = (m, e, lbl, face, href = `#/r/${m}/${e.code}`) => `<a class="me-row" href="${href}">
      <img class="tile" src="${face ?? avatar(e.fig)}" alt="" style="${themeVars(fig(e.fig).type)}">
      <span><span class="lbl">${esc(lbl)}</span><span class="nm">${esc(fig(e.fig).name)}</span></span><span class="go">›</span></a>`;
  const selfSnapshot = selfStateSnapshot();
  captureSelfOverview(selfSnapshot);
  // 自分の結果：いま・前の結果・この端末で診断した過去の結果（seen_results から計算し直す）
  const selfReadable = ["ok", "legacy_changed", "legacy_unverified"].includes(selfSnapshot.status);
  const mineHtml = !selfReadable
    ? '<div class="me-empty">自己診断の記録を確認できません。上の案内をご確認ください。</div>'
    : MODES.map(([m, name]) => {
    const cur = selfSnapshot.state.current[m], prev = selfSnapshot.state.previous[m];
    const shown = new Set([ok(m, cur) ? cur.code : null, ok(m, prev) ? prev.code : null]);
    const hist = selfSnapshot.state.seenResults.filter((x) => typeof x === "string" && x.startsWith(m)).map((x) => x.slice(m.length)).reverse()
      .filter((c) => !shown.has(c) && validCode(engines[m], c)).slice(0, 5)
      .map((c) => ({ code: c, fig: engines[m].diagnose(answersOf(engines[m], c)).figure.id }));
    if (!ok(m, cur) && !ok(m, prev) && !hist.length)
      return `<div class="me-empty">${name}：まだ結果がありません${selfSnapshot.status === "ok"
        ? `　<a href="#/q/${m}" data-fresh="${m}">診断する</a>` : "。照合が終わるまで新しい結果の保存はできません。"}</div>`;
    const prefix = selfSnapshot.status === "ok" ? "" : "照合前・";
    const readHref = (code) => selfSnapshot.status === "ok" ? `#/r/${m}/${code}` : `#/saved-readonly/${m}/${code}`;
    return (ok(m, cur) ? row(m, cur, `${prefix}いまの${name}の結果${cur.via === "link" ? "（リンクから保存）" : ""}`, undefined, readHref(cur.code)) : "")
      + (ok(m, prev) ? row(m, prev, `${prefix}前の${name}の結果${prev.via === "link" ? "（リンクから保存）" : ""} ${date(prev.at)}`, undefined, readHref(prev.code)) : "")
      + hist.map((h) => row(m, h, `以前の${name}の結果`, undefined, readHref(h.code))).join("");
  }).join("");
  const verifiedState = selfReadable ? selfSnapshot.state : null;
  const legacyLinks = verifiedState?.legacyLinks ?? [];
  const legacyUnverified = verifiedState?.legacyUnverified ?? [];
  const selfWarnings = verifiedState?.migrationWarnings ?? [];
  const selfAlert = selfSnapshot.status === "missing_after_migration"
    ? "以前保存した自己診断の中心記録が見つかりません。古いタブで全記録を消した場合などに起こります。空の記録は自動で作らず、自己診断の保存を止めています。古いタブを閉じ、下のボタンでこの端末に残る元データを書き出して保管してください。以前の結果が残っているとは限りません。最初から始める場合は「このサイトについて・記録を消す」から全記録を消してください。"
    : selfSnapshot.status === "legacy_changed"
    ? "古いタブが、移行後に自己診断の保存欄を書き換えた可能性があります。旧版の結果を本人の結果として自動登録していません。古いタブを閉じ、下のボタンで元の記録をファイルに保存してください。新たな保存は照合を終えるまで止めています。"
    : selfSnapshot.status === "legacy_unverified"
    ? "以前の自己診断記録と古いタブの保存欄を照合できません。元の記録を上書きせず保存を止めています。古いタブを閉じ、下のボタンで元の記録をファイルに保存してください。"
    : !selfLockAvailable()
    ? "このブラウザーは複数タブの同時操作保護に対応していません。自己診断結果の端末保存と旧記録の移行を止めています。結果を見ることはできます。"
    : selfSnapshot.status !== "ok"
    ? "自己診断の保存記録を読み込めません。元のデータは変更せず、自己診断結果の表示と保存を止めています。"
    : selfWarnings.length
      ? "以前の自己診断記録の一部を確認できませんでした。読めた結果は残し、読めない元データは上書きしていません。"
      : "";
  // A legacy key changed after migration. It may be an old tab's new SELF
  // result, but the old slot could also contain a received link. Offer only a
  // read-only view; never count or promote it without an explicit recovery flow.
  const lateLegacyCandidates = selfSnapshot.status === "legacy_changed"
    ? MODES.flatMap(([mode, name]) => {
      const key = `ijin.me.${mode}`;
      if (selfSnapshot.state.legacySnapshot?.[key] === undefined) return [];
      let raw;
      try { raw = localStorage.getItem(key); } catch { return []; }
      if (raw === null || raw === selfSnapshot.state.legacySnapshot[key]) return [];
      let entry;
      try { entry = JSON.parse(raw); } catch { return []; }
      return verifiedResult(mode, entry) ? [{ mode, name, entry }] : [];
    }) : [];
  const friends = [...storedList(store.get("friends", [])), ...legacyLinks]
    .filter((x) => x && ok(x.mode, x));
  const personCardSnapshot = readPersonCardStorage();
  const personCardCount = personCardSnapshot.status === "ok"
    ? `${personCardsFromRaw(personCardSnapshot.cards).cards.length}枚`
    : "確認できません";
  const pendingFigureCount = selfSnapshot.status === "ok" ? verifiedState?.pendingZukan.length ?? 0 : 0;
  app.innerHTML = `
    <div class="zhead"><h1>この端末の記録</h1></div>
    ${selfAlert ? `<section class="card"><h2>自己診断の記録を確認してください</h2><p role="alert">${selfAlert}</p><p class="note">元データに12問の答えが含まれる場合があります。ファイルは人に送らず、この端末に保管してください。書き出しは記録を変更しません。</p><button class="btn sub" data-export-self>元の記録をファイルに保存</button>${["legacy_changed", "legacy_unverified"].includes(selfSnapshot.status) ? `<div style="margin-top:14px"><p class="note">保存を再開しても、古い保存欄の変更は自分の結果には取り込みません。現在の自己診断記録は残ります。旧版で新しく出た結果を残したい場合は先に結果画面をスクリーンショットで残してください。復旧後、この未確認結果は一覧に表示されなくなります。</p><label><input type="checkbox" data-self-recovery-check> ファイルの保存を確認し、古いタブを閉じた</label><button class="btn sub" data-rebaseline-self disabled>未確認の旧結果を取り込まず保存を再開</button></div>` : ""}</section>` : ""}
    ${lateLegacyCandidates.length ? `<section class="card"><h2>古い保存欄にある結果（本人か未確認）</h2><p class="note">古いタブで後から保存された可能性がある結果です。本人が答えた証拠はないため、自分の結果・診断回数には加えていません。ここでは結果を読むだけで、人物カードには追加しません。</p><div class="me-list">${lateLegacyCandidates.map(({ mode, name, entry }) => row(mode, entry, `${name}・出所未確認`, relFace(entry.fig), `#/legacy/${mode}/${entry.code}`)).join("")}</div></section>` : ""}
    ${accountCard()}
    ${zukanSummaryCard()}
    <section class="card"><h2>自分の診断結果${selfSnapshot.status === "ok" ? "" : "（読取専用）"}</h2><p class="note" style="text-align:left;margin:0 0 10px">これまでの診断回数：${selfReadable ? `${selfSnapshot.state.count}回${selfSnapshot.status === "ok" ? "" : "（照合前）"}` : "確認できません"}</p><div class="me-list">${mineHtml}</div></section>
    ${pendingFigureCount ? `<section class="card"><h2>図鑑への登録を確認中</h2><p>${pendingFigureCount}件の結果は保存済みですが、図鑑への反映が未確認です。</p><button class="btn sub" data-retry-all-self-zukan>図鑑への登録を再試行</button></section>` : ""}
    ${legacyUnverified.length ? `<section class="card"><h2>出所未確認の旧結果</h2><p class="note">以前の保存欄にあった結果ですが、本人が答えた記録か確認できません。自分の診断結果や友達の人数には数えません。元の記録は上のボタンから保存できます。</p>${legacyUnverified.map((x) => `<p>${x.mode === "love" ? "恋愛診断" : "性格診断"}：${esc(fig(x.fig).name)}（出所未確認）</p>`).join("")}</section>` : ""}
    <section class="card"><h2>以前の共有リンク履歴</h2>
      ${friends.length ? `<div class="me-list">${friends.map((x) => row(x.mode, x, `${x.mode === "love" ? "恋愛" : "性格"}・${date(x.at)}に開いた結果${savedResult(x.mode)?.code === x.code ? "（自分と同じ回答）" : ""}`, relFace(x.fig), sharedResultViewPath(x.mode, x.code))).join("")}</div>
        <p class="note" style="text-align:left;margin:8px 0 0">以前に保存されたリンクの記録です。自分のリンクも含まれ、同じ回答コードは1件にまとまります。人の数ではありません（最大20件）。今はリンクを開くだけでは追加されません。</p>`
        : `<p class="note" style="text-align:left;margin:0">以前の履歴はありません。共有リンクの回答は、開くだけではこの履歴に追加されません。残したいときはリンク先で人物カードに追加してください。</p>`}</section>
    ${OTHER_PILOT ? `<section class="card"><h2>友達から見た自分 <span class="dev-badge">試作</span></h2>
      <p class="social-note">あなたについての返信リンクを、自分で保存した記録です。回答者の本人確認はできず、自分の結果も置き換えません。</p>
      <p>${otherReplies().length}件の返信をこの端末に保存中。回答した人の人数とは限りません。</p>
      <a class="btn sub" href="#/ask">招待リンクと返信を見る</a></section>` : ""}
    <section class="card"><h2>人物カード</h2><p>友達から届いた自己診断結果のカード：${personCardCount}</p>
      <a class="btn sub" href="#/people">人物カードを見る</a></section>
    <section class="card"><h2>設定</h2>
      <p class="note" style="text-align:left;margin:0">この記録は、この端末のこのブラウザの中だけに保存されています。機種変更、別のブラウザ、プライベートモード、ブラウザのデータ削除では消えることがあります。</p>
      <a class="btn sub" style="margin-top:12px" href="#/about">このサイトについて・記録を消す</a>
      </section>
    <a class="btn sub" href="#/how">このサイトの使い方</a>
    <a class="btn sub" href="#/">トップへ</a>`;
  bindFreshQuizLinks();
  let exportedLegacyRaw = null;
  const recoveryCheck = $("[data-self-recovery-check]");
  const recoveryButton = $("[data-rebaseline-self]");
  const updateRecoveryButton = () => {
    if (recoveryButton) recoveryButton.disabled = !(exportedLegacyRaw && recoveryCheck?.checked);
  };
  $("[data-export-self]")?.addEventListener("click", () => {
    try {
      exportedLegacyRaw = exportSelfOriginalRaw();
      updateRecoveryButton();
    } catch { toast("元の記録を保存できませんでした。サイトデータは消さずに保管してください"); }
  });
  recoveryCheck?.addEventListener("change", updateRecoveryButton);
  recoveryButton?.addEventListener("click", async () => {
    if (!exportedLegacyRaw || !recoveryCheck.checked || !selfLockAvailable()) return;
    if (!window.confirm("古い保存欄の変更は自分の結果へ取り込みません。元の記録を保存し、古いタブを閉じたことを確認しましたか？")) return;
    const captured = currentClearEpoch();
    const expectedRaw = selfSnapshot.raw;
    recoveryButton.disabled = true;
    const outcome = captured.status === "present" && typeof expectedRaw === "string"
      ? await withSiteRecordsLock(() => {
        if (!recoveryButton.isConnected || location.hash !== "#/me" || !clearEpochMatches(captured))
          return { status: "changed" };
        const latest = selfStateSnapshot();
        if (latest.status !== selfSnapshot.status || latest.raw !== expectedRaw)
          return { status: "changed" };
        return rebaselineLegacySelfState(localStorage, captured.token, expectedRaw, exportedLegacyRaw, verifiedResult);
      }) : { status: "unavailable" };
    if (!recoveryButton.isConnected) return;
    if (outcome?.status !== "ok") {
      recoveryButton.disabled = false;
      toast("保存を再開できませんでした。古いタブを閉じ、元の記録を保管してください");
      route();
      return;
    }
    route();
    focusPageHeading();
    toast("保存を再開しました。古い結果は自分の結果へ追加していません");
  });
  const pendingEpoch = capturePersonCardEpoch();
  $("[data-retry-all-self-zukan]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const status = await retryPendingZukan(await pendingEpoch);
    if (!button.isConnected) return;
    button.disabled = false;
    if (status !== "saved") return toast("図鑑への登録を確認できませんでした。後でもう一度お試しください");
    route();
    toast("図鑑への登録を確認しました");
  });
  window.scrollTo(0, 0);
}

// このサイトについて（文案：docs/about-draft.md、根拠：docs/legal-check.md）
// ---------------- 使い方（#/how） ----------------
function renderHow() {
  document.title = "使い方｜世界の偉人性格診断";
  app.style.cssText = "";
  const steps = [
    ["①", "性格診断をする", "12問・約1分半。登録なしですぐ始められます。"],
    ["②", "似た偉人と出会う", "6つの軸をもとに、今の回答に近い偉人を1人表示します。"],
    ["③", "偉人を図鑑に集める", "相性・もしもの分岐などで名前を知り、診断で出会うと図鑑に「発見」として残ります。"],
    ["④", "結果を自分でシェアする", "共有リンクや画像は、自分で選んだときだけ送れます。受け取った結果は自分の結果と区別して表示します。"],
    ["⑤", "人物カードを増やす", "友達から自己診断結果リンクが届いたら、結果画面でカードに追加できます。"],
    OTHER_PILOT ? ["⑥", "友達から見た自分も聞く（試作）", "招待リンクを自分で送り、友達が答えたら返信リンクを送ってもらいます。回答は自動では届きません。"] : ["予定", "他己分析 ※開発中", "友達があなたについて答える機能です。今は公開していません。"],
  ];
  app.innerHTML = `
    <div class="zhead"><h1>このサイトの使い方</h1></div>
    <div class="how-steps">${steps.map(([n, t, d]) => `<section class="card how-step"><div class="how-n">${n}</div>
        <div><h2 style="margin:0 0 4px">${esc(t)}</h2><p class="note" style="text-align:left;margin:0">${esc(d)}</p></div></section>`).join("")}</div>
    <a class="btn start" data-fresh="normal" data-src="how" href="#/q/normal">診断スタート</a>
    ${OTHER_PILOT ? '<a class="btn sub" style="margin-top:10px" href="#/ask">友達に聞く（試作）</a>' : ""}
    <a class="btn sub" style="margin-top:10px" href="#/">トップへ</a>`;
  bindFreshQuizLinks();
  window.scrollTo(0, 0);
}


function renderAbout() {
  document.title = "このサイトについて｜世界の偉人性格診断";
  app.style.cssText = "";
  app.innerHTML = `<article class="about">
    <h1>このサイトについて</h1>
    <p>「世界の偉人性格診断」は、12問で100人の偉人のうち誰に近いかを楽しむ無料のサイトです。性格版と恋愛版があります。登録や購入は不要です。</p>
    <p>結果は娯楽であり、心理検査や医学的診断ではありません。人物の台詞やイラストは創作を含み、史実や本人の発言そのものとは限りません。</p>
    <h2>保存と共有</h2>
    <p>回答途中の記録、自分の診断結果、図鑑、自分で追加した人物カード${OTHER_PILOT ? "、試作中の招待リンクと他己回答" : ""}は、このブラウザ内に保存されます。別の端末には自動で引き継がれません。ブラウザのデータを消すと失われます。</p>
    <p>受け取った結果リンクは、開くだけでは「この端末の記録」に追加されません。共有結果から診断を始めた場合、元の結果へ戻るための情報をそのタブに一時的に記録します。開いたリンク自体はブラウザの履歴に残る場合があります。</p>
    <p>結果の共有リンクには、12問の回答から作られたコードが含まれ、リンクを知る人は答えを読み取れます。リンクを相手に送ると、受信者や共有先のサービスに結果とコードが伝わります。受信者がリンクを開くと、配信元のGitHub Pagesにもコード付きURLが届きます。画像を端末に保存するだけなら、このコードは送信されません。共有操作をしなければ、アプリから回答や結果を運営者へ送信しません。</p>
    ${OTHER_PILOT ? '<p>試作中の友達への招待と返信は、利用者がリンクをコピー・共有して行います。回答は自動送信されません。返信リンクの「#」以降には回答コードが含まれるため、送った相手や共有先サービスにはその情報が伝わります。リンクを知る人は12問の答えを開けます。名前はリンクに含めません。招待した人が別ブラウザーや別のサイトアドレスで返信を開いても、招待の記録とは自動でつながりません。</p>' : ""}
    <p>この版ではアクセス解析、広告、ログイン、クラウド保存、購入は行いません。ページの表示に必要なファイルはGitHub Pagesから読み込まれ、配信元には通常の閲覧ログが残る場合があります。Wikipediaなど外部サイトへのリンクは、押したときだけ開きます。</p>
    <p>他己用の質問と判定は試験段階で、公開版にはまだ出していません。回答者が別人かも確認できないため、複数の返信を「何人の評価」として扱いません。</p>
    <h2>これからの機能 <span class="dev-badge">※開発中</span></h2>
    <p>友達を招いてあなたについて答えてもらう他己診断、複数人の独立した回答を保証する総合結果、人物カード同士の組み合わせバッジは、公開版ではまだ使えません。LINEスタンプやグッズの販売導線も未公開です。</p>
    <h2>記録の削除</h2>
    <p>このブラウザーで、このサイトが保存した診断記録を消します。再保存や旧記録の再移行を防ぐため、回答を含まない削除・移行の管理値は端末に残ります。別タブや古い版が動いている場合、記録が再び残ることがあります。ブラウザーの閲覧履歴や、すでに送った結果リンクは消えません。</p>
    <p>このブラウザーが複数タブの同時操作保護に対応しない場合、自己診断結果の端末保存・以前の結果への復元・サイト内からの全記録削除は安全のため行いません。結果は画面で見られますが、保存が必要なら対応ブラウザーでお試しください。確実に消したい場合は、すべてのタブを閉じてブラウザーのサイトデータを削除してください。</p>
    <p><b>以前の版でログインした方へ：</b>この操作では、その認証セッションやクラウド上の既存データは削除しません。</p>
    <button class="btn sub" type="button" data-clear aria-expanded="false" aria-controls="clear-confirm">このサイトの保存記録を消す</button>
    <section class="clear-confirm" id="clear-confirm" aria-labelledby="clear-confirm-title" hidden>
      <h3 id="clear-confirm-title" tabindex="-1">本当に消しますか？</h3>
      <p>このブラウザーに保存した結果・図鑑と、このタブの途中の答えなどを消します。別のタブの途中の答えは残る場合があります。元には戻せません。閲覧履歴や送信済みリンクは残ります。</p>
      <button class="btn confirm-delete" type="button" data-confirm-clear>保存記録を消す</button>
      <button class="btn sub" type="button" data-cancel-clear>やめる</button>
    </section>
    <p class="clear-status" role="alert" tabindex="-1" data-clear-status hidden></p>
    <a class="btn sub" style="margin-top:10px" href="#/">トップへ</a></article>`;
  const clearButton = $("[data-clear]");
  const clearConfirm = $("[data-confirm-clear]");
  const clearHeading = $("#clear-confirm-title");
  const clearPanel = $("#clear-confirm");
  let clearConfirmationSerial = 0;
  clearButton.onclick = () => {
    clearConfirmationSerial++;
    clearPanel.hidden = false;
    clearButton.setAttribute("aria-expanded", "true");
    clearHeading.focus();
  };
  $("[data-cancel-clear]").onclick = () => {
    clearConfirmationSerial++;
    clearPanel.hidden = true;
    clearButton.setAttribute("aria-expanded", "false");
    clearButton.focus();
  };
  clearConfirm.onclick = async () => {
    if (clearConfirm.disabled) return;
    clearConfirm.disabled = true;
    const hashAtClick = location.hash;
    const serialAtClick = clearConfirmationSerial;
    const cleared = await clearSiteRecords(() => clearConfirm.isConnected
      && !clearPanel.hidden && location.hash === hashAtClick
      && clearConfirmationSerial === serialAtClick);
    if (!clearConfirm.isConnected) return;
    clearConfirm.disabled = false;
    if (cleared === "cancelled") return;
    if (cleared !== "cleared") {
      const status = $("[data-clear-status]");
      status.textContent = cleared === "partial"
        ? "保存記録をすべて消したとは確認できません。ブラウザーのサイトデータを削除してください。"
        : "安全に削除を開始できませんでした。別のタブを閉じて再読み込みするか、ブラウザーのサイトデータを削除してください。";
      status.hidden = false;
      status.focus();
      return;
    }
    toast("保存記録を消しました");
    location.hash = "#/";
  };
  window.scrollTo(0, 0);
}

function renderUnavailable() {
  const [, page, mode] = location.hash.split("/");
  const planned = ["fr", "invite", "ask", "answer", "reply"].includes(page) || (["q", "r"].includes(page) && ["friend", "other"].includes(mode));
  document.title = planned ? "招待・他己診断は開発中｜世界の偉人性格診断" : "このリンクは開けません｜世界の偉人性格診断";
  app.style.cssText = "";
  app.innerHTML = `<section class="card"><h1>${planned ? '招待・他己診断 <span class="dev-badge">※開発中</span>' : 'このリンクは開けませんでした'}</h1>
    <p>${planned ? (["fr", "invite"].includes(page) ? "古い招待リンクは現在使えません。" : "招待・他己診断は公開準備中です。") + "このリンクから相手への回答は送れません。" : page === "person" ? "カードの記録が変わったか、古いカードのリンクです。人物カード一覧から選び直してください。" : "リンクが途中で切れているか、対応していない形式です。"}性格版・恋愛版の自己診断は無料で遊べます。</p>
    ${page === "person" ? '<a class="btn sub" href="#/people">人物カード一覧へ</a>' : ""}
    <a class="btn start" href="#/q/normal">${esc(quizEntryLabel("normal", "自分の診断を始める"))}</a>
    <a class="btn sub" style="margin-top:10px" href="#/">トップへ</a></section>`;
  window.scrollTo(0, 0);
}

// ---------------- 友達から見た自分（端末内・手動で往復） ----------------
// 旧 #/invite は別仕様のため再利用しない。新しいURLは #/ask/<token> と #/reply/<token>/<code>。
function copyLink(url, okText = "リンクをコピーしました", stillValid = () => true,
  manualText = "このリンクをコピーしてください") {
  if (!stillValid()) return;
  try {
    const clipboard = navigator.clipboard;
    const pending = typeof clipboard?.writeText === "function" ? clipboard.writeText(url) : null;
    if (!pending || typeof pending.then !== "function") throw new Error("Clipboard unavailable");
    pending.then(() => { if (stillValid()) toast(okText); })
      .catch(() => { if (stillValid()) prompt(manualText, url); });
  } catch {
    if (stillValid()) prompt(manualText, url);
  }
}
function shareLink(url, text, stillValid = () => true) {
  if (!stillValid()) return;
  const copyForSending = () => copyLink(`${text}\n${url}`,
    "文章とリンクをコピーしました。LINEなどの会話に貼り付けて送ってください", stillValid,
    "この文章とリンクをコピーし、LINEなどの会話に貼り付けて送ってください");
  try {
    const pending = typeof navigator.share === "function"
      ? navigator.share({ title: "世界の偉人性格診断", text, url }) : null;
    if (pending && typeof pending.then === "function") {
      pending.then(undefined, (e) => {
        if (e?.name !== "AbortError" && stillValid()) copyForSending();
      });
      return;
    }
  } catch (e) {
    if (e?.name === "AbortError") return;
  }
  if (stillValid()) copyForSending();
}
function renderAskHome() {
  document.title = "友達に聞く｜世界の偉人性格診断";
  app.style.cssText = "";
  const token = inviteToken();
  const url = token ? makeInviteUrl(location.href, token) : null;
  const loopback = ["localhost", "127.0.0.1"].includes(location.hostname);
  const replies = otherReplies();
  app.innerHTML = `
    <div class="zhead"><h1>友達から見た自分</h1></div>
    <section class="social-entry">
      <div class="social-badge">無料・登録なし</div>
      <h2>友達にはどう見えている？</h2>
      <p>友達があなたについて12問答えると、選んだ答えをそのまま見られます。偉人への当てはめは検証中です。自己診断とは別の、一人から見た印象として楽しんでください。</p>
    </section>
    <div class="social-step"><b>1　招待リンクを作る</b><p>このブラウザー・このサイトのアドレスに招待の記録を残します。名前はリンクに入りません。</p>
      ${loopback ? '<p class="social-note">今のアドレスは別の端末では開けません。別端末でも開けるテスト用アドレスを用意し、そのアドレスでサイトを開いて新しい招待リンクを作ってください。</p>' : ''}
      ${token ? `${loopback ? '' : '<button class="btn start" data-share-ask>友達に招待リンクを送る</button>'}<button class="btn sub" data-copy-ask>${loopback ? 'この端末で試すリンクをコピー' : '招待リンクをコピー'}</button><p class="social-code">${esc(url)}</p>`
        : `<button class="btn start" data-create-ask>招待リンクを作る</button>`}
    </div>
    <div class="social-step"><b>2　友達が回答して、返信リンクを送る</b>
      <p>回答は自動では届きません。友達に、最後に表示される「返信リンク」をあなたへ送ってもらってください。</p></div>
    <div class="social-step"><b>3　届いた返信を招待を作ったブラウザーで開く</b>
      <p>招待を作ったのと同じブラウザー・同じサイトのアドレスで返信を開き、「この印象を保存する」を押すとここに並びます。別のブラウザーには自動で移りません。</p></div>
    <section class="card"><h2>保存した返信</h2>
      ${replies.length ? `<div class="social-list">${replies.map((x, i) => {
        return `<a class="me-row" href="#/reply/${x.token}/${x.code}"><span class="social-badge">${i + 1}</span><span><span class="lbl">返信 ${i + 1}${x.token === token ? "" : "・以前の招待"}（相手の人数は確認できません）</span><span class="nm">回答を確認する</span></span><span class="go">›</span></a>`;
      }).join("")}</div>` : '<p>まだ保存した返信はありません。</p>'}
      <p class="social-note">同じ人が複数回回答したかは判別できません。「何人の評価」として集計しません。</p>
    </section>
    <a class="btn sub" href="#/me">この端末の記録</a><a class="btn sub" href="#/">トップへ</a>`;
  $("[data-create-ask]")?.addEventListener("click", () => {
    try {
      const next = createInviteToken();
      store.set("other.invite", next);
      if (inviteToken() !== next) throw new Error("storage");
      renderAskHome();
      toast("招待リンクを作りました");
    } catch { toast("この端末で招待リンクを保存できません。通常ブラウザでお試しください"); }
  });
  $("[data-share-ask]")?.addEventListener("click", () => shareLink(url, "私について12問答えてみて！ 最後の返信リンクを送ってね。"));
  $("[data-copy-ask]")?.addEventListener("click", () => copyLink(url));
  window.scrollTo(0, 0);
}
function renderAskEntry(token) {
  document.title = "友達について答える｜世界の偉人性格診断";
  app.style.cssText = "";
  app.innerHTML = `
    <div class="zhead"><h1>友達からのお願い</h1></div>
    <section class="social-entry"><div class="social-badge">あなたから見た、招待を作った人</div>
      <h2>その人の印象を答えてみよう</h2>
      <p>あなた自身ではなく、この招待を作った人の普段の様子について12問答えてください。転送されたリンクでは、送ってきた人と質問の対象が違う場合があります。</p>
      <p>誰について答えるか分からなければ、招待した本人に確認してください。分からない質問は「見ていない」を選べます。</p>
      <label class="social-note"><input type="checkbox" data-subject-known> 招待を作った人が誰か分かっている</label>
      <button class="btn start" data-start-other disabled>その人について答える</button>
    </section>
    <p class="social-note">回答は一人から見た印象です。自動送信されません。最後に返信リンクをあなたが送った場合のみ、相手に伝わります。</p>
    <a class="btn sub" href="#/">自分を診断したい人はこちら</a>`;
  const confirmSubject = $("[data-subject-known]");
  const start = $("[data-start-other]");
  confirmSubject.onchange = () => { start.disabled = !confirmSubject.checked; };
  start.onclick = () => {
    confirmedOtherToken = token;
    try { sessionStorage.setItem(`ijin.other.subject.${token}`, "yes"); } catch {}
    const answerHash = `#/answer/${token}`;
    if (location.hash === answerHash) { renderOtherQuiz(token); focusPageHeading(); }
    else location.hash = answerHash;
  };
  window.scrollTo(0, 0);
}
let otherQuiz = null;
let confirmedOtherToken = null;
const subjectConfirmed = (token) => {
  if (confirmedOtherToken === token) return true;
  try { return sessionStorage.getItem(`ijin.other.subject.${token}`) === "yes"; } catch { return false; }
};
const otherProgressKey = (token) => "ijin.other.progress." + token;
const otherProgressIndexKey = (token) => "ijin.other.progress_index." + token;
function readOtherProgress(token) {
  try {
    const xs = JSON.parse(sessionStorage.getItem(otherProgressKey(token)) || "null");
    return Array.isArray(xs) && xs.length <= 12 && xs.every((v) => Number.isInteger(v) && v >= 0 && v <= 5) ? xs : [];
  } catch { return []; }
}
function readOtherProgressIndex(token, answerCount) {
  try {
    const raw = sessionStorage.getItem(otherProgressIndexKey(token));
    return otherV1ProgressIndex(raw, answerCount);
  } catch { return otherV1ProgressIndex(null, answerCount); }
}
function writeOtherProgress(token, answers, index) {
  try {
    sessionStorage.setItem(otherProgressKey(token), JSON.stringify(answers));
    sessionStorage.setItem(otherProgressIndexKey(token), String(index));
  } catch {}
}
function renderOtherQuiz(token) {
  if (!otherQuiz || otherQuiz.token !== token) {
    const saved = readOtherProgress(token);
    otherQuiz = { token, qs: otherQuestions, answers: saved, i: readOtherProgressIndex(token, saved.length), busy: false };
  }
  const { qs, answers, i } = otherQuiz;
  const q = qs[i];
  document.title = `友達について ${i + 1} / ${qs.length}｜世界の偉人性格診断`;
  app.style.cssText = "";
  app.innerHTML = `
    <div class="qhead"><button class="back" data-other-back>${i ? "← 前の質問" : "← 説明に戻る"}</button>
      <span class="count"><b>${i + 1}</b> / ${qs.length}</span><span class="social-badge">相手について</span></div>
    <div class="segs">${qs.map((_, k) => `<i class="${k < i ? "done" : k === i ? "now" : ""}"></i>`).join("")}</div>
    <div class="qbox"><div class="intro">この招待を作った人の、見聞きした行動について答えてください。</div>
      <h1 class="qtext" id="other-question" tabindex="-1">${esc(q.text)}</h1>
      <p class="qhint">いちばん近いものを選んでね。押すと次へ進みます。</p>
      <div class="scale5" role="group" aria-labelledby="other-question">${[1, 2, 3, 4, 5].map((v) =>
        `<button class="dotbtn v${v} ${answers[i] === v ? "sel" : ""}" data-other-v="${v}" aria-pressed="${answers[i] === v}" aria-label="${esc(data.questions_friend.scale[v - 1])}"><i aria-hidden="true"></i><span>${esc(data.questions_friend.scale[v - 1])}</span></button>`).join("")}</div>
      <button class="btn sub other-unseen ${answers[i] === 0 ? "sel" : ""}" style="margin-top:16px" data-other-v="0" aria-pressed="${answers[i] === 0}">見ていない・分からない</button>
      <p class="social-note">「どちらとも言えない」と「見ていない・分からない」は別の答えです。</p>
    </div>`;
  window.scrollTo(0, 0);
  $(".qtext").focus({ preventScroll: true });
  $("[data-other-back]").onclick = () => { if (i) { otherQuiz.i--; writeOtherProgress(token, answers, otherQuiz.i); renderOtherQuiz(token); } else location.hash = `#/ask/${token}`; };
  app.querySelectorAll("[data-other-v]").forEach((b) => b.onclick = () => {
    if (otherQuiz.busy) return;
    otherQuiz.busy = true;
    answers[i] = Number(b.dataset.otherV);
    // 前の回答を直しても、その後に答えた内容は勝手に消さない。
    answers.length = Math.max(answers.length, i + 1);
    if (i + 1 === qs.length) {
      const code = makeFriendCode(answers);
      try { sessionStorage.removeItem(otherProgressKey(token)); } catch {}
      try { sessionStorage.removeItem(otherProgressIndexKey(token)); } catch {}
      try { sessionStorage.removeItem(`ijin.other.subject.${token}`); } catch {}
      confirmedOtherToken = null;
      otherQuiz = null;
      location.hash = `#/reply/${token}/${code}`;
    } else {
      otherQuiz.i++;
      writeOtherProgress(token, answers, otherQuiz.i);
      otherQuiz.busy = false;
      renderOtherQuiz(token);
    }
  });
}
function renderOtherReply(token, code) {
  document.title = "友達から見た回答｜世界の偉人性格診断";
  app.style.cssText = "";
  const values = friendAnswersFromCode(code);
  const unknown = values.filter((v) => v === 0).length;
  const saved = otherReplies().some((x) => x.token === token && x.code === code);
  const owner = inviteToken() === token || saved;
  const url = makeReplyUrl(location.href, token, code);
  const answerRows = otherQuestions.map((q, i) => `<li><span class="social-answer-num">${i + 1}</span>
    <span>${esc(q.text)}</span><strong>${esc(values[i] === 0 ? "見ていない・分からない" : data.questions_friend.scale[values[i] - 1])}</strong></li>`).join("");
  app.innerHTML = `
    <div class="zhead"><h1>友達についての回答 <span class="dev-badge">試作</span></h1></div>
    <section class="social-entry"><h2>${owner ? "あなたについての12問の回答" : "12問の回答ができました"}</h2>
      <div class="social-badge">見聞きして答えた ${12 - unknown}問 ／ 見ていない ${unknown}問</div>
      <p>これは一つの印象です。人物や性格はまだ判定しません。回答した人の本人確認もできません。</p></section>
    <details class="card other-answers"><summary>12問の答えを確認する</summary>
      <ol class="social-answer-list">${answerRows}</ol></details>
    <p class="social-note">この回答は「みんなの評価」ではありません。自己診断の結果も置き換えません。</p>
    ${owner ? `<section class="card"><h2>このブラウザーに残す</h2><p>保存すると、このブラウザーの「友達から見た自分」に追加されます。あなた自身の診断結果は置き換わりません。</p>
      ${saved ? '<p class="social-note">保存済みです。</p>' : '<button class="btn start" data-save-other>この印象を保存する</button>'}
      ${saved ? '<button class="btn sub" data-delete-other>この印象だけ削除する</button>' : ""}
      </section><a class="btn sub" href="#/ask">保存した印象を見る</a>`
      : `<section class="card"><h2>この回答を相手に返す</h2><p>まだ送っていません。返信リンクを、招待を作った本人へ送ってください。</p>
        <p class="social-note">このブラウザー・サイトのアドレスでは招待の記録を確認できません。あなたが招待者の場合は、招待を作ったブラウザーでこの返信リンクを開き直してください。</p>
        <p class="social-note">返信リンクを知る人は12問の答えを見られます。送る相手と共有先を確認してください。</p>
        <button class="btn start" data-share-reply>返信リンクを送る</button><button class="btn sub" data-copy-reply>返信リンクをコピー</button>
        <button class="btn sub" data-revise-other>回答を見直す</button></section>`}
    <a class="btn sub" href="#/">トップへ</a>`;
  $("[data-save-other]")?.addEventListener("click", () => {
    const prev = store.get("other.replies", []);
    const entry = { token, code, at: Date.now() };
    const update = appendOtherReply(prev, entry);
    if (update.status !== "saved") return toast(update.status === "full" ? "返信は50件まで。追加するには不要な返信を削除してください" : update.status === "duplicate" ? "この返信は保存済みです" : "返信を保存できませんでした");
    if (!store.set("other.replies", update.records)) return toast("この端末に保存できませんでした");
    if (!otherReplies().some((x) => x.code === code)) return toast("この端末に保存できませんでした");
    renderOtherReply(token, code);
    toast("回答を保存しました");
  });
  const replyHash = location.hash;
  const shareReplyButton = $("[data-share-reply]");
  const copyReplyButton = $("[data-copy-reply]");
  const replyStillCurrent = (button) => button?.isConnected && location.hash === replyHash;
  shareReplyButton?.addEventListener("click", () => shareLink(url, "あなたについて答えました。返信リンクを開いて、12問の回答を見てね。", () => replyStillCurrent(shareReplyButton)));
  copyReplyButton?.addEventListener("click", () => copyLink(url, "リンクをコピーしました", () => replyStillCurrent(copyReplyButton)));
  $("[data-revise-other]")?.addEventListener("click", () => {
    otherQuiz = { token, qs: otherQuestions, answers: values.slice(), i: Math.max(0, values.indexOf(0)), busy: false };
    // 返信URLは転送され得る。見直す人も回答対象を再確認する。
    confirmedOtherToken = null;
    try { sessionStorage.removeItem(`ijin.other.subject.${token}`); } catch {}
    writeOtherProgress(token, values, otherQuiz.i);
    location.hash = `#/answer/${token}`;
  });
  $("[data-delete-other]")?.addEventListener("click", () => {
    if (!confirm("この返信だけを端末内の記録から削除しますか？")) return;
    const remaining = removeOtherReply(store.get("other.replies", []), token, code);
    if (!remaining || !store.set("other.replies", remaining)) return toast("この端末から返信を削除できませんでした");
    renderOtherReply(token, code);
    toast("この返信を削除しました");
  });
  window.scrollTo(0, 0);
}

// 人物カードは、他人が自分自身について答えた共有結果から本人が明示的に追加する。
// 既存の friends 履歴や「友達から見た自分」とは別の端末内コレクション。
function ownSelfShares(snapshot) {
  if (snapshot.status !== "ok") return [];
  return [["normal", snapshot.state.current.normal], ["love", snapshot.state.current.love]]
    .filter(([, result]) => result && result.via !== "link")
    .map(([mode, result]) => ({ mode, code: result.code }));
}
function peopleOwnSharesHtml(ownShares) {
  return ownShares.length ? `<p class="social-note">送るリンクを知る人は、あなたの12問の答えを読み取れます。友達はそのリンクから自分自身を診断できます。他己分析は ※開発中。</p>
        ${ownShares.map(({ mode }, i) => { const label = mode === "love" ? "恋愛版" : "性格版"; return `
          <button class="btn ${i === 0 ? "start" : "sub"}" data-invite-self="${mode}">${typeof navigator.share === "function" ? `${label}の結果を友達に送る` : `${label}の共有文とリンクをコピー`}</button>
          <button class="btn sub" data-copy-self="${mode}">${label}の結果リンクをコピー</button>`; }).join("")}
        ${typeof navigator.share !== "function" ? '<p class="social-note">コピーした共有文とリンクは、LINEなどの会話に貼り付けて送ってください。</p>' : ""}`
    : `<a class="btn start" href="#/q/normal">${esc(quizEntryLabel("normal", "まず自分を診断する"))}</a>`;
}
function bindPeopleOwnShares(ownShares) {
  ownShares.forEach(({ mode, code }) => {
    const result = engines[mode].diagnose(answersOf(engines[mode], code));
    const url = shareUrl(mode, result.figure.id, code);
    const label = mode === "love" ? "恋愛版" : "性格版";
    const shareView = capturedSelfViewGuard();
    const shareHash = location.hash;
    const inviteButton = $(`[data-invite-self="${mode}"]`);
    const copyButton = $(`[data-copy-self="${mode}"]`);
    const stillCurrent = (button) => {
      const latest = savedResult(mode);
      return shareView() && location.hash === shareHash && button?.isConnected
        && latest?.code === code && latest.via !== "link";
    };
    inviteButton?.setAttribute("aria-label", `${typeof navigator.share === "function" ? `${label}の結果を友達に送る` : `${label}の共有文とリンクをコピー`}。リンクを知る人は12問の答えを読み取れます`);
    copyButton?.setAttribute("aria-label", `${label}の結果リンクをコピー。リンクを知る人は12問の答えを読み取れます`);
    inviteButton?.addEventListener("click", () => {
      if (!stillCurrent(inviteButton)) { refreshSelfAfterExternalChange(); return; }
      shareLink(url, `${label}では私は${result.figure.name}タイプだった！ あなたも12問で診断して、結果リンクを送り返してね。`, () => stillCurrent(inviteButton));
    });
    copyButton?.addEventListener("click", () => {
      if (!stillCurrent(copyButton)) { refreshSelfAfterExternalChange(); return; }
      copyLink(url, `${label}の結果リンクをコピーしました`, () => stillCurrent(copyButton));
    });
  });
}
let activePeopleCardsView = null;
let activePersonCardView = null;
function personDetailControlKey(node) {
  if (!node || !app.contains(node)) return null;
  if (node.tagName === "A") {
    const href = node.getAttribute("href");
    return href ? `link:${href}:${node.getAttribute("data-src") ?? ""}` : null;
  }
  if (node.tagName === "SUMMARY") return `summary:${node.textContent.trim()}`;
  if (node.tagName === "BUTTON") {
    for (const action of ["data-return-self", "data-restore-self", "data-add-person",
      "data-share", "data-duo", "data-fresh"]) {
      if (node.hasAttribute(action)) return `button:${action}:${node.getAttribute(action) ?? ""}`;
    }
  }
  return null;
}
function refreshPersonCardAfterExternalChange() {
  const view = activePersonCardView;
  if (!view || location.hash !== view.hash) return;
  const latest = readPersonCardStorage();
  if (latest.status === view.status && (latest.raw ?? null) === view.raw) {
    if (view.pending) {
      sheet.querySelector("[data-person-card-sheet-pending]")?.remove();
      view.pending = false;
    }
    return;
  }
  if (!sheet.hidden) {
    view.pending = true;
    if (!sheet.querySelector("[data-person-card-sheet-pending]")) {
      const notice = document.createElement("p");
      notice.className = "note";
      notice.dataset.personCardSheetPending = "";
      notice.setAttribute("role", "alert");
      notice.textContent = "別のタブで人物カードが変わりました。今の入力は残しています。閉じると表示を更新します。";
      sheet.querySelector(".panel")?.append(notice);
    }
    return;
  }
  const scrollY = window.scrollY;
  const focused = document.activeElement;
  const hadAppFocus = app.contains(focused);
  const focusKey = personDetailControlKey(focused);
  const openDetails = [...app.querySelectorAll("details")].filter((node) => node.open)
    .map((node) => node.querySelector("summary")?.textContent.trim()).filter(Boolean);
  view.status = latest.status;
  view.raw = latest.raw ?? null;
  view.pending = false;
  if (latest.status !== "ok") renderPersonCardUnreadable(latest.status);
  else {
    const card = personCardsFromRaw(latest.cards).cards.find((item) => item.id === view.id);
    const identity = view.identity;
    if (view.invalidated || !card || (identity && (card.mode !== identity.mode
      || card.code !== identity.code || card.fig !== identity.fig || card.at !== identity.at))) {
      view.invalidated = true;
      renderUnavailable();
    } else renderPersonCard(view.id, latest);
  }
  window.scrollTo(0, scrollY);
  if (latest.status === "ok" && activePersonCardView?.identity && !activePersonCardView.invalidated) {
    const details = [...app.querySelectorAll("details")];
    details.forEach((node) => {
      const name = node.querySelector("summary")?.textContent.trim();
      if (name && openDetails.filter((oldName) => oldName === name).length === 1
        && details.filter((other) => other.querySelector("summary")?.textContent.trim() === name).length === 1)
        node.open = true;
    });
  }
  if (!hadAppFocus) return;
  const matches = focusKey ? [...app.querySelectorAll("a[href], button, summary")]
    .filter((node) => personDetailControlKey(node) === focusKey) : [];
  const candidate = matches.length === 1 ? matches[0] : null;
  const target = latest.status === "ok" && activePersonCardView?.identity && !activePersonCardView.invalidated
    && candidate && !candidate.hidden && !candidate.disabled ? candidate : app.querySelector("h1");
  if (target) {
    if (target !== candidate) target.tabIndex = -1;
    try { target.focus({ preventScroll: true }); } catch { /* Keep the refreshed page visible. */ }
  }
}
function capturePeopleCardsView(snapshot) {
  activePeopleCardsView = { hash: location.hash, status: snapshot.status,
    raw: snapshot.raw ?? null, pending: false };
}
function peopleCardsRefreshBusy() {
  return sheet.hidden !== true || !!app.querySelector('[data-remove-person]:disabled, [data-save-person-label]:disabled');
}
function showPeopleCardsSheetPending() {
  if (sheet.hidden || sheet.querySelector('[data-people-cards-sheet-pending]')) return;
  const panel = sheet.querySelector('.panel');
  if (!panel) return;
  const notice = document.createElement('p');
  notice.className = 'note';
  notice.dataset.peopleCardsSheetPending = '';
  notice.setAttribute('role', 'alert');
  notice.textContent = '別のタブで人物カードが変わりました。今の入力は残しています。この画面を閉じると一覧を更新します。';
  panel.append(notice);
}
function deferPeopleCardsRefresh() {
  if (!activePeopleCardsView) return;
  showPeopleCardsSheetPending();
  if (activePeopleCardsView.pending) return;
  activePeopleCardsView.pending = true;
  const notice = document.createElement("p");
  notice.className = "note";
  notice.dataset.peopleCardsPending = "";
  notice.setAttribute("role", "alert");
  notice.textContent = "別のタブで人物カードが変わりました。今の操作を中断しないため、一覧はまだ更新していません。";
  const button = document.createElement("button");
  button.className = "btn sub";
  button.type = "button";
  button.textContent = "人物カードを更新して表示";
  button.addEventListener("click", refreshPeopleCardsAfterExternalChange);
  notice.append(button);
  app.prepend(notice);
}
function refreshPeopleCardsAfterExternalChange() {
  const view = activePeopleCardsView;
  if (location.hash !== "#/people" || view?.hash !== location.hash) return;
  const latest = readPersonCardStorage();
  if (latest.status === view.status && (latest.raw ?? null) === view.raw) {
    if (view.pending) {
      app.querySelector("[data-people-cards-pending]")?.remove();
      sheet.querySelector("[data-people-cards-sheet-pending]")?.remove();
      view.pending = false;
    }
    return;
  }
  if (peopleCardsRefreshBusy()) return deferPeopleCardsRefresh();
  const scrollY = window.scrollY;
  const focused = document.activeElement;
  let focusTarget = null;
  if (focused && app.contains(focused)) {
    const href = focused.tagName === "A" ? focused.getAttribute("href") : null;
    const action = ["data-label-person", "data-remove-person", "data-invite-self", "data-copy-self", "data-export-damaged"]
      .find((name) => focused.hasAttribute(name));
    focusTarget = href ? { kind: "link", href } : action
      ? { kind: "button", action, value: focused.getAttribute(action), id: focused.getAttribute("data-person-id") }
      : { kind: "heading" };
  }
  renderPeople();
  window.scrollTo(0, scrollY);
  if (!focusTarget) return;
  const match = focusTarget.kind === "link"
    ? [...app.querySelectorAll("a[href]")].find((link) => link.getAttribute("href") === focusTarget.href)
    : focusTarget.kind === "button" ? [...app.querySelectorAll(`[${focusTarget.action}]`)]
      .find((button) => button.getAttribute("data-person-id") === focusTarget.id
        && (["data-label-person", "data-remove-person"].includes(focusTarget.action)
          || button.getAttribute(focusTarget.action) === focusTarget.value)) : null;
  const destination = match && !match.hidden && !match.disabled ? match : app.querySelector("h1");
  if (typeof destination?.focus === "function") {
    if (destination !== match) destination.tabIndex = -1;
    try { destination.focus({ preventScroll: true }); } catch { /* Keep the updated page visible. */ }
  }
}
function renderPeople() {
  document.title = "人物カード｜世界の偉人性格診断";
  captureSelfOverview();
  app.style.cssText = "";
  const capturedEpoch = capturePersonCardEpoch();
  const snapshot = readPersonCardStorage();
  capturePeopleCardsView(snapshot);
  if (snapshot.status !== "ok") {
    const message = snapshot.status === "damaged"
      ? "この端末の人物カード記録を読み込めません。元の記録を守るため、追加や編集を止めています。サイトデータを消さずに保管してください。"
      : "この端末の保存領域を読み込めません。人物カードの追加や編集はできません。";
    app.innerHTML = `<section class="card"><h1>人物カードを確認できません</h1><p role="alert">${message}</p>${snapshot.status === "damaged" && typeof snapshot.raw === "string"
      ? '<p>元の記録のファイル保存を試せます。回答が含まれる場合があるため、人に送らず保管してください。保存してもサイト内の記録は変わりません。押した後、ファイルが保存されたか確認してください。</p><button class="btn sub" data-export-damaged>元の記録をファイルに保存</button>'
      : ""}<a class="btn sub" href="#/">トップへ戻る</a></section>`;
    $("[data-export-damaged]")?.addEventListener("click", () => {
      const latest = readPersonCardStorage();
      if (latest.status !== "damaged" || latest.raw !== snapshot.raw) {
        renderPeople();
        return toast("別のタブで記録が変わりました。表示を更新してから選び直してください");
      }
      try { exportDamagedPersonCardRaw(snapshot.raw); }
      catch { toast("ファイルを保存できませんでした。サイトデータは消さずに保管してください"); }
    });
    window.scrollTo(0, 0);
    return;
  }
  const cards = personCardsFromRaw(snapshot.cards).cards;
  const isVerifiedCard = (card) => {
    try {
      const engine = engines[card.mode];
      return engine && validCode(engine, card.code)
        && engine.diagnose(answersOf(engine, card.code)).figure.id === card.fig;
    } catch { return false; }
  };
  const verifiedCards = cards.filter(isVerifiedCard);
  const figureIds = distinctCardFigures(verifiedCards, () => true);
  const varietyCount = figureIds.length;
  const heroes = figureSetProgress(figureIds, THREE_HEROES);
  const varietyMessage = varietyCount === 0
    ? "届いた結果をカードに追加すると、キャラがここに並びます。"
    : varietyCount === 1 ? "次はどんなキャラが来る？"
      : varietyCount === 2 ? "あと1種類のキャラで3キャラ集合！" : "3種類のキャラが並びました。もっと増やしてみよう。";
  const varietySlots = Array.from({ length: 3 }, (_, i) => {
    const id = figureIds[i];
    return id ? `<div class="variety-slot"><img src="${avatar(id)}" alt=""><span>${esc(fig(id).name)}</span></div>`
      : '<div class="variety-slot empty" role="img" aria-label="空いている枠"><span aria-hidden="true">？</span></div>';
  }).join("");
  const ownShares = ownSelfShares(selfStateSnapshot());
  app.innerHTML = `<div class="zhead"><h1>人物カード</h1><span class="cnt">${cards.length}枚</span></div>
    <section class="social-entry"><div class="social-badge">人が増えるコレクション</div>
      <h2>友達の偉人を集めよう</h2><p>① あなたの結果を送る。<br>② 友達が自分自身を診断し、結果リンクを返す。<br>③ 届いたリンクで「人物カードに追加する」を押す。</p>
      <p class="social-note">ここで集めるのは、友達から届いた自己診断結果です。リンクの持ち主は確認できません。友達があなたについて答える「他己分析」とは別です。図鑑の「発見」とも別です。</p>
      <div data-self-overview style="display:grid;gap:10px">${peopleOwnSharesHtml(ownShares)}</div></section>
    <section class="social-entry variety-entry" aria-labelledby="variety-title"><div class="social-badge">${varietyCount < 3 ? `${varietyCount}/3種類` : `${varietyCount}種類`}</div>
      <h2 id="variety-title">キャラの顔ぶれ</h2><p>${varietyMessage}</p>
      <div class="variety-slots">${varietySlots}</div>
      ${varietyCount >= 3 ? '<div class="variety-award"><span class="variety-award-icon" aria-hidden="true"><i></i><i></i><i></i></span><strong>3キャラ集合！</strong><span>この端末で3種類のキャラがそろったよ</span></div>' : ""}
      ${varietyCount > 3 ? `<p class="variety-extra">ほか${varietyCount - 3}種類のキャラも下のカード一覧にいます。</p>` : ""}
      ${verifiedCards.length < cards.length ? '<p class="variety-extra">結果を確認できないカードは、キャラの種類に数えていません。</p>' : ""}
      ${heroes.found.length ? `<div class="theme-set"><strong>三英傑のキャラ <span>${heroes.found.length}/3</span></strong>
        <p>${heroes.missing.length ? `あと${heroes.missing.length}キャラで、信長・秀吉・家康の3種類。` : "信長・秀吉・家康の3種類がそろいました！"}</p>
        <div class="theme-set-names">${THREE_HEROES.map((id) => `<span class="${heroes.found.includes(id) ? "found" : ""}">${esc(fig(id).name)}</span>`).join("")}</div></div>` : ""}
      <p class="variety-note">この端末に保存した結果のキャラの種類です。人の数や本人確認を示すものではありません。</p></section>
    ${cards.some(personCardNeedsLabel) ? '<p class="social-note">名前の横の目印でカードを区別できます。誰の結果かはリンクから確認できません。必要なら「呼び名」を付けてください。本名や連絡先は入れないでください。</p>' : ""}
    ${cards.length ? `<div class="social-list">${cards.map((x, i) => { const verified = isVerifiedCard(x);
      const actionName = personCardDisplayName(x, i);
      return `<section class="social-card">
      ${verified ? `<img class="tile" src="${avatar(x.fig)}" alt="">` : '<div class="person-broken-icon" aria-hidden="true">？</div>'}
      <div class="person-card-info"><small class="person-card-position">一覧の${i + 1}枚目</small><b>${esc(personCardDisplayName(x, i))}</b>${verified
        ? `<div class="nm">${esc(fig(x.fig).name)}</div><small>演出の一言「${esc(mainLine(x.fig, x.mode))}」</small><small>${x.mode === "love" ? "恋愛版" : "性格版"}の共有結果</small>`
        : '<small>保存データの回答とキャラが一致しません。このカードの結果は開けません。</small>'}</div>
      ${verified ? `<a href="#/person/${encodeURIComponent(x.id)}" aria-label="${esc(actionName)}・${i + 1}枚目の結果を見る">見る</a>` : '<span class="person-unavailable">確認不可</span>'}
      <button type="button" data-label-person="${i}" data-person-id="${esc(x.id)}" aria-label="${esc(actionName)}・${i + 1}枚目の呼び名を変更">呼び名</button>
      <button type="button" data-remove-person="${i}" data-person-id="${esc(x.id)}" aria-label="${esc(actionName)}・${i + 1}枚目を削除">削除</button>
    </section>`; }).join("")}</div>` : '<section class="card"><p>カードはまだありません。友達から自己診断の結果リンクが届いたら、そのページで追加できます。</p></section>'}
    <p class="social-note">カードはこの端末に最大50枚保存。同じ回答の友達も別カードにできます。リンクの持ち主は確認できません。図鑑の「発見」数は増えません。</p>
    ${OTHER_PILOT ? '<a class="btn sub" href="#/ask">友達から見た自分を聞く（試作）</a>' : '<p class="social-note">他己分析（友達があなたについて答える機能）は ※開発中</p>'}<a class="btn sub" href="#/me">この端末の記録</a><a class="btn sub" href="#/">トップへ</a>`;
  bindPeopleOwnShares(ownShares);
  app.querySelectorAll("[data-remove-person]").forEach((b) => b.onclick = async () => {
    if (b.disabled) return;
    const hash = location.hash;
    const captured = await capturedEpoch;
    if (!personCardActionCurrent(b, hash)) return;
    const epochAtClick = personCardEpochStatus(captured);
    if (epochAtClick === "stale_epoch") {
      renderPeople();
      return toast("端末の記録が削除されました。画面を更新してから選び直してください");
    }
    if (epochAtClick !== "current") return toast("保存の準備を確認できません。少し待って画面を開き直してください");
    const refreshChanged = () => {
      renderPeople();
      toast("別タブでカードが変わりました。更新して選び直してください");
    };
    const i = Number(b.dataset.removePerson), { all, index, displayedId: currentId } = rawPersonAt(i);
    const current = all[index], displayedId = b.dataset.personId;
    if (!usablePersonCard(current) || displayedId !== currentId) {
      return refreshChanged();
    }
    const beforeConfirm = JSON.stringify(all);
    const before = readPersonCardStorage();
    if (before.status !== "ok" || JSON.stringify(before.cards) !== beforeConfirm) return refreshChanged();
    if (!confirm(personDeleteConfirmMessage(current, i, isVerifiedCard(current) ? fig(current.fig).name : ""))) return;
    if (!personCardActionCurrent(b, hash)) return;
    b.disabled = true;
    const status = await withSiteRecordsLock(() => {
      if (!personCardActionCurrent(b, hash)) return "cancelled";
      const epoch = personCardEpochStatus(captured);
      if (epoch !== "current") return epoch;
      return withPersonCardsLock(() => {
        if (!personCardActionCurrent(b, hash)) return "cancelled";
        const latestEpoch = personCardEpochStatus(captured);
        if (latestEpoch !== "current") return latestEpoch;
        const latest = personCardSnapshotUnchanged(before.raw);
        if (!latest || !personCardTargetUnchanged(latest, i, index, displayedId)) return "changed";
        const next = latest.slice();
        next.splice(index, 1);
        return store.set("people.cards", next) ? "deleted" : "error";
      });
    });
    b.disabled = false;
    if (activePeopleCardsView?.pending) queueMicrotask(refreshPeopleCardsAfterExternalChange);
    if (!personCardActionCurrent(b, hash) || status === "cancelled") return;
    if (status === "stale_epoch" || personCardEpochStatus(captured) === "stale_epoch") {
      renderPeople();
      return toast("端末の記録が削除されました。画面を更新してから選び直してください");
    }
    if (status === "epoch_unavailable") return toast("保存の準備を確認できません。少し待って画面を開き直してください");
    if (status === "changed") return refreshChanged();
    if (status !== "deleted") return toast("この端末からカードを削除できませんでした");
    renderPeople();
    focusPageHeading();
  });
  app.querySelectorAll("[data-label-person]").forEach((b) => b.onclick = async () => {
    if (b.disabled) return;
    const hash = location.hash;
    const captured = await capturedEpoch;
    if (!personCardActionCurrent(b, hash)) return;
    const epochAtClick = personCardEpochStatus(captured);
    if (epochAtClick === "stale_epoch") {
      renderPeople();
      return toast("端末の記録が削除されました。画面を更新してから選び直してください");
    }
    if (epochAtClick !== "current") return toast("保存の準備を確認できません。少し待って画面を開き直してください");
    let editorOpened = false;
    const refreshChanged = () => {
      if (editorOpened) {
        // An edit attempted against a changed snapshot must not write, but the
        // person's unfinished label remains available until they close it.
        deferPeopleCardsRefresh();
        return toast("別タブでカードが変わりました。呼び名の入力は残しています。閉じると一覧を更新します");
      }
      renderPeople();
      focusPageHeading();
      toast("別タブでカードが変わりました。更新して選び直してください");
    };
    const i = Number(b.dataset.labelPerson), { all, index, displayedId: currentId } = rawPersonAt(i);
    const current = all[index], displayedId = b.dataset.personId;
    if (!usablePersonCard(current) || displayedId !== currentId) {
      return refreshChanged();
    }
    const beforeEdit = JSON.stringify(all);
    const before = readPersonCardStorage();
    if (before.status !== "ok" || JSON.stringify(before.cards) !== beforeEdit) return refreshChanged();
    openSheet(`<div class="panel"><h2 id="sheet-title">カードの呼び名</h2>
      <p>自分だけに分かる短い呼び名を付けられます。本名や連絡先は入れないでください。この端末にだけ保存され、結果リンクには入りません。</p>
      <label for="person-label">呼び名（20文字以内）</label>
      <input class="social-input" id="person-label" type="text" maxlength="20" value="${esc(cleanPersonCardLabel(current.label))}" placeholder="例：友達A">
      <button class="btn start" data-save-person-label>保存する</button>
      <button class="btn sub close" type="button">閉じる</button></div>`, b);
    editorOpened = true;
    const saveButton = $("[data-save-person-label]", sheet);
    saveButton.onclick = async () => {
      if (saveButton.disabled) return;
      const label = cleanPersonCardLabel($("#person-label", sheet).value);
      if (!personCardActionCurrent(b, hash, saveButton)) return;
      saveButton.disabled = true;
      const status = await withSiteRecordsLock(() => {
        if (!personCardActionCurrent(b, hash, saveButton)) return "cancelled";
        const epoch = personCardEpochStatus(captured);
        if (epoch !== "current") return epoch;
        return withPersonCardsLock(() => {
          if (!personCardActionCurrent(b, hash, saveButton)) return "cancelled";
          const latestEpoch = personCardEpochStatus(captured);
          if (latestEpoch !== "current") return latestEpoch;
          const latest = personCardSnapshotUnchanged(before.raw);
          if (!latest || !personCardTargetUnchanged(latest, i, index, displayedId)) return "changed";
          const next = latest.slice();
          next[index] = { ...next[index], label };
          return store.set("people.cards", next) ? "renamed" : "error";
        });
      });
      saveButton.disabled = false;
      if (activePeopleCardsView?.pending) queueMicrotask(refreshPeopleCardsAfterExternalChange);
      if (!personCardActionCurrent(b, hash, saveButton) || status === "cancelled") return;
      if (status === "stale_epoch" || personCardEpochStatus(captured) === "stale_epoch") {
        closeSheet(false);
        renderPeople();
        focusPageHeading();
        return toast("端末の記録が削除されました。画面を更新してから選び直してください");
      }
      if (status === "epoch_unavailable") return toast("保存の準備を確認できません。少し待って画面を開き直してください");
      if (status === "changed") return refreshChanged();
      if (status !== "renamed") return toast("呼び名を保存できませんでした");
      closeSheet(false);
      renderPeople();
      // 別タブが先頭へ追加した場合、旧表示位置は別カードになる。IDで復帰する。
      const renamedButton = [...app.querySelectorAll("[data-label-person]")]
        .find((button) => button.dataset.personId === displayedId);
      if (renamedButton) renamedButton.focus();
      else focusPageHeading();
      toast("呼び名を保存しました");
    };
  });
  window.scrollTo(0, 0);
}

// 共有リンクから回答が落ちて届いたとき：その偉人の紹介と、診断への入口だけを出す
function renderFigure(mode, id) {
  const f = fig(id), t = sd_type(id), tl = typeLabel(t, mode), tx = texts[id];
  track("friend_view", { mode, figure: id, has_mine: "fallback" });
  document.title = `${f.name}タイプ｜${engines[mode].modeConf.name}`;
  app.style.cssText = themeVars(t.id);
  app.innerHTML = `
    <div class="friend-head"><h1>${esc(f.name)}タイプの紹介</h1><p class="note">このページには回答コードがありません。誰かの診断結果を示すものではありません。</p></div>
    <section class="rcard" style="${themeVars(t.id)}">
      <div class="stage" data-state="done"><img class="avatar color" src="${avatar(id)}" alt="${esc(f.name)}のイラスト"></div>
      ${id === "washington" ? '<p class="note">※ 斧と桜は史実ではなく、後世の伝説を図案化したものです</p>' : ""}
      ${id === "mori-motonari" ? '<p class="note">※ 三本の矢は後世の伝説を図案化したものです</p>' : ""}
      ${id === "natsume-soseki" && mode === "love" ? '<p class="note">※「月が綺麗ですね」を漱石が訳したという出典は確認されていません</p>' : ""}
      <h1 class="fig-name" style="--len:${[...f.name].length}">${esc(f.name)}</h1>
      <div class="type-line"><span class="emblem">${esc(t.name[0])}</span><span class="type-name">${esc(tl.name)}</span></div>
      <p class="serif-quote">${esc(mainLine(id, mode))}</p>
      <p class="note">※ 診断用の演出です。本人の発言とは限りません</p>
    </section>
    <div style="display:grid;gap:8px;margin:16px 0">
      <a class="btn start" data-fresh="${mode}" href="#/q/${mode}">あなたは誰？ 12問で診断する</a></div>
    <details class="card"><summary>${esc(f.name)}タイプってどんな人？</summary><p class="body">${esc(tx.body)}</p></details>`;
  bindFreshQuizLinks();
  attachMotion(f.name);
  window.scrollTo(0, 0);
}

// Broken legacy synchronization never turns an unverified answer into SELF or
// a friend's card. These routes only allow inspection of already stored data.
function renderSelfReadOnly(mode, code, kind) {
  const snapshot = selfStateSnapshot();
  if (!["legacy_changed", "legacy_unverified"].includes(snapshot.status)
    || !engines[mode] || !validCode(engines[mode], code)) return renderUnavailable();
  let allowed = false;
  if (kind === "saved-readonly") {
    const state = snapshot.state;
    allowed = [state.current[mode], state.previous[mode]].some((entry) => entry?.code === code)
      || state.seenResults.includes(mode + code);
  } else if (kind === "legacy" && snapshot.status === "legacy_changed") {
    const key = `ijin.me.${mode}`;
    let raw;
    try { raw = localStorage.getItem(key); } catch { return renderUnavailable(); }
    if (raw !== null && raw !== snapshot.state.legacySnapshot?.[key]) {
      let entry;
      try { entry = JSON.parse(raw); } catch { return renderUnavailable(); }
      allowed = verifiedResult(mode, entry) && entry.code === code;
    }
  }
  if (!allowed) return renderUnavailable();
  const result = engines[mode].diagnose(answersOf(engines[mode], code));
  document.title = `照合前の結果｜世界の偉人性格診断`;
  app.style.cssText = themeVars(result.type.id);
  app.innerHTML = `<p class="note" role="alert">${kind === "legacy"
    ? "古い保存欄にある回答です。本人が答えた結果かは未確認です。"
    : "以前保存された回答ですが、古いタブの変更後は照合できていません。"} この画面は読むだけで、自己診断や人物カードには登録しません。元の記録を保管してください。</p>
    ${resultCard(result, mode, kind === "legacy" ? "unverified" : "readonly", false)}
    <a class="btn sub" href="#/me">この端末の記録へ戻る</a>`;
  attachMotion(result.figure.name);
  window.scrollTo(0, 0);
}

// ---------------- ルーティング ----------------
let visitSent = false;
app.addEventListener("click", (e) => { const el = e.target.closest("[data-src]"); if (el) nextSrc = el.dataset.src; }, true);
function showGlobalSelfWarning() {
  const status = selfStateSnapshot().status;
  const warning = externalSessionClearFailed ? "session_clear_failed" : status;
  const existing = app.querySelector("[data-self-warning]");
  if (warning === "ok") { existing?.remove(); return; }
  if (existing?.dataset.selfWarning === warning) return;
  existing?.remove();
  const banner = document.createElement("p");
  banner.className = "note";
  banner.dataset.selfWarning = warning;
  banner.setAttribute("role", "alert");
  banner.innerHTML = warning === "session_clear_failed"
    ? '別のタブで削除されましたが、このタブの途中回答を消せたか確認できません。タブを閉じ、必要ならブラウザーのサイトデータを削除してください。'
    : '端末の診断記録を確認できないため、新しい結果は保存されません。先に<a href="#/me">この端末の記録を確認</a>してください。';
  app.prepend(banner);
}
let trustedEpoch = null;
let lastRevokedState = null;
let selfViewGeneration = 0;
let activeSelfResult = null;
let activeSelfOverview = null;
let externalSessionClearFailed = false;
function selfOverviewCurrentSignature(snapshot) {
  if (snapshot.status !== "ok") return null;
  return JSON.stringify(["normal", "love"].map((mode) => {
    const result = snapshot.state.current[mode];
    return result ? [result.code, result.via ?? null] : null;
  }));
}
function selfOverviewMeSignature(snapshot) {
  if (snapshot.status !== "ok") return null;
  const state = snapshot.state;
  const zukan = readZukanStorage();
  const personCardSnapshot = readPersonCardStorage();
  const personCardDisplay = personCardSnapshot.status === "ok"
    ? ["ok", personCardsFromRaw(personCardSnapshot.cards).cards.length]
    : [personCardSnapshot.status];
  const counts = [0, 0];
  for (const [id, entry] of Object.entries(zukan.zukan)) {
    if (!SD.figures[id] || !isFree(id)) continue;
    counts[DISCOVER_SRC.has(entry.src) ? 0 : 1]++;
  }
  return JSON.stringify([
    selfOverviewCurrentSignature(snapshot),
    state.count,
    ["normal", "love"].map((mode) => {
      const previous = state.previous[mode];
      return previous ? [previous.code, previous.at, previous.via ?? null] : null;
    }),
    state.seenResults,
    state.pendingZukan.length,
    zukan.status,
    counts,
    personCardDisplay,
  ]);
}
function captureSelfOverview(snapshot = selfStateSnapshot()) {
  activeSelfOverview = { hash: location.hash, status: snapshot.status,
    current: selfOverviewCurrentSignature(snapshot),
    me: location.hash === "#/me" ? selfOverviewMeSignature(snapshot) : null };
}
function deferUnverifiedMeRefresh() {
  if (app.querySelector("[data-self-overview-pending]")) return;
  const notice = document.createElement("p");
  notice.className = "note";
  notice.dataset.selfOverviewPending = "";
  notice.setAttribute("role", "alert");
  notice.textContent = "別のタブで端末記録の状態が変わりました。入力中の確認を残すため、この画面はまだ更新していません。";
  const button = document.createElement("button");
  button.className = "btn sub";
  button.type = "button";
  button.textContent = "端末記録を更新して表示";
  button.addEventListener("click", () => {
    if (location.hash !== "#/me") return;
    const scrollY = window.scrollY;
    renderMe();
    window.scrollTo(0, scrollY);
  });
  notice.append(button);
  app.prepend(notice);
}
function revokeStaleSelfView() {
  const status = selfStateSnapshot().status;
  const currentEpoch = currentClearEpoch();
  if (trustedEpoch === null && currentEpoch.status === "present") trustedEpoch = currentEpoch.token;
  const epochChanged = trustedEpoch !== null
    && (currentEpoch.status !== "present" || currentEpoch.token !== trustedEpoch);
  if (status !== "missing_after_migration" && !epochChanged) {
    lastRevokedState = null;
    return false;
  }
  const signature = `${status}:${currentEpoch.status}:${currentEpoch.token ?? ""}`;
  if (signature === lastRevokedState) {
    // Do not let Back or a newly entered result hash reopen an unverified
    // answer-bearing page after an old-tab clear.
    if (status === "missing_after_migration"
      && !["#/me", "#/about"].includes(location.hash)) {
      const safeUrl = new URL(location.href);
      safeUrl.hash = "#/me";
      safeUrl.searchParams.delete("shared");
      safeUrl.searchParams.delete("shared_fig");
      safeUrl.searchParams.delete("shared_mode");
      history.replaceState(history.state, "", safeUrl.href);
    }
    return false;
  }
  lastRevokedState = signature;
  selfViewGeneration++;
  if (!clearPrefixedStorage(() => sessionStorage)) externalSessionClearFailed = true;
  quiz = null;
  justFinished = null;
  otherQuiz = null;
  confirmedOtherToken = null;
  nextSrc = null;
  lastSharedInMemory.normal = null;
  lastSharedInMemory.love = null;
  personSnapshot = null;
  shareCache = { key: null, blob: null };
  legacyHandles.clear();
  trustedEpoch = currentEpoch.status === "present" ? currentEpoch.token : null;
  const safeUrl = new URL(location.href);
  safeUrl.hash = "#/me";
  safeUrl.searchParams.delete("shared");
  safeUrl.searchParams.delete("shared_fig");
  safeUrl.searchParams.delete("shared_mode");
  history.replaceState(history.state, "", safeUrl.href);
  return true;
}
function route() {
  // A hash navigation can beat the storage event. Check the last trusted epoch
  // before rendering a result, without acknowledging an unseen deletion.
  revokeStaleSelfView();
  activeSelfResult = null;
  activeSelfOverview = null;
  activePeopleCardsView = null;
  activePersonCardView = null;
  queueMicrotask(showGlobalSelfWarning);
  disposeGuide();
  disposeGuide = () => {};
  disposeMotion();
  disposeMotion = () => {};
  clearTimers();
  { const [, pg, md, cd] = location.hash.split("/");
    currentMode = (pg === "q" || pg === "r" || pg === "f") && engines[md] ? md : "none";
    if (!visitSent) {
      visitSent = true;
      const entry = pg === "r" ? (savedResult(md)?.code === cd ? "own_result" : "shared_link")
        : pg === "f" ? "shared_link" : pg === "q" ? "quiz" : pg === "zukan" ? "zukan" : "top";
      track("visit", { entry, returning: RETURNING ? "yes" : "no" });
    } }
  overlay.hidden = true; app.inert = false; closeSheet(false);
  app.style.cssText = "";
  const [, page, mode, code] = location.hash.split("/");
  if (pendingGuardedResume && (page !== "q" || mode !== pendingGuardedResume.mode)) pendingGuardedResume = null;
  if ((page === "legacy" || page === "saved-readonly") && (mode === "normal" || mode === "love"))
    return renderSelfReadOnly(mode, code, page);
  if (!OTHER_PILOT && ["ask", "answer", "reply"].includes(page)) return renderUnavailable();
  const socialRoute = parseSocialHash(location.hash);
  if (page === "ask" && !mode) return renderAskHome();
  if (socialRoute?.kind === "invite") return renderAskEntry(socialRoute.token);
  if (page === "answer" && validInviteToken(mode) && !code) return subjectConfirmed(mode) ? renderOtherQuiz(mode) : renderAskEntry(mode);
  if (socialRoute?.kind === "reply") return renderOtherReply(socialRoute.token, socialRoute.code);
  if (page === "people" && !mode) return renderPeople();
  if (page === "person" && mode && !code) return renderPersonCard(mode);
  if (["ask", "answer", "reply", "people", "person"].includes(page)) return renderUnavailable();
  if (["fr", "invite"].includes(page) || (page === "q" && !engines[mode])) return renderUnavailable();
  if (page === "r" && !engines[mode]) return renderUnavailable();
  if (page === "f" && (!engines[mode] || !SD.figures[code] || !isFree(code))) return renderUnavailable();
  if (page === "q" && (mode === "normal" || mode === "love")) return renderQuiz(mode);
  if (page === "r" && (mode === "normal" || mode === "love")) return renderResult(mode, code);
  if (page === "zukan") return renderZukan();
  if (page === "me") return renderMe();
  if (page === "how") return renderHow();
  if (page === "about") return renderAbout();
  if (page === "f" && (mode === "normal" || mode === "love") && SD.figures[code] && isFree(code)) return renderFigure(mode, code);
  quiz = null;
  renderTop();
}
function focusPageHeading() {
  if (/^#\/q\/(normal|love)(?:\/|$)/.test(location.hash)) return; // 質問には専用のフォーカス移動がある
  if (app.querySelector(".rcard.reveal-wait")) return; // 結果演出後に見出しへ移す
  const heading = app.querySelector("h1, h2");
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}
window.addEventListener("hashchange", (event) => {
  // 受信ページから別画面へ進んだ後の履歴項目には、共有文脈を持ち越さない。
  const before = new URL(event.oldURL), after = new URL(event.newURL);
  if (before.searchParams.get("shared") === "1" && before.hash !== after.hash
    && after.searchParams.get("shared") === "1") {
    const clean = new URL(withoutSharedResultParam(after.href));
    clean.searchParams.delete("shared_fig");
    clean.searchParams.delete("shared_mode");
    history.replaceState(history.state, "", clean.href);
  }
  route();
  focusPageHeading();
});
addEventListener("keydown", (e) => {
  if (sheet.hidden) return;
  if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
  if (e.key !== "Tab") return;
  const focusables = [...sheet.querySelectorAll('a[href], button:not([disabled]), input, summary, [tabindex="0"]')];
  if (!focusables.length) { e.preventDefault(); $(".panel", sheet).focus(); return; }
  const first = focusables[0], last = focusables.at(-1);
  if (e.shiftKey && (document.activeElement === first || document.activeElement === $(".panel", sheet))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
addEventListener("pagehide", () => {
  if (quiz && quiz.answers.length && !quiz.abandonSent) { quiz.abandonSent = true; track("quiz_abandon", { mode: quiz.mode, n: quiz.answers.length, source: quiz.source }); }
});
function refreshSelfAfterExternalChange() {
  if (revokeStaleSelfView()) {
    route();
    focusPageHeading();
    return;
  }
  refreshPeopleCardsAfterExternalChange();
  refreshPersonCardAfterExternalChange();
  if (activeSelfResult) {
    const snapshot = selfStateSnapshot();
    if (snapshot.status !== "ok") {
      if (!activeSelfResult.unverified) {
        activeSelfResult.unverified = true;
        selfViewGeneration++;
        shareCache = { key: null, blob: null };
        document.title = "診断の記録を確認できません｜世界の偉人性格診断";
        app.style.cssText = "";
        app.innerHTML = `<section class="card"><h1>この端末の結果を確認できません</h1><p>保存状態を読み取れないため、この結果を現在の自分の結果として表示しません。端末の記録を確認してください。</p><a class="btn sub" href="#/me">この端末の記録を見る</a></section>`;
        focusPageHeading();
      }
      return;
    }
    if (activeSelfResult.unverified
      || snapshot.state.current[activeSelfResult.mode]?.code !== activeSelfResult.code
      || (snapshot.state.current[OTHER[activeSelfResult.mode]]?.fig ?? null) !== activeSelfResult.otherFigure) {
      route();
      focusPageHeading();
      return;
    }
  }
  if (activeSelfOverview && activeSelfOverview.hash === location.hash) {
    const snapshot = selfStateSnapshot();
    const current = selfOverviewCurrentSignature(snapshot);
    const me = location.hash === "#/me" ? selfOverviewMeSignature(snapshot) : null;
    if (snapshot.status !== activeSelfOverview.status || current !== activeSelfOverview.current
      || me !== activeSelfOverview.me) {
      if (location.hash === "#/me") {
        // A recovery checkbox or export confirmation may be in progress on an
        // unverified record page. Leave it intact until the person refreshes.
        if (activeSelfOverview.status !== "ok") deferUnverifiedMeRefresh();
        else {
          const scrollY = window.scrollY;
          const focused = document.activeElement;
          let focusTarget = null;
          if (focused && app.contains(focused)) {
            const href = focused.tagName === "A" ? focused.getAttribute("href") : null;
            const marker = focused.tagName === "BUTTON"
              ? ["data-export-self", "data-retry-all-self-zukan"].find((name) => focused.hasAttribute(name)) : null;
            focusTarget = href ? { kind: "link", href }
              : focused.tagName === "BUTTON" && focused.hasAttribute("data-fresh")
                ? { kind: "fresh", mode: focused.dataset.fresh }
                : marker ? { kind: "button", marker } : { kind: "heading" };
          }
          renderMe();
          window.scrollTo(0, scrollY);
          if (focusTarget) {
            const match = focusTarget.kind === "link"
              ? [...app.querySelectorAll("a[href]")].find((link) => link.getAttribute("href") === focusTarget.href)
              : focusTarget.kind === "fresh" ? app.querySelector(`button[data-fresh="${focusTarget.mode}"]`)
                : focusTarget.kind === "button" ? app.querySelector(`[${focusTarget.marker}]`) : null;
            const destination = match && !match.hidden && !match.disabled ? match : app.querySelector("h1");
            if (typeof destination?.focus === "function") {
              if (destination !== match) destination.tabIndex = -1;
              try {
                destination.focus({ preventScroll: true });
                destination.scrollIntoView?.({ block: "nearest", inline: "nearest" });
              } catch { /* Keep the updated page visible. */ }
            }
          }
        }
      } else if (location.hash === "#/people") {
        const ownShares = ownSelfShares(snapshot);
        const container = app.querySelector("[data-self-overview]");
        if (container) {
          container.innerHTML = peopleOwnSharesHtml(ownShares);
          bindPeopleOwnShares(ownShares);
        }
        captureSelfOverview(snapshot);
      } else {
        const me = snapshot.status === "ok" ? snapshot.state.current : { normal: null, love: null };
        const container = app.querySelector("[data-self-overview]");
        if (container) container.innerHTML = topCurrentResultsHtml(me);
        captureSelfOverview(snapshot);
      }
      refreshTopQuizCtas();
      showGlobalSelfWarning();
      return;
    }
  }
  refreshTopQuizCtas();
  showGlobalSelfWarning();
}
addEventListener("storage", (event) => {
  if (event.key === null || event.key === SELF_KEY || event.key === "ijin-clear-epoch"
    || event.key === "ijin-self-migration-gate" || event.key === "ijin.zukan"
    || event.key === "ijin.people.cards" || event.key?.startsWith("ijin.me.")
    || ["ijin.diagLedger", "ijin.diagCount", "ijin.seen_results",
      "ijin.progress.normal", "ijin.progress.love"].includes(event.key)) {
    if (location.hash === "#/me" && activeSelfOverview?.status !== "ok"
      && event.key?.startsWith("ijin.me.")) deferUnverifiedMeRefresh();
    refreshSelfAfterExternalChange();
  }
});
addEventListener("pageshow", refreshSelfAfterExternalChange);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshSelfAfterExternalChange();
});
// 権威キーを先に一度だけ移行・初期化し、それ以後は旧 SELF キーを読まない。
await initialEpochPromise;
if (selfLockAvailable()) await withSiteRecordsLock(() => {
  const epoch = currentClearEpoch();
  return epoch.status === "present" ? initializeSelfState(localStorage, epoch.token, verifiedResult)
    : { status: "epoch_unavailable" };
});
route();
if (selfStateSnapshot().status === "ok") store.set("visited", true);
window.__ijinReady = true;
// ローカル版では Firebase Auth に接続しない。

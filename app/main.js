// 画面：トップ（#/）→ 質問（#/q/<mode>）→ 結果（#/r/<mode>/<回答>）／ 図鑑（#/zukan）
// 結果のURLには回答（1〜5の数字の列）が入るので、そのままシェアできる。
// 設計の根拠：docs/ui-redesign.md（デザイナー）、docs/game-design-review.md の P0（ゲーム開発者）
import { AXES, Shindan, loadData } from "./shindan.js?v=bc7e9b7-202610191458";
import { mountMotion } from "./motion.js?v=bc7e9b7-202610191458";
import { mountGuide } from "./guide.js?v=bc7e9b7-202610191458";
import { separateLegacyLinkedResults } from "./legacy_data.js?v=bc7e9b7-202610191458";
import { createInviteToken, validInviteToken, validFriendCode, makeFriendCode, friendAnswersFromCode, makeInviteUrl, makeReplyUrl, parseSocialHash, otherPilotAllowed } from "./social.js?v=bc7e9b7-202610191458";
import { orderOtherV1Questions, otherV1ProgressIndex } from "./other_v1.js?v=bc7e9b7-202610191458";
import { appendOtherReply, removeOtherReply } from "./other_replies.js?v=bc7e9b7-202610191458";
import { prependPersonCard, distinctCardFigures, figureSetProgress } from "./people.js?v=bc7e9b7-202610191458";
import { isSharedResultEntry, sharedResultViewPath, withoutSharedResultParam } from "./shared_entry.js?v=bc7e9b7-202610191458";
import { storedResultMatches, storedList } from "./stored_result.js?v=bc7e9b7-202610191458";
import { clearPrefixedStorage } from "./storage_clear.js?v=bc7e9b7-202610191458";

const $ = (s, el = document) => el.querySelector(s);
const app = $("#app"), overlay = $("#overlay"), sheet = $("#sheet");
const getJSON = (u) => fetch(u).then((r) => r.json());
let data, meta;
try {
  [data, meta] = await Promise.all([loadData(), getJSON("meta.json?v=bc7e9b7-202610191458")]);
} catch (e) {
  app.insertAdjacentHTML("beforeend", `<p class="note" style="margin-top:20px">読みこみに失敗しました。通信状況を確かめて、ページを再読みこみしてください。</p>`);
  throw e;
}
window.__ijinReady = true;
const engines = { normal: new Shindan(data, "free", "normal"), love: new Shindan(data, "free", "love") };
// OTHER の設問は試験中。未較正の人物判定を実行せず、回答そのものを返す。
const otherQuestions = orderOtherV1Questions(data.questions_friend.questions);
const SD = engines.normal;
const texts = data.texts.figures;
const axisById = Object.fromEntries(data.axes.axes.map((a) => [a.id, a]));
const THEMES = meta.themes;
// 他己用6軸の質問品質と補正値は未検証。公開サイトには出さず、ローカル試作だけで確認する。
const OTHER_PILOT = otherPilotAllowed(location.hostname);
const MAX_TIER = SD.plan.max_tier;
const FREE = Object.values(SD.figures).filter((f) => f.tier <= MAX_TIER);
const LOCKED = Object.values(SD.figures).filter((f) => f.tier > MAX_TIER);
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
const isFree = (id) => fig(id).tier <= MAX_TIER;
const avatar = (id, sil = false) => (isFree(id) ? (sil ? `avatars/full/sil/${id}.svg?v=2` : `avatars/full/${id}.svg?v=2`) : `avatars/sil/${id}.svg`);
const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
// 系統色の上の文字は、白と黒のうち読みやすいほう（コントラスト比が大きいほう）にする
const onAccent = (hex) => ((lum(hex) + 0.05) / 0.05 > 1.05 / (lum(hex) + 0.05) ? "#26221d" : "#fff");
const themeVars = (typeId) => { const t = THEMES[typeId]; return `--t-bg:${t.bg};--t-bg2:${t.bg2};--t-bg3:${t.bg3};--t-accent:${t.accent};--t-on:${onAccent(t.accent)}`; };
const typeLabel = (t, mode) => (mode === "love" ? { name: t.love_name, catch: t.love_catch } : { name: t.name, catch: t.catch });
const mainLine = (id, mode) => (mode === "love" ? texts[id]?.love?.line : texts[id]?.serif) ?? "";
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast"; el.setAttribute("role", "status"); el.textContent = msg; document.body.append(el);
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
const validProgress = (p) => p && Number.isFinite(p.t) && Array.isArray(p.answers) && p.answers.length <= 12
  && p.answers.every((v) => Number.isInteger(v) && v >= 1 && v <= 5);
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
  // 旧版や手動編集された保存データも、確認ダイアログでは短い一行に収める。
  const label = typeof card.label === "string"
    ? [...card.label.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").trim()].slice(0, 20).join("")
    : "";
  const name = label || `友達カード ${displayIndex + 1}`;
  const mode = card.mode === "love" ? "恋愛版" : "性格版";
  const result = verifiedFigureName || "結果を確認できないカード";
  return `「${name}」（${displayIndex + 1}枚目・${result}・${mode}）をこの端末から削除しますか？`;
};
// 同じ回答コードでも別の人であり得る。カードの識別子は回答と分ける。
function addPersonCard(mode, code, figureId) {
  const cards = store.get("people.cards", []);
  const id = createInviteToken();
  const next = prependPersonCard(cards, { id, mode, code, fig: figureId, at: Date.now() }, 50, usablePersonCard);
  if (!next) return "full";
  if (JSON.stringify(store.get("people.cards", [])) !== JSON.stringify(cards)) return "error";
  if (!store.set("people.cards", next)) return "error";
  return peopleCards().some((card) => card.id === id) ? "saved" : "error";
}
const verifiedResult = (mode, entry) => storedResultMatches(mode, entry, engines, SD.figures, validCode, answersOf);
const savedResult = (mode) => { const entry = store.get("me." + mode); return verifiedResult(mode, entry) ? entry : null; };
separateLegacyLinkedResults(store, engines, validCode, (id) => !!SD.figures[id]);

// 図鑑：{figureId: {src: "me|friend_diag|match|next|friend", sources: string[], at}}
// src は「今のところいちばん強い発見経路」（後方互換のため残す）。sources は出会った経路を全部ためる配列（新設）
const DISCOVER_SRC = new Set(["me", "friend_diag"]); // この2つだけが正式な図鑑「発見」（旧データの src:"me" もそのまま discovered 扱い）
function meet(id, src) {
  if (!id || !isFree(id)) return;
  const z = store.get("zukan", {});
  const cur = z[id];
  const prevSources = cur?.sources ?? (cur ? [cur.src] : []);
  const sources = prevSources.includes(src) ? prevSources : [...prevSources, src];
  const discovering = DISCOVER_SRC.has(src);
  const wasDiscovered = cur && DISCOVER_SRC.has(cur.src);
  if (!cur || discovering || !wasDiscovered) {
    z[id] = { src: discovering ? src : (wasDiscovered ? cur.src : src), sources, at: Date.now() };
  } else {
    z[id] = { ...cur, sources };
  }
  store.set("zukan", z);
}
// 図鑑の状態（保存形式は変えない。src の意味で3段階に読み分ける）
//   DISCOVERED：自分の正式な診断結果（通常・恋愛）src "me"、または友達診断で登録 src "friend_diag"。全身画像・説明・動きを見せる
//   KNOWN     ：相性・もしも・共有結果などで名前だけ知った ＝ src "match" | "next" | "friend"。名前＋シルエット＋🔒未発見
//   UNKNOWN   ：まだ記録がない。？？？＋シルエット
const zState = (id) => { const e = store.get("zukan", {})[id]; return !e ? "unknown" : DISCOVER_SRC.has(e.src) ? "discovered" : "known"; };
const isDiscovered = (id) => zState(id) === "discovered";
const zukanCount = () => Object.entries(store.get("zukan", {})).filter(([id, e]) => DISCOVER_SRC.has(e.src) && SD.figures[id] && isFree(id)).length;
const knownCount = () => Object.entries(store.get("zukan", {})).filter(([id, e]) => !DISCOVER_SRC.has(e.src) && SD.figures[id] && isFree(id)).length;
// 図鑑の「取得元」を日本語表示用に（discoveredな経路だけ）
const SRC_LABEL = { me: "自分の診断", friend_diag: "旧版の友達診断" };
const sourceLabels = (id) => { const e = store.get("zukan", {})[id]; return [...new Set(e?.sources ?? (e ? [e.src] : []))].map((s) => SRC_LABEL[s]).filter(Boolean); };
// 関連表示（相性・もしも・友達）の顔：発見済みだけ通常の絵、それ以外はシルエット＋「🔒 未発見」
const relFace = (id) => avatar(id, !isDiscovered(id));
const undiscTag = (id) => (isDiscovered(id) ? "" : `<span class="undisc">🔒 未発見</span>`);

// ---------------- トップ ----------------
let firstTop = true;
function topQuizCtas() {
  const progress = Object.fromEntries(["normal", "love"].map((mode) => {
    const saved = store.get("progress." + mode);
    return [mode, validProgress(saved) && Date.now() - saved.t < 864e5 && saved.answers.length > 0 ? saved : null];
  }));
  const resumable = ["normal", "love"].filter((mode) => progress[mode]);
  const primary = resumable[0] ?? "normal";
  const resumeLinks = resumable.map((mode) => `<a class="btn ${mode === primary ? "start" : "sub"}" data-src="resume" href="#/q/${mode}">${mode === "love" ? "恋愛診断" : "性格診断"}の続きから（${progress[mode].answers.length} / 12）</a>`).join("");
  const freshLinks = ["normal", "love"].map((mode) => {
    const label = mode === "love" ? "恋愛診断" : "性格診断";
    const text = `${mode === "love" && !progress[mode] ? "💘 " : ""}${label}を${progress[mode] ? "最初から" : ""}始める`;
    const cls = mode === primary && !progress[mode] ? "start" : mode === "love" ? "love-sub" : "sub";
    return `<a class="btn ${cls}" data-fresh="${mode}" data-src="top" href="#/q/${mode}">${text}</a>`;
  }).join("");
  return resumeLinks + freshLinks;
}
function renderTop() {
  document.title = "世界の偉人性格診断";
  const staticParade = firstTop ? $(".parade")?.innerHTML : null;
  firstTop = false;
  const me = { normal: savedResult("normal"), love: savedResult("love") };
  const types = pick(SD.types.filter((t) => t.unit), 4);
  const parade = types.map((t) => pick(t.figures.slice(0, MAX_TIER + 1), 1)[0].id);
  parade.splice(2, 0, pick(FREE, 1)[0].id);
  // 5人目は「まだ見ぬ誰か」のシルエット（鍵つきがいなければ、無料のうち出会っていない人から）
  const unseen = FREE.filter((f) => !parade.includes(f.id) && !store.get("zukan", {})[f.id]);
  const lockedOne = pick(LOCKED.length ? LOCKED : unseen.length ? unseen : FREE, 1)[0].id;
  const faces = parade.slice(0, 4).map((id, i) =>
    `<img class="face f${i}" src="${avatar(id)}" alt="" style="--t-bg:${THEMES[fig(id).type].bg}">`).join("")
    + `<img class="face f4" src="${avatar(lockedOne, true)}" alt="" style="--t-bg:${THEMES[fig(lockedOne).type].bg}">`;
  const againCard = me.normal || me.love ? `
    <div class="again">
      ${["normal", "love"].filter((m) => me[m]).map((m) => `
        <a class="row" href="#/r/${m}/${me[m].code}" style="text-decoration:none;color:inherit">
          <img class="tile" src="${avatar(me[m].fig)}" alt="" style="${themeVars(fig(me[m].fig).type)}">
          <div><div class="lbl">いまの${m === "love" ? "恋愛診断" : "性格診断"}の結果${me[m].via === "link" ? "（リンクから保存）" : ""}</div><div class="nm">${esc(fig(me[m].fig).name)}</div></div>
        </a>`).join("")}
      <a class="btn sub" href="#/zukan">図鑑を見る（${zukanCount()} / ${FREE.length}）</a>
      <a class="btn sub" href="#/me">この端末の記録（自分・受け取った結果）</a>
    </div>` : "";
  app.innerHTML = `
    <section class="hero">
      <div class="seal">偉</div>
      <div id="guide"></div>
      <h1>${FREE.length}人の偉人のうち、<br>あなたは誰？</h1>
      <p class="sub">12問・約1分半・登録なし</p>
    </section>
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
    ${againCard}
    <div class="teaser"></div>
    <button class="btn-text teaser-toggle" type="button" data-teaser-toggle>一言を止める</button>
    <div class="type-strip" aria-hidden="true">${SD.types.map((t) => `<i style="background:${THEMES[t.id].bg2}"></i>`).join("")}</div>
    <p class="note">${LOCKED.length ? `無料で出会えるのは${FREE.length}人。ほか${LOCKED.length}人はシルエットで待機中。` : `${FREE.length}人すべてに、無料で出会えます。`}<br>逸話には伝承や諸説あるものを含みます。</p>
    <p class="note"><a href="#/how">使い方</a>　・　<a href="#/me">この端末の記録</a>　・　<a href="#/about">このサイトについて</a></p>`;
  app.querySelectorAll("[data-fresh]").forEach((a) => (a.onclick = () => { store.del("progress." + a.dataset.fresh); quiz = null; }));
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
      <div><div class="who">${esc(f.name)}タイプの人は</div><div class="line">「${esc(texts[f.id].serif)}」</div></div>`;
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

function renderQuiz(mode, anim = false) {
  const sd = engines[mode];
  if (!quiz || quiz.mode !== mode) {
    const saved = store.get("progress." + mode);
    const qs = ordered(sd);
    quiz = { mode, qs, answers: [], i: 0 };
    if (validProgress(saved) && Date.now() - saved.t < 864e5) { quiz.answers = saved.answers; quiz.i = Math.min(saved.answers.length, qs.length - 1); }
    const resumed = validProgress(saved) && saved.answers.length && quiz.i > 0;
    quiz.source = resumed ? saved.source ?? "resume" : nextSrc ?? "top";
    nextSrc = null;
    if (!resumed) track("quiz_start", { mode, source: quiz.source });
  }
  quiz.busy = false;
  const { qs, answers, i } = quiz;
  const q = qs[i];
  document.title = `質問 ${i + 1}｜${sd.modeConf.name}`;
  const intro = mode === "love" && i === 0 ? `<div class="intro">${esc(data.questions_love.intro)}</div>` : "";
  app.innerHTML = `
    <div class="qhead">
      ${i === 0 ? '<a class="back" href="#/">← トップへ</a>' : '<button class="back">← 戻る</button>'}
      <span class="count"><b>${i + 1}</b> / ${qs.length}</span>
      <span class="mystery" style="--p:${(i / qs.length) * 100}%" aria-hidden="true">?</span>
    </div>
    <div class="segs">${qs.map((_, k) => `<i class="${k < i ? "done" : k === i ? "now" : ""} ${[3, 7, 11].includes(k) ? "chest" : ""}"></i>`).join("")}</div>
    <div class="qbox ${anim ? "in" : ""}">
      ${intro}
      <h1 class="qtext" id="current-question" tabindex="-1">${esc(q.text)}</h1>
      <p class="qhint">いちばん近いものを1つ選んでね。押すと次へ進みます。</p>
      <div class="scale5" role="group" aria-labelledby="current-question">
        ${[1, 2, 3, 4, 5].map((v) => `<button class="dotbtn v${v} ${answers[i] === v ? "sel" : ""}" data-v="${v}" aria-label="${esc(sd.data.questions.scale[v - 1])}${answers[i] === v ? "（前の回答）" : ""}"><i aria-hidden="true"></i><span>${esc(sd.data.questions.scale[v - 1])}</span></button>`).join("")}
      </div>
    </div>`;
  window.scrollTo(0, 0);
  $(".qtext").focus({ preventScroll: true });
  if (i > 0) $(".back").onclick = () => { clearTimers(); quiz.busy = false; quiz.i--; renderQuiz(mode, true); };
  app.querySelectorAll(".dotbtn").forEach((b) => (b.onclick = () => {
    if (quiz.busy) return;
    quiz.busy = true;
    const activeQuiz = quiz;
    quiz.answers[i] = Number(b.dataset.v);
    quiz.answers.length = Math.max(quiz.answers.length, i + 1);
    app.querySelectorAll(".dotbtn").forEach((choice) => {
      choice.classList.remove("sel");
      choice.setAttribute("aria-label", choice.querySelector("span").textContent);
    });
    b.classList.add("sel");
    b.setAttribute("aria-label", `${b.querySelector("span").textContent}（選択中）`);
    navigator.vibrate?.(8);
    store.set("progress." + mode, { answers: quiz.answers.slice(0, i + 1).concat(quiz.answers.slice(i + 1)), t: Date.now(), source: quiz.source });
    later(120, () => { if (quiz === activeQuiz && quiz.i === i && location.hash === `#/q/${mode}`) $(".qbox")?.classList.add("out"); });
    later(300, () => {
      if (quiz !== activeQuiz || quiz.i !== i || location.hash !== `#/q/${mode}`) return;
      quiz.busy = false;
      if (i + 1 >= qs.length) return finishQuiz(mode);
      quiz.i++;
      const seen = store.get("seen_checkpoint", false);
      if (!seen && (i + 1 === 4 || i + 1 === 8)) return renderCheckpoint(mode, i + 1);
      renderQuiz(mode, true);
    }, 300);
  }));
}

function renderCheckpoint(mode, n) {
  const sd = engines[mode];
  const ans = Object.fromEntries(quiz.qs.map((q, k) => [q.id, quiz.answers[k]]).filter(([, v]) => v));
  const u = partialU(sd, ans);
  const ranked = rankTypes(sd, u);
  let body;
  if (n === 4) {
    const hot = new Set(ranked.slice(0, 5).map((t) => t.id));
    body = `<h2>いまの回答から、候補が見えてきました</h2>
      <div class="emblems">${sd.types.filter((t) => t.unit).map((t) =>
        `<span class="emb ${hot.has(t.id) ? "hot" : ""}" style="background:${THEMES[t.id].accent}">${esc(t.name[0])}</span>`).join("")}</div>`;
  } else {
    const three = ranked.slice(0, 3);
    body = `<h2>いま有力な3つの系統</h2><p class="note">残りの回答で候補は変わることがあります。</p>
      <div class="sils">${three.map((t) => `<div><img class="tile" src="${avatar(t.figures[0].id, true)}" alt="" style="${themeVars(t.id)}">
        <div class="note" style="margin-top:4px">${esc(typeLabel(t, mode).name)}</div></div>`).join("")}</div>`;
  }
  app.innerHTML = `<div class="checkpoint">${body}<button class="btn start" type="button">続ける（あと${quiz.qs.length - n}問）</button></div>`;
  window.scrollTo(0, 0);
  $(".checkpoint h2").tabIndex = -1;
  $(".checkpoint h2").focus({ preventScroll: true });
  $(".checkpoint button").onclick = () => { if (n === 8) store.set("seen_checkpoint", true); renderQuiz(mode, true); };
}

function finishQuiz(mode) {
  const code = makeCode(quiz.answers);
  store.del("progress." + mode);
  justFinished = { mode, code, source: quiz.source };
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
  return `<span class="stars" aria-label="濃さ ${tier + 1}">${[0, 1, 2, 3, 4].map((k) =>
    k <= tier ? '<span class="on">★</span>' : k <= MAX_TIER ? '<span class="off">★</span>' : '<span class="lock">🔒</span>').join("")}</span>`;
}

function resultCard(r, mode, who, reveal) {
  const f = r.figure, t = r.type, tl = typeLabel(t, mode);
  const artNote = (f.id === "washington" ? '<p class="note">※ 斧と桜は史実ではなく、後世の伝説を図案化したものです</p>' : "")
    + (f.id === "natsume-soseki" && mode === "love" ? '<p class="note">※「月が綺麗ですね」を漱石が訳したという出典は確認されていません</p>' : "");
  const lead = who === "friend" ? "リンクに含まれる回答から見える姿" : who === "past" ? "以前のあなたの回答から見える姿" : who === "saved" ? "リンクから保存した、この端末の「自分の結果」" : (mode === "love" ? "恋愛についての回答から見えるあなた" : "あなた自身の回答から見えるあなた");
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
  return `${mode === "love" ? "恋をした私は" : "私は"}「${f.name}」タイプだった\n「${mainLine(f.id, mode)}」\n`
    + (mode === "love" && f.id === "natsume-soseki" ? "※漱石訳という出典は未確認\n" : "")
    + (fate ? `因縁の相手：${fig(fate.other).name}（${fate.label}）\n` : "")
    + `あなたはどの偉人？ 12問でわかる👇\n#${engines[mode].modeConf.name}`;
}

function fateOf(id) {
  const o = data.rules.battle.overrides.find((x) => x.winner === id || x.loser === id);
  return o ? { ...o, win: o.winner === id, other: o.winner === id ? o.loser : o.winner } : null;
}

function renderResult(mode, code) {
  const sd = engines[mode];
  if (!validCode(sd, code)) {
    document.title = "結果リンクを開けません｜世界の偉人性格診断";
    app.style.cssText = "";
    app.innerHTML = `<section class="card"><h1>この結果リンクは開けませんでした</h1><p>リンクが途中で切れているか、対応していない形式です。</p><a class="btn start" href="#/q/${mode}">新しく診断する</a><a class="btn sub" style="margin-top:10px" href="#/">トップへ</a></section>`;
    return;
  }
  const r = sd.diagnose(answersOf(sd, code));
  const f = r.figure;
  const mine = savedResult(mode);
  const fresh = justFinished && justFinished.mode === mode && justFinished.code === code;
  const freshSource = fresh ? justFinished.source : null;
  justFinished = null;
  const fromSharedPage = isSharedResultEntry(location.href, mode, code);
  const who = fromSharedPage ? "friend" : (fresh || mine?.code === code ? "me" : "friend");
  const seen = storedList(store.get("seen_results", []));
  const reveal = fresh;
  const shortReveal = fresh && seen.includes(mode + code);
  document.title = `${f.name}タイプ｜${sd.modeConf.name}`;
  if (fresh) track("quiz_complete", { mode, source: freshSource, figure: f.id, type: r.type.id, tier: r.tier + 1, capped: r.capped ? "yes" : "no" });

  if (who === "friend") return renderFriend(sd, mode, code, r, null, fromSharedPage);

  // 自分の結果として記録する
  if (fresh) {
    if (mine && mine.code !== code) store.set("me.prev." + mode, mine);
    store.set("me." + mode, { code, fig: f.id, at: Date.now() });
    store.set("seen_results", [...new Set([...seen, mode + code])].slice(-30));
  }
  // 図鑑：自分でこの端末で診断した結果だけ DISCOVERED。リンクから保存した結果（via:"link"）は KNOWN のまま
  meet(f.id, !fresh && mine?.via === "link" ? "friend" : "me");
  if (fresh) {
    store.set("diagCount", store.get("diagCount", 0) + 1);
    // 公開版の診断記録は、この端末内にだけ保存する。
  }
  const localSaveOk = !fresh || (store.get("me." + mode)?.code === code && isDiscovered(f.id));
  const fate = fateOf(f.id);
  const ms = sd.matchups(r.u, r.type, r.tier, f.id, sd.types.length);
  const strongId = ms.strong.find((id) => id !== fate?.other);
  const weakId = ms.weak.find((id) => id !== fate?.other && id !== strongId);
  [strongId, weakId, fate?.other].forEach((id) => meet(id, "match"));
  if (r.levelup && !r.levelup.locked) meet(r.levelup.to, "next");
  const friend = lastSharedInMemory[mode] || store.get("lastFriend." + mode);
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
      <p class="social-note">以前にこのブラウザーで開いた共有結果です。自分のリンクも含み、送り主は確認できません。友達のカードはリンク先で手動で追加できます。</p></div>` : "";
  const otherHtml = other && validCode(engines[OTHER[mode]], other.code) ? (() => {
    const [n, l] = mode === "normal" ? [f.id, other.fig] : [other.fig, f.id];
    return `<section class="card"><h2>${n === l ? "ふだんも恋も同じ偉人" : "表の顔 × 恋の顔"}</h2>
      <div class="duo"><div><img class="tile" src="${avatar(n)}" alt="" style="${themeVars(fig(n).type)}"><div class="lbl">ふだんは</div><div class="nm">${esc(fig(n).name)}</div></div>
        <div class="x">${n === l ? "＝" : "×"}</div>
        <div><img class="tile" src="${avatar(l)}" alt="" style="${themeVars(fig(l).type)}"><div class="lbl">恋をすると</div><div class="nm">${esc(fig(l).name)}</div></div></div>
      <button class="btn sub" style="margin-top:12px" data-duo="${n},${l}">${n === l ? "同じ偉人だったとXに投稿" : "偉人の組み合わせをXに投稿"}</button></section>`;
  })() : `<section class="card"><h2>${mode === "normal" ? "恋愛バージョン" : "性格バージョン"}</h2>
      <p style="margin:0 0 12px">${mode === "normal" ? "恋をしたら、あなたは別の偉人かも？" : "ふだんのあなたは、どの偉人？"}（約1分半）</p>
      <a class="btn ${mode === "normal" ? "love-sub" : "sub"}" data-fresh="${OTHER[mode]}" data-src="other_mode" href="#/q/${OTHER[mode]}">${mode === "normal" ? "💘 恋愛診断をやる" : "性格診断をやる"}</a></section>`;
  app.style.cssText = themeVars(r.type.id);
  app.innerHTML = `
    ${resultCard(r, mode, !fresh && mine?.via === "link" ? "saved" : "me", reveal)}
    ${freshSource === "friend" ? returnSharedHtml : ""}
    <p class="note ${reveal ? "reveal-hide" : ""}" style="margin:12px 0 4px">${freshSource === "friend" ? "結果は自動では届きません。最初にリンクをくれた友達を選んで送ってください。" : "結果は自動では届きません。友達からリンクをもらった場合は、その相手を選んで返してください。"}結果リンクを知る人は、12問の答えを読み取れます。</p>
    <div class="share-row after ${reveal ? "reveal-hide" : ""}">
      <button class="btn primary wide" data-share="friend">${freshSource === "friend" ? "友達に結果を返す" : "友達に結果を送る"}</button>
      <a class="btn sub" data-share="line" target="_blank" rel="noopener">LINEで送る</a>
      <a class="btn sub" data-share="x" target="_blank" rel="noopener">Xでポスト</a>
      <button class="btn sub" data-share="image">画像を保存</button>
      <button class="btn sub" data-share="copy">リンクをコピー</button>
    </div>
    <p class="note ${reveal ? "reveal-hide" : ""}" style="margin:4px 0 12px">画像だけでは友達が結果を開けません。${freshSource === "friend" ? "最初にリンクをくれた友達へ結果リンクを返してください。結果は自動では届きません。" : "友達には結果リンクを送ってください。"}</p>
    ${!localSaveOk ? '<p class="note" role="alert">このブラウザには結果を保存できませんでした。必要なら、このページのリンクを控えてください。</p>' : ""}
    ${freshSource !== "friend" ? returnSharedHtml : ""}
    ${(() => { const prev = store.get("me.prev." + mode); return verifiedResult(mode, prev) && prev.code !== code
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
      <p>自分の共有リンクを開いた場合もこの画面になります。実際に別の人から届いた結果のときだけ、人物カードへ追加してください。返事を送りたい場合は自分の結果リンクをコピーできます。</p>
      <button class="btn sub" data-add-same-person>友達の人物カードに追加</button>
      <button class="btn sub" data-share="copy">自分の結果リンクを返す</button></details>
    <section class="card"><h2>図鑑</h2>
      <div class="progress-line"><span><b>${zukanCount()}</b> / ${FREE.length}人を発見</span><div class="bar"><i style="width:${(zukanCount() / FREE.length) * 100}%"></i></div></div>
      <a class="btn sub" style="margin-top:12px" href="#/zukan">図鑑を見る</a>
      </section>
    <div style="display:grid;gap:10px;margin-top:20px">
      <a class="btn sub" data-fresh="${mode}" data-src="retry" href="#/q/${mode}">もう一度診断する</a>
      <a class="btn sub" href="#/me">この端末の記録</a>
      <a class="btn sub" href="#/">トップへ</a></div>
    <p class="note" style="margin-top:16px"><a href="#/about">このサイトについて</a></p>
    <button class="fab" data-share="friend" hidden>結果リンクを送る</button>`;

  // シェア
  const url = shareUrl(mode, f.id, code), text = shareText(r, mode, fate);
  $('[data-share="x"]').href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  $('[data-share="line"]').href = `https://line.me/R/share?text=${encodeURIComponent(`${f.name}タイプだった😂 あなたは誰？ ${url}`)}`;
  app.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", async (e) => {
    const ch = b.dataset.share;
    track("share_click", { channel: ch, mode, figure: f.id });
    if (ch === "friend") { e.preventDefault(); shareLink(url, `私は「${f.name}」タイプだった！あなたも診断して、結果リンクを返してね。`); }
    if (ch === "copy") { e.preventDefault(); try { await navigator.clipboard.writeText(url); toast("リンクをコピーしました"); } catch { prompt("このリンクをコピーしてください", url); } }
    if (ch === "image") { e.preventDefault(); shareImage(r, mode, b); }
  }));
  app.querySelectorAll("[data-fresh]").forEach((a) => a.addEventListener("click", () => { store.del("progress." + a.dataset.fresh); quiz = null; }));
  $("[data-add-same-person]")?.addEventListener("click", () => {
    if (peopleCards().some((card) => card.mode === mode && card.code === code)
      && !confirm("同じ回答のカードが既にあります。別の人のカードとしてもう1枚追加しますか？")) return;
    try {
      const status = addPersonCard(mode, code, f.id);
      if (status !== "saved") return toast(status === "full" ? "人物カードは50枚まで。追加するには人物カード画面で不要なカードを削除してください" : "この端末に保存できませんでした");
      $("[data-add-same-person]").disabled = true;
      toast("友達の人物カードを1枚追加しました");
    } catch { toast("この端末ではカードを保存できません"); }
  });
  $("[data-duo]")?.addEventListener("click", () => {
    const [n, l] = $("[data-duo]").dataset.duo.split(",");
    track("share_click", { channel: "duo", figure: f.id });
    const t = `ふだんの私は「${fig(n).name}」、恋をすると「${fig(l).name}」でした。\nあなたの表の顔と恋の顔は？👇\n#偉人性格診断`;
    open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}&url=${encodeURIComponent(url)}`, "_blank", "noopener");
  });
  // スクロールしても消えないシェアボタン
  const fab = $(".fab"), row = $(".share-row");
  new IntersectionObserver(([e]) => (fab.hidden = e.isIntersecting || e.boundingClientRect.top > 0)).observe(row);
  prerenderShare(r, mode);
  window.scrollTo(0, 0);
  if (reveal) runReveal(r, mode, shortReveal);
  else later(0, () => { $(".stage").dataset.state = "done"; });
  if (fresh && localSaveOk) later(reveal ? 5600 : 0, () => toast(`図鑑に登録しました（${zukanCount()} / ${FREE.length}）`));
  attachMotion(f.name);
}

// 友達の結果（シェアされたリンクを開いた人）
function renderFriend(sd, mode, code, r, personCard = null, fromSharedPage = false) {
  const f = r.figure;
  const own = storedList(store.get("seen_results", [])).includes(mode + code);  // この端末で自分で診断したことがある結果
  const prevE = store.get("me.prev." + mode);
  const prevHere = verifiedResult(mode, prevE) && prevE.code === code; // 入れかえ前の結果
  const prevLink = !personCard && !fromSharedPage && !own && prevHere && prevE.via === "link"; // 入れかえ前の結果が、リンクから保存したもの
  const past = !personCard && !fromSharedPage && (own || (prevHere && !prevLink)); // 以前のあなた自身の結果
  if (!past && !personCard) {
    const friends = storedList(store.get("friends", []));
    if (!friends.some((x) => x && x.mode === mode && x.code === code && verifiedResult(mode, x)))
      store.set("friends", [{ mode, code, fig: f.id, at: Date.now() }, ...friends].slice(0, 20));
    lastSharedInMemory[mode] = { code, fig: f.id };
    store.set("lastFriend." + mode, lastSharedInMemory[mode]);
    meet(f.id, "friend");
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
      <div class="rels">${duelRow(sd, mu, r.u, mine.fig, f.id, { label: "届いたリンクの結果", otherWho: "リンクの結果", otherFace: avatar(f.id) })}</div></section>`;
  }
  if (!personCard && !past && !prevLink) track("friend_view", { mode, figure: f.id, has_mine: mine && validCode(sd, mine.code) ? "yes" : "no" });
  const personCta = personCard ? `<section class="card social-entry"><h2>保存した人物カード</h2>
    <p>${esc(personCard.label || "友達カード")}の共有結果です。あなた自身の診断結果とは別に保存しています。</p>
    <a class="btn sub" href="#/people">人物カード一覧へ</a></section>` : past || prevLink ? `<details class="card social-entry"><summary>友達がこの結果と同じだった場合</summary>
    <p>以前の自分や保存したリンクと同じ回答でも、別の友達から届いた結果なら人物カードに追加できます。</p>
    <button class="btn sub" data-add-person>友達の人物カードに追加する</button></details>` : `<section class="card social-entry"><h2>共有リンクを人物カードへ</h2>
    <p>友達から届いた結果だけカードに追加してください。リンクの送り主は確認できません。あなたの結果とは別に保存されます。</p>
    ${peopleCards().some((x) => x.mode === mode && x.code === code)
      ? '<p class="social-note">同じ回答のカードが保存されています。別の人から届いた結果なら、もう1枚追加できます。</p>'
      : ""}<button class="btn sub" data-add-person>人物カードに追加する</button></section>`;
  app.innerHTML = `
    <div class="friend-head">${personCard
      ? `<h1>${esc(personCard.label || "友達カード")}の結果<br>「${esc(f.name)}」<span class="friend-result-kind">タイプ</span></h1><p class="note friend-origin-note">人物カードに保存した共有結果です。あなたの結果とは別です。</p>`
      : past || prevLink
      ? `<h1>${prevLink ? "前に保存した、リンクの結果" : "以前のあなたの結果"}<br>「${esc(f.name)}」<span class="friend-result-kind">タイプ</span></h1>${mine ? `<p class="note" style="margin:6px 0 0">いまの自分の結果は「${esc(fig(mine.fig).name)}」です</p>` : ""}`
      : `<h1>共有リンクの結果は<br>「${esc(f.name)}」<span class="friend-result-kind">タイプ</span></h1><p class="note friend-origin-note">このリンクに記録された回答の結果です。あなた自身の結果と同じになることもあります。</p>`}
      <p class="back-links">${mine && validCode(sd, mine.code) ? `<a href="${esc(fromSharedPage && mine.code === code ? withoutSharedResultParam(location.href) : `#/r/${mode}/${mine.code}`)}">← 自分の結果（${esc(fig(mine.fig).name)}）へ戻る</a>` : ""}<a href="#/me">この端末の記録</a></p></div>
    ${resultCard(r, mode, past ? "past" : prevLink ? "saved" : "friend", false)}
    ${personCta}
    ${!personCard && !past && !prevLink && ownReply ? `<section class="card social-entry"><h2>自分の結果を友達に返す</h2>
      <p>友達から届いたリンクなら、最初にリンクを送った友達を選んで、自分の結果リンクを返してください。結果は自動では届きません。自分で開いたリンクなら操作は不要です。</p>
      <button class="btn start" data-return-self>自分の結果リンクを送る</button></section>` : ""}
    <div style="display:grid;gap:8px;margin:16px 0">
      ${mine ? (past || prevLink ? "" : `<a class="btn sub" data-fresh="${mode}" data-src="friend" href="#/q/${mode}">もう一度12問で診断する</a><p class="note" style="margin:0">新しい結果が、この端末の現在の結果になります。</p>${compat}`) : `<a class="btn start" data-fresh="${mode}" data-src="friend" href="#/q/${mode}">あなたは誰？ 12問で診断する</a>
      <p class="note" style="margin:0">答えたら自分の結果リンクを共有できます。友達から届いたなら、その友達へ返せます。</p>`}
    </div>
    <details class="card"><summary>${esc(f.name)}タイプってどんな人？</summary><p class="body">${esc(tx.body)}</p></details>
    <div class="claim">${past
      ? `<button class="btn sub" data-restore-self>以前の自己診断結果を、現在の自分の結果に戻す</button>`
      : `<p class="note">${personCard ? "人物カードに保存した結果です。" : prevLink ? "以前リンクから保存した結果です。" : "開いた共有リンクの結果です。"}自分の診断結果とは別に保存され、上書きしません。</p>`}</div>`;
  app.querySelectorAll("[data-fresh]").forEach((a) => a.addEventListener("click", () => { store.del("progress." + mode); quiz = null; }));
  $("[data-return-self]")?.addEventListener("click", () => shareLink(shareUrl(mode, mine.fig, mine.code), "あなたから届いた結果を見たよ。私の結果も送るね。"));
  $("[data-add-person]")?.addEventListener("click", () => {
    if (peopleCards().some((card) => card.mode === mode && card.code === code)
      && !confirm("同じ回答のカードが既にあります。別の人のカードとしてもう1枚追加しますか？")) return;
    try {
      const status = addPersonCard(mode, code, f.id);
      if (status !== "saved") return toast(status === "full" ? "人物カードは50枚まで。追加するには人物カード画面で不要なカードを削除してください" : "この端末に保存できませんでした");
    } catch { return toast("この端末ではカードを保存できません"); }
    location.hash = "#/people";
    toast("人物カードに保存しました");
  });
  if (past) {
    const currentKey = "me." + mode, previousKey = "me.prev." + mode;
    const currentAtDisplay = store.get(currentKey), previousAtDisplay = store.get(previousKey);
    const unchanged = () => JSON.stringify(store.get(currentKey)) === JSON.stringify(currentAtDisplay)
      && JSON.stringify(store.get(previousKey)) === JSON.stringify(previousAtDisplay)
      && JSON.stringify(savedResult(mode)) === JSON.stringify(mine)
      && JSON.stringify(previousAtDisplay) === JSON.stringify(prevE);
    const refreshChanged = () => {
      route();
      focusPageHeading();
      toast("別タブで自己診断結果が変わりました。更新して選び直してください");
    };
    const restoreButton = $("[data-restore-self]");
    restoreButton.onclick = () => {
      if (!unchanged()) return refreshChanged();
      if (!confirm(`以前の自己診断結果（${f.name}）を、現在の自分の結果に戻しますか？`)) return;
      if (!unchanged()) return refreshChanged();
      const replacePrevious = mine && mine.code !== code;
      if (replacePrevious && !store.set(previousKey, mine)) return toast("前の結果を保存できず、戻せませんでした");
      if (!store.set(currentKey, { code, fig: f.id, at: Date.now() })) {
        let previousRestored = true;
        if (replacePrevious) {
          if (previousAtDisplay === null) store.del(previousKey);
          else store.set(previousKey, previousAtDisplay);
          previousRestored = JSON.stringify(store.get(previousKey)) === JSON.stringify(previousAtDisplay);
        }
        if (!previousRestored) {
          const warning = document.createElement("p");
          warning.className = "clear-status";
          warning.setAttribute("role", "alert");
          warning.tabIndex = -1;
          warning.textContent = "現在の結果を保存できず、前の結果の記録も元に戻せませんでした。ページを閉じる前に、このページ（以前の結果）のURLを控え、この端末の記録を確認してください。";
          restoreButton.insertAdjacentElement("afterend", warning);
          warning.focus();
          return;
        }
        return toast("現在の結果を保存できませんでした。端末の記録を確認してください");
      }
      route();
      focusPageHeading();
    };
  }
  $(".stage").dataset.state = "done";
  attachMotion(f.name);
  window.scrollTo(0, 0);
}

// 人物カード固有IDから開く。回答コードが自分と同じでも、友達の表示文脈を保つ。
function renderPersonCard(id) {
  const cards = peopleCards();
  const index = cards.findIndex((x) => x.id === id);
  const card = cards[index];
  if (!card) return renderUnavailable();
  const displayCard = { ...card, label: card.label || `友達カード ${index + 1}` };
  const sd = engines[card.mode];
  const r = sd.diagnose(answersOf(sd, card.code));
  if (r.figure.id !== card.fig) return renderUnavailable();
  document.title = `${displayCard.label}｜${r.figure.name}タイプ`;
  renderFriend(sd, card.mode, card.code, r, displayCard);
}

// 結果が出る瞬間の演出（約5秒。どこをタップしても最後まで飛ぶ）
function runReveal(r, mode, short) {
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
let shareCache = { key: null, blob: null };
const shareKey = (r, mode) => `${mode}:${r.figure.id}:${r.lv}`;
const loadImg = (src) => new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = ng; im.src = src; });
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
  const name = r.figure.name, fs = Math.min(110, Math.floor(900 / [...name].length));
  center(name, Y + S + 40 + fs, `900 ${fs}px "Noto Serif JP", serif`, "#26221d");
  const tl = typeLabel(r.type, mode);
  center(`${tl.name}｜${tl.catch}`, Y + S + 90 + fs + 20, '800 36px "M PLUS Rounded 1c", sans-serif', "#26221d");
  const line = `「${mainLine(r.figure.id, mode)}」`;
  const lf = Math.min(48, Math.floor(960 / [...line].length));
  center(line, Y + S + 170 + fs + 20, `900 ${lf}px "Noto Serif JP", serif`, "#26221d");
  if (r.figure.id === "washington") center("※ 斧と桜は後世の伝説イメージ", H - 170, '500 27px "M PLUS Rounded 1c", sans-serif', "#6b6358");
  if (r.figure.id === "natsume-soseki" && mode === "love") center("※ 漱石訳という出典は確認されていません", H - 170, '500 27px "M PLUS Rounded 1c", sans-serif', "#6b6358");
  center(`${"★".repeat(r.tier + 1)}${"☆".repeat(MAX_TIER - r.tier)}　Lv.${r.lv}`, H - 110, '800 36px "M PLUS Rounded 1c", sans-serif', "#b08a3e");
  center(`世界の偉人性格診断　${location.host}`, H - 44, '500 30px "M PLUS Rounded 1c", sans-serif', "#6b6358");
  return new Promise((ok) => c.toBlob(ok, "image/png"));
}
function prerenderShare(r, mode) {
  const key = shareKey(r, mode);
  shareCache = { key, blob: null };
  drawShare(r, mode).then((blob) => { if (shareCache.key === key) shareCache.blob = blob; }).catch(() => {});
}
async function shareImage(r, mode, trigger = null) {
  let blob;
  try {
    blob = shareCache.key === shareKey(r, mode) ? shareCache.blob : null;
    blob ||= await drawShare(r, mode);
    if (!blob) throw new Error("画像の生成に失敗しました");
  } catch { track("share_image_done", { method: "fail" }); return toast("画像を作れませんでした。スクショで保存してください"); }
  const src = URL.createObjectURL(blob);
  if (/Line\/|Instagram|FBAN|FBAV|Twitter|; wv\)/i.test(navigator.userAgent)) {
    // アプリ内ブラウザはダウンロードできないので、画像を出して長押しで保存してもらう
    openSheet(`<div class="panel"><h2 id="sheet-title">画像を長押しして保存</h2><img src="${src}" alt="保存用の結果画像" style="width:100%;border-radius:12px">
      <button class="btn sub close" style="margin-top:12px">閉じる</button></div>`, trigger, src);
    track("share_image_done", { method: "inapp" });
    return;
  }
  const a = document.createElement("a");
  a.href = src; a.download = `ijin-${r.figure.id}.png`; a.click();
  setTimeout(() => URL.revokeObjectURL(src), 60_000);
  track("share_image_done", { method: "download" });
  toast("画像を保存しました");
}


// ---------------- 図鑑 ----------------
function renderZukan() {
  document.title = "図鑑｜世界の偉人性格診断";
  const z = store.get("zukan", {});
  app.style.cssText = "";
  const zPct = Math.round((zukanCount() / Math.max(1, FREE.length)) * 100);
  app.innerHTML = `
    <div class="zhead"><h1>偉人図鑑</h1><span class="cnt">発見 <b>${zukanCount()}</b> / ${FREE.length}${LOCKED.length ? `（＋鍵つき ${LOCKED.length}）` : ""}</span></div>
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
  // 自分の結果：いま・前の結果・この端末で診断した過去の結果（seen_results から計算し直す）
  const mineHtml = MODES.map(([m, name]) => {
    const cur = store.get("me." + m), prev = store.get("me.prev." + m);
    const shown = new Set([ok(m, cur) ? cur.code : null, ok(m, prev) ? prev.code : null]);
    const hist = storedList(store.get("seen_results", [])).filter((x) => typeof x === "string" && x.startsWith(m)).map((x) => x.slice(m.length)).reverse()
      .filter((c) => !shown.has(c) && validCode(engines[m], c)).slice(0, 5)
      .map((c) => ({ code: c, fig: engines[m].diagnose(answersOf(engines[m], c)).figure.id }));
    if (!ok(m, cur) && !ok(m, prev) && !hist.length)
      return `<div class="me-empty">${name}：まだ結果がありません　<a href="#/q/${m}" data-fresh="${m}">診断する</a></div>`;
    return (ok(m, cur) ? row(m, cur, `いまの${name}の結果${cur.via === "link" ? "（リンクから保存）" : ""}`) : "")
      + (ok(m, prev) ? row(m, prev, `前の${name}の結果${prev.via === "link" ? "（リンクから保存）" : ""} ${date(prev.at)}`) : "")
      + hist.map((h) => row(m, h, `以前の${name}の結果`)).join("");
  }).join("");
  const friends = storedList(store.get("friends", [])).filter((x) => x && ok(x.mode, x));
  app.innerHTML = `
    <div class="zhead"><h1>この端末の記録</h1></div>
    ${accountCard()}
    ${zukanSummaryCard()}
    <section class="card"><h2>自分の診断結果</h2><p class="note" style="text-align:left;margin:0 0 10px">これまでの診断回数：${store.get("diagCount", 0)}回</p><div class="me-list">${mineHtml}</div></section>
    <section class="card"><h2>開いた共有リンクの結果</h2>
      ${friends.length ? `<div class="me-list">${friends.map((x) => row(x.mode, x, `${x.mode === "love" ? "恋愛" : "性格"}・${date(x.at)}に開いた結果${store.get("me." + x.mode)?.code === x.code ? "（自分と同じ回答）" : ""}`, relFace(x.fig), sharedResultViewPath(x.mode, x.code))).join("")}</div>
        <p class="note" style="text-align:left;margin:8px 0 0">開いた共有リンクの記録です。自分のリンクも含まれ、同じ回答コードは1件にまとまります。人の数ではありません（最大20件）。</p>`
        : `<p class="note" style="text-align:left;margin:0">まだありません。共有リンクを開くと、ここに結果が並びます。</p>`}</section>
    ${OTHER_PILOT ? `<section class="card"><h2>友達から見た自分 <span class="dev-badge">試作</span></h2>
      <p class="social-note">あなたについての返信リンクを、自分で保存した記録です。回答者の本人確認はできず、自分の結果も置き換えません。</p>
      <p>${otherReplies().length}件の返信をこの端末に保存中。回答した人の人数とは限りません。</p>
      <a class="btn sub" href="#/ask">招待リンクと返信を見る</a></section>` : ""}
    <section class="card"><h2>人物カード</h2><p>友達から届いた自己診断結果のカード：${peopleCards().length}枚</p>
      <a class="btn sub" href="#/people">人物カードを見る</a></section>
    <section class="card"><h2>設定</h2>
      <p class="note" style="text-align:left;margin:0">この記録は、この端末のこのブラウザの中だけに保存されています。機種変更、別のブラウザ、プライベートモード、ブラウザのデータ削除では消えることがあります。</p>
      <a class="btn sub" style="margin-top:12px" href="#/about">このサイトについて・記録を消す</a>
      </section>
    <a class="btn sub" href="#/how">このサイトの使い方</a>
    <a class="btn sub" href="#/">トップへ</a>`;
  app.querySelectorAll("[data-fresh]").forEach((a) => a.addEventListener("click", () => { store.del("progress." + a.dataset.fresh); quiz = null; }));
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
  app.querySelectorAll("[data-fresh]").forEach((a) => a.addEventListener("click", () => { store.del("progress." + a.dataset.fresh); quiz = null; }));
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
    <p>回答途中の記録、結果、図鑑、受け取った共有リンクの結果、人物カード${OTHER_PILOT ? "、試作中の招待リンクと他己回答" : ""}は、このブラウザ内に保存されます。別の端末には自動で引き継がれません。ブラウザのデータを消すと失われます。</p>
    <p>結果の共有リンクには、12問の回答から作られたコードが含まれ、リンクを知る人は答えを読み取れます。リンクを相手に送ると、受信者や共有先のサービスに結果とコードが伝わります。受信者がリンクを開くと、配信元のGitHub Pagesにもコード付きURLが届きます。画像を端末に保存するだけなら、このコードは送信されません。共有操作をしなければ、アプリから回答や結果を運営者へ送信しません。</p>
    ${OTHER_PILOT ? '<p>試作中の友達への招待と返信は、利用者がリンクをコピー・共有して行います。回答は自動送信されません。返信リンクの「#」以降には回答コードが含まれるため、送った相手や共有先サービスにはその情報が伝わります。リンクを知る人は12問の答えを開けます。名前はリンクに含めません。招待した人が別ブラウザーや別のサイトアドレスで返信を開いても、招待の記録とは自動でつながりません。</p>' : ""}
    <p>この版ではアクセス解析、広告、ログイン、クラウド保存、購入は行いません。ページの表示に必要なファイルはGitHub Pagesから読み込まれ、配信元には通常の閲覧ログが残る場合があります。Wikipediaなど外部サイトへのリンクは、押したときだけ開きます。</p>
    <p>他己用の質問と判定は試験段階で、公開版にはまだ出していません。回答者が別人かも確認できないため、複数の返信を「何人の評価」として扱いません。</p>
    <h2>これからの機能 <span class="dev-badge">※開発中</span></h2>
    <p>友達を招いてあなたについて答えてもらう他己診断、複数人の独立した回答を保証する総合結果、人物カード同士の組み合わせバッジは、公開版ではまだ使えません。LINEスタンプやグッズの販売導線も未公開です。</p>
    <h2>記録の削除</h2>
    <p>このブラウザーで、このサイトが保存した記録を消します。別のタブで開いている途中の答えは残る場合があります。ブラウザーの閲覧履歴や、すでに送った結果リンクは消えません。</p>
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
  clearButton.onclick = () => {
    clearPanel.hidden = false;
    clearButton.setAttribute("aria-expanded", "true");
    clearHeading.focus();
  };
  $("[data-cancel-clear]").onclick = () => {
    clearPanel.hidden = true;
    clearButton.setAttribute("aria-expanded", "false");
    clearButton.focus();
  };
  clearConfirm.onclick = () => {
    const localOk = clearPrefixedStorage(() => localStorage);
    const sessionOk = clearPrefixedStorage(() => sessionStorage);
    quiz = null;
    justFinished = null;
    otherQuiz = null;
    confirmedOtherToken = null;
    nextSrc = null;
    lastSharedInMemory.normal = null;
    lastSharedInMemory.love = null;
    if (!localOk || !sessionOk) {
      const status = $("[data-clear-status]");
      status.textContent = "保存記録をすべて消したとは確認できません。もう一度「保存記録を消す」を押すか、ブラウザーのサイトデータを削除してください。";
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
    <a class="btn start" href="#/q/normal">自分の診断を始める</a>
    <a class="btn sub" style="margin-top:10px" href="#/">トップへ</a></section>`;
  window.scrollTo(0, 0);
}

// ---------------- 友達から見た自分（端末内・手動で往復） ----------------
// 旧 #/invite は別仕様のため再利用しない。新しいURLは #/ask/<token> と #/reply/<token>/<code>。
function copyLink(url, okText = "リンクをコピーしました") {
  navigator.clipboard?.writeText(url).then(() => toast(okText)).catch(() => prompt("このリンクをコピーしてください", url));
  if (!navigator.clipboard?.writeText) prompt("このリンクをコピーしてください", url);
}
function shareLink(url, text) {
  if (navigator.share) {
    navigator.share({ title: "世界の偉人性格診断", text, url }).catch((e) => {
      if (e?.name !== "AbortError") copyLink(`${text}\n${url}`, "送る文章とリンクをコピーしました");
    });
  } else copyLink(`${text}\n${url}`, "送る文章とリンクをコピーしました");
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
  $("[data-share-reply]")?.addEventListener("click", () => shareLink(url, "あなたについて答えました。返信リンクを開いて、12問の回答を見てね。"));
  $("[data-copy-reply]")?.addEventListener("click", () => copyLink(url));
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
function renderPeople() {
  document.title = "人物カード｜世界の偉人性格診断";
  app.style.cssText = "";
  const cards = peopleCards();
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
      : varietyCount === 2 ? "あと1種類で3キャラ集合！" : "3種類のキャラが並びました。もっと増やしてみよう。";
  const varietySlots = Array.from({ length: 3 }, (_, i) => {
    const id = figureIds[i];
    return id ? `<div class="variety-slot"><img src="${avatar(id)}" alt=""><span>${esc(fig(id).name)}</span></div>`
      : '<div class="variety-slot empty" role="img" aria-label="空いている枠"><span aria-hidden="true">？</span></div>';
  }).join("");
  const ownNormal = savedResult("normal"), ownLove = savedResult("love");
  const ownShares = [["normal", ownNormal], ["love", ownLove]]
    .filter(([, result]) => result && result.via !== "link")
    .map(([mode, result]) => ({ mode, code: result.code }));
  app.innerHTML = `<div class="zhead"><h1>人物カード</h1><span class="cnt">${cards.length}枚</span></div>
    <section class="social-entry"><div class="social-badge">人が増えるコレクション</div>
      <h2>友達の偉人を集めよう</h2><p>① あなたの結果を送る。<br>② 友達が自分自身を診断し、結果リンクを返す。<br>③ 届いたリンクで「人物カードに追加する」を押す。</p>
      <p class="social-note">ここで集めるのは、友達から届いた自己診断結果です。リンクの持ち主は確認できません。友達があなたについて答える「他己分析」とは別です。図鑑の「発見」とも別です。</p>
      ${ownShares.length ? `<p class="social-note">送るリンクを知る人は、あなたの12問の答えを読み取れます。友達はそのリンクから自分自身を診断できます。他己分析は ※開発中。</p>
        ${ownShares.map(({ mode }, i) => { const label = mode === "love" ? "恋愛版" : "性格版"; return `
          <button class="btn ${i === 0 ? "start" : "sub"}" data-invite-self="${mode}">${label}の結果を友達に送る</button>
          <button class="btn sub" data-copy-self="${mode}">${label}の結果リンクをコピー</button>`; }).join("")}`
        : '<a class="btn start" href="#/q/normal">まず自分を診断する</a>'}</section>
    <section class="social-entry variety-entry" aria-labelledby="variety-title"><div class="social-badge">${varietyCount < 3 ? `${varietyCount}/3種類` : `${varietyCount}種類`}</div>
      <h2 id="variety-title">キャラの顔ぶれ</h2><p>${varietyMessage}</p>
      <div class="variety-slots">${varietySlots}</div>
      ${varietyCount > 3 ? `<p class="variety-extra">ほか${varietyCount - 3}種類のキャラも下のカード一覧にいます。</p>` : ""}
      ${verifiedCards.length < cards.length ? '<p class="variety-extra">結果を確認できないカードは、キャラの種類に数えていません。</p>' : ""}
      ${heroes.found.length ? `<div class="theme-set"><strong>三英傑のキャラ <span>${heroes.found.length}/3</span></strong>
        <p>${heroes.missing.length ? `あと${heroes.missing.length}キャラで、信長・秀吉・家康の3種類。` : "信長・秀吉・家康の3種類がそろいました！"}</p>
        <div class="theme-set-names">${THREE_HEROES.map((id) => `<span class="${heroes.found.includes(id) ? "found" : ""}">${esc(fig(id).name)}</span>`).join("")}</div></div>` : ""}
      <p class="variety-note">この端末に保存した結果のキャラの種類です。人の数や本人確認を示すものではありません。</p></section>
    ${cards.length ? `<div class="social-list">${cards.map((x, i) => { const verified = isVerifiedCard(x);
      const actionName = x.label || (verified ? fig(x.fig).name : `友達カード ${i + 1}`);
      return `<section class="social-card">
      ${verified ? `<img class="tile" src="${avatar(x.fig)}" alt="">` : '<div class="person-broken-icon" aria-hidden="true">？</div>'}
      <div class="person-card-info"><b>${esc(x.label || `友達カード ${i + 1}`)}</b>${verified
        ? `<div class="nm">${esc(fig(x.fig).name)}</div><small>「${esc(mainLine(x.fig, x.mode))}」</small><small>${x.mode === "love" ? "恋愛版" : "性格版"}の共有結果</small>`
        : '<small>保存データの回答とキャラが一致しません。このカードの結果は開けません。</small>'}</div>
      ${verified ? `<a href="#/person/${encodeURIComponent(x.id)}" aria-label="${esc(actionName)}・${i + 1}枚目の結果を見る">見る</a>` : '<span class="person-unavailable">確認不可</span>'}
      <button type="button" data-label-person="${i}" data-person-id="${esc(x.id)}" aria-label="${esc(actionName)}・${i + 1}枚目の呼び名を変更">呼び名</button>
      <button type="button" data-remove-person="${i}" data-person-id="${esc(x.id)}" aria-label="${esc(actionName)}・${i + 1}枚目を削除">削除</button>
    </section>`; }).join("")}</div>` : '<section class="card"><p>カードはまだありません。友達から自己診断の結果リンクが届いたら、そのページで追加できます。</p></section>'}
    <p class="social-note">カードはこの端末に最大50枚保存。同じ回答の友達も別カードにできます。リンクの持ち主は確認できません。図鑑の「発見」数は増えません。</p>
    ${OTHER_PILOT ? '<a class="btn sub" href="#/ask">友達から見た自分を聞く（試作）</a>' : '<p class="social-note">他己分析（友達があなたについて答える機能）は ※開発中</p>'}<a class="btn sub" href="#/me">この端末の記録</a><a class="btn sub" href="#/">トップへ</a>`;
  ownShares.forEach(({ mode, code }) => {
    const result = engines[mode].diagnose(answersOf(engines[mode], code));
    const url = shareUrl(mode, result.figure.id, code);
    const label = mode === "love" ? "恋愛版" : "性格版";
    $(`[data-invite-self="${mode}"]`)?.addEventListener("click", () => shareLink(url, `${label}では私は${result.figure.name}タイプだった！ あなたも12問で診断して、結果リンクを送り返してね。`));
    $(`[data-copy-self="${mode}"]`)?.addEventListener("click", () => copyLink(url, `${label}の結果リンクをコピーしました`));
  });
  app.querySelectorAll("[data-remove-person]").forEach((b) => b.onclick = () => {
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
    if (!confirm(personDeleteConfirmMessage(current, i, isVerifiedCard(current) ? fig(current.fig).name : ""))) return;
    const latest = store.get("people.cards", []);
    if (!Array.isArray(latest) || JSON.stringify(latest) !== beforeConfirm) return refreshChanged();
    latest.splice(index, 1);
    if (!store.set("people.cards", latest)) return toast("この端末からカードを削除できませんでした");
    renderPeople();
    focusPageHeading();
  });
  app.querySelectorAll("[data-label-person]").forEach((b) => b.onclick = () => {
    const refreshChanged = () => {
      closeSheet(false);
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
    openSheet(`<div class="panel"><h2 id="sheet-title">カードの呼び名</h2>
      <p>自分だけに分かる短い呼び名を付けられます。本名や連絡先は入れないでください。この端末にだけ保存され、結果リンクには入りません。</p>
      <label for="person-label">呼び名（20文字以内）</label>
      <input class="social-input" id="person-label" type="text" maxlength="20" value="${esc(current.label || "")}" placeholder="例：友達A">
      <button class="btn start" data-save-person-label>保存する</button>
      <button class="btn sub close" type="button">閉じる</button></div>`, b);
    $("[data-save-person-label]", sheet).onclick = () => {
      const label = $("#person-label", sheet).value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 20);
      const latest = store.get("people.cards", []);
      if (!Array.isArray(latest) || JSON.stringify(latest) !== beforeEdit) return refreshChanged();
      latest[index] = { ...latest[index], label };
      if (!store.set("people.cards", latest)) return toast("呼び名を保存できませんでした");
      closeSheet(false);
      renderPeople();
      app.querySelector(`[data-label-person="${i}"]`)?.focus();
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
      ${id === "natsume-soseki" && mode === "love" ? '<p class="note">※「月が綺麗ですね」を漱石が訳したという出典は確認されていません</p>' : ""}
      <h1 class="fig-name" style="--len:${[...f.name].length}">${esc(f.name)}</h1>
      <div class="type-line"><span class="emblem">${esc(t.name[0])}</span><span class="type-name">${esc(tl.name)}</span></div>
      <p class="serif-quote">${esc(mainLine(id, mode))}</p>
    </section>
    <div style="display:grid;gap:8px;margin:16px 0">
      <a class="btn start" data-fresh="${mode}" href="#/q/${mode}">あなたは誰？ 12問で診断する</a></div>
    <details class="card"><summary>${esc(f.name)}タイプってどんな人？</summary><p class="body">${esc(tx.body)}</p></details>`;
  app.querySelectorAll("[data-fresh]").forEach((a) => a.addEventListener("click", () => { store.del("progress." + mode); quiz = null; }));
  attachMotion(f.name);
  window.scrollTo(0, 0);
}

// ---------------- ルーティング ----------------
let visitSent = false;
app.addEventListener("click", (e) => { const el = e.target.closest("[data-src]"); if (el) nextSrc = el.dataset.src; }, true);
function route() {
  disposeGuide();
  disposeGuide = () => {};
  disposeMotion();
  disposeMotion = () => {};
  clearTimers();
  { const [, pg, md, cd] = location.hash.split("/");
    currentMode = (pg === "q" || pg === "r" || pg === "f") && engines[md] ? md : "none";
    if (!visitSent) {
      visitSent = true;
      const entry = pg === "r" ? (store.get("me." + md)?.code === cd ? "own_result" : "shared_link")
        : pg === "f" ? "shared_link" : pg === "q" ? "quiz" : pg === "zukan" ? "zukan" : "top";
      track("visit", { entry, returning: RETURNING ? "yes" : "no" });
    } }
  overlay.hidden = true; app.inert = false; closeSheet(false);
  app.style.cssText = "";
  const [, page, mode, code] = location.hash.split("/");
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
    && after.searchParams.get("shared") === "1")
    history.replaceState(history.state, "", withoutSharedResultParam(after.href));
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
route();
store.set("visited", true);
// ローカル版では Firebase Auth に接続しない。

// 画面：トップ（#/）→ 質問（#/q/<mode>）→ 結果（#/r/<mode>/<回答>）／ 図鑑（#/zukan）
// 結果のURLには回答（1〜5の数字の列）が入るので、そのままシェアできる。
// 設計の根拠：docs/ui-redesign.md（デザイナー）、docs/game-design-review.md の P0（ゲーム開発者）
import { AXES, Shindan, loadData } from "./shindan.js?v=9922290";
import { mountMotion } from "./motion.js?v=3";
import { mountGuide } from "./guide.js?v=2";

const $ = (s, el = document) => el.querySelector(s);
const app = $("#app"), overlay = $("#overlay"), sheet = $("#sheet");
const getJSON = (u) => fetch(u).then((r) => r.json());
let data, meta, rarity;
try {
  [data, meta, rarity] = await Promise.all([loadData(), getJSON("meta.json?v=9922290"), getJSON("../data/rarity.json?v=9922290")]);
} catch (e) {
  app.insertAdjacentHTML("beforeend", `<p class="note" style="margin-top:20px">読みこみに失敗しました。通信状況を確かめて、ページを再読みこみしてください。</p>`);
  throw e;
}
window.__ijinReady = true;
const engines = { normal: new Shindan(data, "free", "normal"), love: new Shindan(data, "free", "love") };
const SD = engines.normal;
const texts = data.texts.figures;
const axisById = Object.fromEntries(data.axes.axes.map((a) => [a.id, a]));
const THEMES = meta.themes;
const MAX_TIER = SD.plan.max_tier;
const FREE = Object.values(SD.figures).filter((f) => f.tier <= MAX_TIER);
const LOCKED = Object.values(SD.figures).filter((f) => f.tier > MAX_TIER);
const OTHER = { normal: "love", love: "normal" };

// ---------------- 小道具 ----------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem("ijin." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ijin." + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("ijin." + k); } catch {} },
};
// 計測：解析ツール（Plausible / GA4）が入っていれば送る。回答の数字の列は送らない
// 計測（Umami）。イベントの定義は docs/metrics-plan.md。回答の数字の列は送らない
// 予定価格の群は、初めて来たときに決める（課金テストの比較用）
if (!store.get("price")) store.set("price", [300, 480, 680][Math.floor(Math.random() * 3)]);
// ?notrack=1 で開くと、この端末からの計測を止める（自分たちのアクセスを数えない）
if (new URLSearchParams(location.search).get("notrack") === "1") { try { localStorage.setItem("umami.disabled", "1"); } catch {} }
const RETURNING = !!store.get("visited");
let currentMode = "none", nextSrc = null;
const ctaSeen = new Set();
const pending = [];
function track(name, props = {}) {
  // Umami は付けた値1つごとにもイベントとして数えるので、共通の値は3つに絞る（returning は visit だけ）
  const p = { price: String(store.get("price") ?? "none"), mode: currentMode, via: store.get("friends", []).length ? "friend" : "direct", ...props };
  for (const k in p) p[k] = String(p[k]);
  if (window.umami?.track) { try { window.umami.track(name, p); } catch {} return; }
  // Umami の読みこみ前に呼ばれたら、ためておいて後で送る（最大10秒待つ）
  pending.push([name, p]);
  if (pending.length === 1) {
    let n = 0;
    const iv = setInterval(() => {
      if (window.umami?.track) { pending.splice(0).forEach(([a, b]) => { try { window.umami.track(a, b); } catch {} }); clearInterval(iv); }
      else if (++n > 50) { pending.length = 0; clearInterval(iv); }
    }, 200);
  }
}
function trackCta(place) { if (!ctaSeen.has(place)) { ctaSeen.add(place); track("premium_cta_view", { place }); } }
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
const rare = (id, mode) => rarity[mode]?.[id];
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = msg; document.body.append(el);
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

// 図鑑：{figureId: {src: "me|match|next|friend", at}}
function meet(id, src) {
  if (!id || !isFree(id)) return;
  const z = store.get("zukan", {});
  if (!z[id] || src === "me") z[id] = { src: z[id]?.src === "me" ? "me" : src, at: Date.now() };
  store.set("zukan", z);
}
// 図鑑の状態（保存形式は変えない。src の意味で3段階に読み分ける）
//   DISCOVERED：自分の正式な診断結果（通常・恋愛）＝ src "me"。全身画像・説明・動きを見せる
//   KNOWN     ：相性・もしも・共有結果などで名前だけ知った ＝ src "match" | "next" | "friend"。名前＋シルエット＋🔒未発見
//   UNKNOWN   ：まだ記録がない。？？？＋シルエット
const zState = (id) => { const e = store.get("zukan", {})[id]; return !e ? "unknown" : e.src === "me" ? "discovered" : "known"; };
const isDiscovered = (id) => zState(id) === "discovered";
const zukanCount = () => Object.entries(store.get("zukan", {})).filter(([id, e]) => e.src === "me" && SD.figures[id] && isFree(id)).length;
const knownCount = () => Object.entries(store.get("zukan", {})).filter(([id, e]) => e.src !== "me" && SD.figures[id] && isFree(id)).length;
// 関連表示（相性・もしも・友達）の顔：発見済みだけ通常の絵、それ以外はシルエット＋「🔒 未発見」
const relFace = (id) => avatar(id, !isDiscovered(id));
const undiscTag = (id) => (isDiscovered(id) ? "" : `<span class="undisc">🔒 未発見</span>`);

// ---------------- トップ ----------------
let firstTop = true;
function renderTop() {
  document.title = "世界の偉人性格診断";
  const staticParade = firstTop ? $(".parade")?.innerHTML : null;
  firstTop = false;
  const me = { normal: store.get("me.normal"), love: store.get("me.love") };
  const prog = ["normal", "love"].map((m) => [m, store.get("progress." + m)])
    .find(([, p]) => p && Date.now() - p.t < 864e5 && p.answers.length > 0);
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
          <div><div class="lbl">前回の${m === "love" ? "恋の" : ""}あなた${me[m].via === "link" ? "（リンクから保存）" : ""}</div><div class="nm">${esc(fig(me[m].fig).name)}</div></div>
        </a>`).join("")}
      <a class="btn sub" href="#/zukan">図鑑を見る（${zukanCount()} / ${FREE.length}）</a>
      <a class="btn sub" href="#/me">マイページ（自分の結果・受け取った結果）</a>
    </div>` : "";
  app.innerHTML = `
    <section class="hero">
      <div class="seal">偉</div>
      <div id="guide"></div>
      <h1>${FREE.length}人の偉人のうち、<br>あなたは誰？</h1>
      <p class="sub">12問・約1分半・登録なし</p>
    </section>
    <div class="cta">
      ${prog ? `<a class="btn start" data-src="resume" href="#/q/${prog[0]}">${prog[0] === "love" ? "恋愛診断の" : "性格診断の"}続きから（${prog[1].answers.length} / 12）</a>` : ""}
      <a class="btn ${prog ? "sub" : "start"}" data-fresh="normal" data-src="top" href="#/q/normal">${prog ? "最初から診断する" : "診断スタート"}</a>
      <a class="btn love-sub" data-fresh="love" data-src="top" href="#/q/love">💘 恋愛バージョンもある</a>
    </div>
    ${againCard}
    <div class="teaser" aria-live="polite"></div>
    <div class="type-strip" aria-hidden="true">${SD.types.map((t) => `<i style="background:${THEMES[t.id].bg2}"></i>`).join("")}</div>
    <p class="note">${LOCKED.length ? `無料で出会えるのは${FREE.length}人。ほか${LOCKED.length}人はシルエットで待機中。` : `${FREE.length}人すべてに、無料で出会えます。`}<br>逸話には伝承や諸説あるものを含みます。</p>
    <p class="note"><a href="#/me">マイページ</a>　・　<a href="#/about">このサイトについて</a></p>`;
  app.querySelectorAll("[data-fresh]").forEach((a) => (a.onclick = () => { store.del("progress." + a.dataset.fresh); quiz = null; }));
  disposeGuide = mountGuide($("#guide"));
  window.scrollTo(0, 0);
  // 決め台詞がいちばんの宣伝文句。2.5秒ごとに切り替える
  const teaser = $(".teaser");
  const pool = pick(FREE, 12);
  let k = 0;
  const show = () => {
    const f = pool[k++ % pool.length];
    teaser.classList.remove("fade"); void teaser.offsetWidth; teaser.classList.add("fade");
    teaser.innerHTML = `<img class="tile" src="${avatar(f.id)}" alt="" style="${themeVars(f.type)}">
      <div><div class="who">${esc(f.name)}タイプの人は</div><div class="line">「${esc(texts[f.id].serif)}」</div></div>`;
    later(2500, show);
  };
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
    if (saved && Date.now() - saved.t < 864e5) { quiz.answers = saved.answers; quiz.i = Math.min(saved.answers.length, qs.length - 1); }
    const resumed = saved && saved.answers?.length && quiz.i > 0;
    quiz.source = resumed ? saved.source ?? "resume" : nextSrc ?? "top";
    nextSrc = null;
    if (!resumed) track("quiz_start", { mode, source: quiz.source });
  }
  const { qs, answers, i } = quiz;
  const q = qs[i];
  document.title = `質問 ${i + 1}｜${sd.modeConf.name}`;
  const intro = mode === "love" && i === 0 ? `<div class="intro">${esc(data.questions_love.intro)}</div>` : "";
  app.innerHTML = `
    <div class="qhead">
      <button class="back" ${i === 0 ? "disabled" : ""}>← 戻る</button>
      <span class="count"><b>${i + 1}</b> / ${qs.length}</span>
      <span class="mystery" style="--p:${(i / qs.length) * 100}%" aria-hidden="true">?</span>
    </div>
    <div class="segs">${qs.map((_, k) => `<i class="${k < i ? "done" : k === i ? "now" : ""} ${[3, 7, 11].includes(k) ? "chest" : ""}"></i>`).join("")}</div>
    <div class="qbox ${anim ? "in" : ""}">
      ${intro}
      <p class="qtext">${esc(q.text)}</p>
      <div class="scale5" role="radiogroup" aria-label="あてはまる度合い">
        ${[1, 2, 3, 4, 5].map((v) => `<button class="dotbtn v${v} ${answers[i] === v ? "sel" : ""}" data-v="${v}" role="radio" aria-checked="${answers[i] === v}" aria-label="${esc(sd.data.questions.scale[v - 1])}"><i></i></button>`).join("")}
      </div>
      <div class="scale-lbl"><span class="no">当てはまらない</span><span class="yes">当てはまる</span></div>
    </div>`;
  $(".back").onclick = () => { quiz.i--; renderQuiz(mode, true); };
  app.querySelectorAll(".dotbtn").forEach((b) => (b.onclick = () => {
    if (quiz.busy) return;
    quiz.busy = true;
    quiz.answers[i] = Number(b.dataset.v);
    quiz.answers.length = Math.max(quiz.answers.length, i + 1);
    b.classList.add("sel");
    navigator.vibrate?.(8);
    store.set("progress." + mode, { answers: quiz.answers.slice(0, i + 1).concat(quiz.answers.slice(i + 1)), t: Date.now(), source: quiz.source });
    setTimeout(() => $(".qbox")?.classList.add("out"), 120);
    setTimeout(() => {
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
    body = `<h2>系統がしぼれてきた…</h2>
      <div class="emblems">${sd.types.filter((t) => t.unit).map((t) =>
        `<span class="emb ${hot.has(t.id) ? "hot" : ""}" style="background:${THEMES[t.id].accent}">${esc(t.name[0])}</span>`).join("")}</div>`;
  } else {
    const three = ranked.slice(0, 3);
    body = `<h2>この3つの系統のどれかに近い</h2>
      <div class="sils">${three.map((t) => `<div><img class="tile" src="${avatar(t.figures[0].id, true)}" alt="" style="${themeVars(t.id)}">
        <div class="note" style="margin-top:4px">${esc(typeLabel(t, mode).name)}</div></div>`).join("")}</div>`;
  }
  app.innerHTML = `<div class="checkpoint">${body}<p class="tap">タップで次へ（あと${quiz.qs.length - n}問）</p></div>`;
  const go = () => { clearTimers(); if (n === 8) store.set("seen_checkpoint", true); renderQuiz(mode, true); };
  app.firstElementChild.onclick = go;
  later(2600, go);
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
  return `<svg class="radar" viewBox="0 0 300 290" role="img" aria-label="6つの軸のスコア">
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
  if (Math.abs(v) < 0.05) return relRow({ label: `${label}：互角`, me: meId, other: otherId, dir: "both", verb: "互角", cls: "even", why: "似た者どうし。張り合うと長引く組み合わせ", otherWho, otherFace });
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
  const f = r.figure, t = r.type, tl = typeLabel(t, mode), pct = rare(f.id, mode);
  const lead = who === "friend" ? "この人自身の回答から見える姿" : who === "past" ? "以前のあなたの回答から見える姿" : who === "saved" ? "リンクから保存した、この端末の「自分の結果」" : (mode === "love" ? "恋愛についての回答から見えるあなた" : "あなた自身の回答から見えるあなた");
  return `
  <section class="rcard ${reveal ? "reveal-wait" : ""}" style="${themeVars(t.id)}">
    <p class="anata">${lead}</p>
    <div class="stage" data-state="${reveal ? "sil" : "done"}">
      <img class="avatar sil" src="${avatar(f.id, true)}" alt="">
      <img class="avatar color" src="${avatar(f.id)}" alt="${esc(f.name)}のイラスト（${esc(meta.alt[f.id] ?? "")}）">
      <div class="burst" aria-hidden="true">${"<i></i>".repeat(8)}</div>
    </div>
    <h1 class="fig-name" style="--len:${[...f.name].length}">${esc(f.name).replace(/・/g, "・<wbr>")}</h1>
    <div class="type-line"><span class="emblem">${esc(t.name[0])}</span><span class="type-name">${esc(tl.name)}</span></div>
    <p class="type-catch">${esc(tl.catch)}</p>
    <p class="serif-quote">${esc(mainLine(f.id, mode))}</p>
    <div class="meta-row">${stars(r.tier)}<span class="lv ${r.capped ? "capped" : ""}">Lv.<b>${reveal ? 1 : r.lv}</b></span>
      ${pct != null ? `<span class="rare">全体の${pct}%（推定）</span>` : ""}</div>
    <div class="brand"><i>偉</i>世界の偉人性格診断　${esc(location.host)}</div>
  </section>`;
}

function shareUrl(mode, id, code) {
  // SNS のカード画像を偉人ごとに出すため、静的ページ s/<mode>/<id>.html を経由させる
  // 形は固定：s/<mode>/<id>.html?c=<版>.<回答>。公開後は変えない（README 参照）
  return new URL(`s/${mode}/${id}.html?c=${encodeURIComponent(code)}`, location.href.split("#")[0]).href;
}
function shareText(r, mode, fate) {
  const f = r.figure, pct = rare(f.id, mode);
  return `${mode === "love" ? "恋をした私は" : "私は"}「${f.name}」タイプだった${pct != null ? `（全体の${pct}%・推定）` : ""}\n「${mainLine(f.id, mode)}」\n`
    + (fate ? `因縁の相手：${fig(fate.other).name}（${fate.label}）\n` : "")
    + `あなたはどの偉人？ 12問でわかる👇\n#${engines[mode].modeConf.name}`;
}

function fateOf(id) {
  const o = data.rules.battle.overrides.find((x) => x.winner === id || x.loser === id);
  return o ? { ...o, win: o.winner === id, other: o.winner === id ? o.loser : o.winner } : null;
}

function renderResult(mode, code) {
  const sd = engines[mode];
  if (!validCode(sd, code)) { renderTop(); return toast("このリンクは開けませんでした。新しく診断してみてください"); }
  const r = sd.diagnose(answersOf(sd, code));
  const f = r.figure;
  const mine = store.get("me." + mode);
  const fresh = justFinished && justFinished.mode === mode && justFinished.code === code;
  const freshSource = fresh ? justFinished.source : null;
  justFinished = null;
  const who = fresh || mine?.code === code ? "me" : "friend";
  const seen = store.get("seen_results", []);
  const reveal = fresh;
  const shortReveal = fresh && seen.includes(mode + code);
  document.title = `${f.name}タイプ｜${sd.modeConf.name}`;
  if (fresh) track("quiz_complete", { mode, source: freshSource, figure: f.id, type: r.type.id, tier: r.tier + 1, capped: r.capped ? "yes" : "no" });

  if (who === "friend") return renderFriend(sd, mode, code, r);

  // 自分の結果として記録する
  if (fresh) {
    if (mine && mine.code !== code) store.set("me.prev." + mode, mine);
    store.set("me." + mode, { code, fig: f.id, at: Date.now() });
    store.set("seen_results", [...new Set([...seen, mode + code])].slice(-30));
  }
  // 図鑑：自分でこの端末で診断した結果だけ DISCOVERED。リンクから保存した結果（via:"link"）は KNOWN のまま
  meet(f.id, !fresh && mine?.via === "link" ? "friend" : "me");
  const fate = fateOf(f.id);
  const ms = r.matchups;
  const strongId = ms.strong.find((id) => id !== fate?.other), weakId = ms.weak.find((id) => id !== fate?.other);
  [strongId, weakId, fate?.other].forEach((id) => meet(id, "match"));
  if (r.levelup && !r.levelup.locked) meet(r.levelup.to, "next");
  const friend = store.get("lastFriend." + mode);
  const other = store.get("me." + OTHER[mode]);

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
  if (friend && friend.code !== code && validCode(sd, friend.code)) {
    const fu = sd.score(answersOf(sd, friend.code));
    friendHtml = duelRow(sd, r.u, fu, f.id, friend.fig, { label: "リンクをくれた友達", otherWho: "友達" });
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
         <button class="btn gold" style="margin-top:12px" data-premium="levelup">🔒 この人の正体は本格診断で（準備中）</button>`
      : `<div class="next"><div class="next-tile" style="--t-bg:${THEMES[nf.type].bg}"><img src="${relFace(h.to)}" alt=""></div>
           <div><div class="hint">あなたは</div><div class="qq">${esc(nf.name)}</div><div class="hint">になっていた${undiscTag(h.to)}</div></div></div>`);
  }
  const sc = r.scores, hi = AXES.reduce((a, b) => (sc[b] > sc[a] ? b : a)), lo = AXES.reduce((a, b) => (sc[b] < sc[a] ? b : a));
  const otherHtml = other && validCode(engines[OTHER[mode]], other.code) ? (() => {
    const [n, l] = mode === "normal" ? [f.id, other.fig] : [other.fig, f.id];
    return `<section class="card"><h2>表の顔 × 恋の顔</h2>
      <div class="duo"><div><img class="tile" src="${avatar(n)}" alt="" style="${themeVars(fig(n).type)}"><div class="lbl">ふだんは</div><div class="nm">${esc(fig(n).name)}</div></div>
        <div class="x">×</div>
        <div><img class="tile" src="${avatar(l)}" alt="" style="${themeVars(fig(l).type)}"><div class="lbl">恋をすると</div><div class="nm">${esc(fig(l).name)}</div></div></div>
      <button class="btn sub" style="margin-top:12px" data-duo="${n},${l}">このギャップをシェア</button></section>`;
  })() : `<section class="card"><h2>${mode === "normal" ? "恋愛バージョン" : "性格バージョン"}</h2>
      <p style="margin:0 0 12px">${mode === "normal" ? "恋をしたら、あなたは別の偉人かも？" : "ふだんのあなたは、どの偉人？"}（約1分半）</p>
      <a class="btn ${mode === "normal" ? "love-sub" : "sub"}" data-fresh="${OTHER[mode]}" data-src="other_mode" href="#/q/${OTHER[mode]}">${mode === "normal" ? "💘 恋愛診断をやる" : "性格診断をやる"}</a></section>`;
  const lockedTwo = r.type.figures.slice(MAX_TIER + 1).map((x) => x.id);

  app.style.cssText = themeVars(r.type.id);
  app.innerHTML = `
    ${resultCard(r, mode, !fresh && mine?.via === "link" ? "saved" : "me", reveal)}
    <div class="share-row after ${reveal ? "reveal-hide" : ""}">
      <button class="btn primary wide" data-share="image">画像で保存・シェア</button>
      <a class="btn sub" data-share="line" target="_blank" rel="noopener">LINEで送る</a>
      <a class="btn sub" data-share="x" target="_blank" rel="noopener">Xでポスト</a>
      <button class="btn sub wide" data-share="copy">リンクをコピー</button>
    </div>
    ${(() => { const prev = store.get("me.prev." + mode); return prev && prev.code !== code && validCode(sd, prev.code) && SD.figures[prev.fig]
      ? `<p class="note prev-link">前の結果：<a href="#/r/${mode}/${prev.code}">${esc(fig(prev.fig).name)}（見る・戻す）</a></p>` : ""; })()}
    <section class="card"><h2>あなたはこんな人</h2>
      ${mode === "love" && tx.love.note ? `<p class="love-note">※${esc(tx.love.note)}</p>` : ""}
      <p class="body">${esc(tx.body)}</p>
      <details><summary>元ネタを見る</summary><p>${esc(tx.motoneta.text)}</p>
        <div class="chips">${tx.motoneta.search.map((s) => `<a class="chip" href="${search(s)}" target="_blank" rel="noopener">🔍 ${esc(s)}</a>`).join("")}</div></details>
    </section>
    <section class="card"><h2>相性</h2>
      <p class="rel-note">性格タイプの組み合わせで見た相性です（史実の勝ち負けではありません）。矢印の先が、押されやすい側。</p>
      <div class="rels">${friendHtml}${matchRow("strong", strongId)}${matchRow("weak", weakId)}</div>
      ${fateHtml ? `<div class="fate-wrap">${fateHtml}</div>` : ""}
    </section>
    <section class="card levelup"><h2>もしも…</h2>${levelHtml}</section>
    <section class="card"><h2>あなたの6つの軸</h2>${radar(sc)}
      <div class="tags"><span class="tag good">武器：${esc(pole(hi, 1))}</span><span class="tag weak">控えめ：${esc(axisById[lo].name)}</span></div></section>
    ${otherHtml}
    <section class="card"><h2>図鑑</h2>
      <div class="progress-line"><span><b>${zukanCount()}</b> / ${FREE.length}人を発見</span><div class="bar"><i style="width:${(zukanCount() / FREE.length) * 100}%"></i></div></div>
      <a class="btn sub" style="margin-top:12px" href="#/zukan">図鑑を見る</a></section>
    <section class="card premium" data-view="premium_cta_view"><h2>本格診断でわかること（準備中）</h2>
      ${lockedTwo.length ? `<div class="locks">${lockedTwo.map((id) => `<img class="tile" src="${avatar(id, true)}" alt="鍵つきの偉人" style="${themeVars(r.type.id)}">`).join("")}</div>` : ""}
      <ul><li>30問で、もっとくわしく</li><li>あなたの偉人スペクトラム（上位3人の割合）</li><li>100人全員との相性</li><li>あなたの第2の系統</li></ul>
      <button class="btn gold" data-premium="result">くわしく見る</button></section>
    <div style="display:grid;gap:10px;margin-top:20px">
      <a class="btn sub" data-fresh="${mode}" data-src="retry" href="#/q/${mode}">もう一度診断する</a>
      <a class="btn sub" href="#/me">マイページ</a>
      <a class="btn sub" href="#/">トップへ</a></div>
    <p class="note" style="margin-top:16px"><a href="#/about">このサイトについて</a></p>
    <button class="fab" data-share="image" hidden>シェア</button>`;

  // シェア
  const url = shareUrl(mode, f.id, code), text = shareText(r, mode, fate);
  $('[data-share="x"]').href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  $('[data-share="line"]').href = `https://line.me/R/share?text=${encodeURIComponent(`${f.name}タイプだった😂 あなたは誰？ ${url}`)}`;
  app.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", async (e) => {
    const ch = b.dataset.share;
    track("share_click", { channel: ch, mode, figure: f.id });
    if (ch === "copy") { e.preventDefault(); try { await navigator.clipboard.writeText(url); toast("リンクをコピーしました"); } catch { prompt("このリンクをコピーしてください", url); } }
    if (ch === "image") { e.preventDefault(); shareImage(r, mode, text, url); }
  }));
  app.querySelectorAll("[data-premium]").forEach((b) => (b.onclick = () => openPremium(b.dataset.premium)));
  app.querySelectorAll("[data-fresh]").forEach((a) => a.addEventListener("click", () => { store.del("progress." + a.dataset.fresh); quiz = null; }));
  $("[data-duo]")?.addEventListener("click", () => {
    const [n, l] = $("[data-duo]").dataset.duo.split(",");
    track("share_click", { channel: "duo", figure: f.id });
    const t = `ふだんの私は「${fig(n).name}」、恋をすると「${fig(l).name}」でした。\nあなたの表の顔と恋の顔は？👇\n#偉人性格診断`;
    open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}&url=${encodeURIComponent(url)}`, "_blank");
  });
  // スクロールしても消えないシェアボタン
  const fab = $(".fab"), row = $(".share-row");
  new IntersectionObserver(([e]) => (fab.hidden = e.isIntersecting || e.boundingClientRect.top > 0)).observe(row);
  prerenderShare(r, mode);
  [[$('[data-view="premium_cta_view"]'), "result"], [$('[data-premium="levelup"]'), "levelup"]].forEach(([el, place]) => {
    if (el) new IntersectionObserver(([e], ob) => { if (e.isIntersecting) { trackCta(place); ob.disconnect(); } }).observe(el);
  });
  window.scrollTo(0, 0);
  if (reveal) runReveal(r, mode, shortReveal);
  else later(0, () => { $(".stage").dataset.state = "done"; });
  if (fresh) later(reveal ? 5600 : 0, () => toast(`図鑑に登録しました（${zukanCount()} / ${FREE.length}）`));
  attachMotion(f.name);
}

// 友達の結果（シェアされたリンクを開いた人）
function renderFriend(sd, mode, code, r) {
  const f = r.figure;
  const own = store.get("seen_results", []).includes(mode + code);  // この端末で自分で診断したことがある結果
  const prevE = store.get("me.prev." + mode);
  const prevHere = prevE?.code === code;                                // 入れかえ前の結果
  const prevLink = !own && prevHere && prevE.via === "link";            // 入れかえ前の結果が、リンクから保存したもの
  const past = own || (prevHere && !prevLink);                         // 以前のあなた自身の結果
  if (!past) {
    const friends = store.get("friends", []);
    if (!friends.some((x) => x.mode === mode && x.code === code))
      store.set("friends", [{ mode, code, fig: f.id, at: Date.now() }, ...friends].slice(0, 20));
    store.set("lastFriend." + mode, { code, fig: f.id });
    meet(f.id, "friend");
  }
  const tx = texts[f.id];
  app.style.cssText = themeVars(r.type.id);
  const mine = store.get("me." + mode);
  let compat = "";
  if (!past && mine && validCode(sd, mine.code)) {
    const mu = sd.score(answersOf(sd, mine.code));
    compat = `<section class="card"><h2>あなたとの相性</h2>
      <p class="rel-note">性格タイプの組み合わせで見た相性です（史実の勝ち負けではありません）。矢印の先が、押されやすい側。</p>
      <div class="rels">${duelRow(sd, mu, r.u, mine.fig, f.id, { label: "このリンクの人", otherWho: "この人", otherFace: avatar(f.id) })}</div></section>`;
  }
  if (!past && !prevLink) track("friend_view", { mode, figure: f.id, has_mine: mine && validCode(sd, mine.code) ? "yes" : "no" });
  app.innerHTML = `
    <div class="friend-head">${past || prevLink
      ? `<h1>${prevLink ? "前に保存した、リンクの結果" : "以前のあなたの結果"}<br>「${esc(f.name)}」タイプ</h1>${mine ? `<p class="note" style="margin:6px 0 0">いまの自分の結果は「${esc(fig(mine.fig).name)}」です</p>` : ""}`
      : `<h1>このリンクの人は<br>「${esc(f.name)}」タイプでした</h1><p class="note" style="margin:6px 0 0">リンクで届いた結果です（この端末に保存された、あなたの結果とは別です）</p>`}
      <p class="back-links">${mine && validCode(sd, mine.code) ? `<a href="#/r/${mode}/${mine.code}">← 自分の結果（${esc(fig(mine.fig).name)}）へ戻る</a>` : ""}<a href="#/me">マイページ</a></p></div>
    ${resultCard(r, mode, past ? "past" : prevLink ? "saved" : "friend", false)}
    <div style="display:grid;gap:8px;margin:16px 0">
      ${mine ? (past || prevLink ? "" : compat) : `<a class="btn start" data-fresh="${mode}" data-src="friend" href="#/q/${mode}">あなたは誰？ 12問で診断する</a>
      <p class="note" style="margin:0">${esc(f.name)}との相性もわかります</p>`}
    </div>
    <details class="card"><summary>${esc(f.name)}タイプってどんな人？</summary><p class="body">${esc(tx.body)}</p></details>
    <div class="claim">${past || prevLink
      ? `<button class="btn sub" data-mine>この結果を、自分の結果に戻す</button>`
      : `<button class="btn sub" data-mine>${mine ? `自分の結果として保存（いまの「${esc(fig(mine.fig).name)}」と入れかえ）` : "自分の結果として保存"}</button>
         <p class="note" style="margin:6px 0 0">この端末だけの保存です。図鑑の「発見」にはなりません。<br>友達の結果を見ているだけなら、押さなくて大丈夫です。</p>`}</div>`;
  app.querySelectorAll("[data-fresh]").forEach((a) => a.addEventListener("click", () => { store.del("progress." + mode); quiz = null; }));
  $("[data-mine]").onclick = () => {
    if (mine && !confirm(`いまの自分の結果（${fig(mine.fig).name}）を、この結果（${f.name}）に入れかえますか？\n元の結果（${fig(mine.fig).name}）は、マイページや結果画面の「前の結果」からあとで戻せます。${own ? "" : "\n※リンクから保存した結果は、図鑑の「発見」にはなりません。"}`)) return;
    if (!mine && !confirm(`この結果（${f.name}）を、この端末の「自分の結果」として保存しますか？${own ? "" : "\n※リンクから保存した結果は、図鑑の「発見」にはなりません。"}`)) return;
    if (mine && mine.code !== code) store.set("me.prev." + mode, mine);
    // via：自分で診断した結果なら付けない。入れかえ前の結果に戻すときは、その印を引き継ぐ。それ以外（友達のリンク）は "link"
    const via = own ? null : prevHere ? prevE.via ?? null : "link";
    store.set("me." + mode, via ? { code, fig: f.id, at: Date.now(), via } : { code, fig: f.id, at: Date.now() });
    store.del("lastFriend." + mode);
    track("claim_own_result", { mode });
    route();
  };
  $(".stage").dataset.state = "done";
  attachMotion(f.name);
  window.scrollTo(0, 0);
}

// 結果が出る瞬間の演出（約5秒。どこをタップしても最後まで飛ぶ）
function runReveal(r, mode, short) {
  const sd = engines[mode];
  const card = $(".rcard"), stage = $(".stage"), lvEl = $(".meta-row .lv b");
  const t = r.type, tl = typeLabel(t, mode);
  let done = false;
  const finish = (skipped) => {
    if (done) return;
    done = true;
    clearTimers();
    overlay.hidden = true; overlay.className = ""; overlay.innerHTML = "";
    stage.dataset.state = "done"; card.classList.remove("reveal");
    card.querySelectorAll(".stars .on").forEach((el) => (el.style.opacity = ""));
    document.querySelectorAll(".reveal-hide").forEach((el) => el.classList.remove("reveal-hide"));
    lvEl.textContent = r.lv;
  };
  overlay.onclick = () => finish(true);
  card.addEventListener("pointerdown", () => finish(true), { once: true });
  const cardPhase = (t0) => {
    later(t0, () => { overlay.hidden = true; card.classList.add("reveal"); stage.dataset.state = "sil"; });
    later(t0 + 500, () => { stage.dataset.state = "color"; });
    card.querySelectorAll(".stars .on").forEach((el, k) => { el.style.opacity = 0; later(t0 + 700 + k * 180, () => (el.style.opacity = 1)); });
    later(t0 + 1100, () => countUp(lvEl, r.lv, 450));
    if (r.capped) later(t0 + 1600, () => { const lv = card.querySelector(".lv"); lv.classList.remove("capped"); void lv.offsetWidth; lv.classList.add("capped"); });
    later(t0 + 1700, () => finish(false));
  };
  if (short || matchMedia("(prefers-reduced-motion: reduce)").matches) { overlay.hidden = true; return cardPhase(0); }
  // 前半：鑑定中（暗転 → レーダーが1軸ずつ伸びる → 系統のルーレット → 系統色が広がる）
  overlay.hidden = false;
  overlay.style.cssText = themeVars(t.id);
  overlay.innerHTML = `<div><div class="msg">あなたの魂を鑑定中…</div>${radar(r.scores, { grow: true })}
    <div class="roulette">？</div><div class="tname"></div></div><div class="skip">タップでスキップ</div>`;
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
let shareBlob = null;
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
  const pct = rare(r.figure.id, mode);
  center(`${"★".repeat(r.tier + 1)}${"☆".repeat(MAX_TIER - r.tier)}🔒🔒　Lv.${r.lv}${pct != null ? `　全体の${pct}%（推定）` : ""}`, H - 110, '800 36px "M PLUS Rounded 1c", sans-serif', "#b08a3e");
  center(`世界の偉人性格診断　${location.host}`, H - 44, '500 30px "M PLUS Rounded 1c", sans-serif', "#6b6358");
  return new Promise((ok) => c.toBlob(ok, "image/png"));
}
function prerenderShare(r, mode) { shareBlob = null; drawShare(r, mode).then((b) => (shareBlob = b)).catch(() => {}); }
async function shareImage(r, mode, text, url) {
  let blob;
  try { blob = shareBlob || (await drawShare(r, mode)); } catch { track("share_image_done", { method: "fail" }); return toast("画像を作れませんでした。スクショでシェアしてください"); }
  const file = new File([blob], `ijin-${r.figure.id}.png`, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: `${text}\n${url}` }); track("share_image_done", { method: "share" }); return; }
    catch (e) { if (e?.name === "AbortError") return; }
  }
  const src = URL.createObjectURL(blob);
  if (/Line\/|Instagram|FBAN|FBAV|Twitter|; wv\)/i.test(navigator.userAgent)) {
    // アプリ内ブラウザはダウンロードできないので、画像を出して長押しで保存してもらう
    sheet.hidden = false;
    sheet.innerHTML = `<div class="panel"><h2>画像を長押しして保存</h2><img src="${src}" alt="シェア用の画像" style="width:100%;border-radius:12px">
      <button class="btn sub close" style="margin-top:12px">閉じる</button></div>`;
    $(".close", sheet).onclick = () => { sheet.hidden = true; sheet.innerHTML = ""; };
    track("share_image_done", { method: "inapp" });
    return;
  }
  const a = document.createElement("a");
  a.href = src; a.download = file.name; a.click();
  track("share_image_done", { method: "download" });
  toast("画像を保存しました");
}

// ---------------- 本格診断（準備中）のシート：需要を測る ----------------
function openPremium(place) {
  let price = store.get("price");
  if (!price) { price = pick([300, 480, 680], 1)[0]; store.set("price", price); }
  track("premium_click", { place });
  sheet.hidden = false;
  sheet.innerHTML = `<div class="panel" role="dialog" aria-label="本格診断">
    <h2>本格診断は準備中です</h2>
    <p style="margin:0">30問で、もっとくわしく。あなたに近い偉人の割合（偉人スペクトラム）、100人全員との相性、あなたの第2の系統がわかる予定です。</p>
    <p class="price">予定価格 <b>${price}円</b>（買い切り。値段や内容は変わることがあります）</p>
    <p class="note" style="text-align:left;margin:-8px 0 12px">今は買えません。答えても、お金はかかりません。</p>
    <div class="step1"><p style="margin:0;font-weight:800">この値段で出たら、買いたいと思う？</p>
      <div class="poll intent">${[["yes", "買いたい"], ["maybe", "迷う"], ["no", "買わない"]].map(([k, o]) => `<button data-answer="${k}">${o}</button>`).join("")}</div></div>
    <div class="step2" hidden><p style="margin:0;font-weight:800">どれがいちばん気になる？</p>
      <div class="poll choice">${[["spectrum", "偉人スペクトラム（近い偉人の割合）"], ["compat100", "100人との相性表"], ["detail", "くわしい解説"], ["none", "特にない"]].map(([k, o]) => `<button data-choice="${k}">${o}</button>`).join("")}</div></div>
    <button class="btn sub close">閉じる</button></div>`;
  const close = () => { sheet.hidden = true; sheet.innerHTML = ""; };
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  $(".close", sheet).onclick = close;
  sheet.querySelectorAll(".intent button").forEach((b) => (b.onclick = () => {
    track("premium_intent", { answer: b.dataset.answer });
    $(".step1", sheet).hidden = true; $(".step2", sheet).hidden = false;
  }));
  sheet.querySelectorAll(".choice button").forEach((b) => (b.onclick = () => { track("premium_poll", { choice: b.dataset.choice }); close(); toast("ありがとう！今後の参考にします"); }));
}

// ---------------- 図鑑 ----------------
function renderZukan() {
  document.title = "図鑑｜世界の偉人性格診断";
  trackCta("zukan");
  const z = store.get("zukan", {});
  app.style.cssText = "";
  app.innerHTML = `
    <div class="zhead"><h1>偉人図鑑</h1><span class="cnt">発見 <b>${zukanCount()}</b> / ${FREE.length}${LOCKED.length ? `（＋鍵つき ${LOCKED.length}）` : ""}</span></div>
    <p class="note" style="text-align:left">自分の診断（通常・恋愛）の結果に出た偉人が「発見」として登録されます。相性や友達の結果で名前を見かけた偉人は🔒のまま（${knownCount()}人）。</p>
    ${SD.types.map((t) => `<div class="zrow"><h2><i style="background:${THEMES[t.id].accent}"></i>${esc(t.name)}</h2>
      <div class="zcells">${t.figures.map((f, k) => {
        const st = k > MAX_TIER ? "locked" : z[f.id] ? (z[f.id].src === "me" ? "me" : "known") : "unseen";
        return `<button class="zcell ${st}" data-id="${f.id}" data-st="${st}" style="--t-bg:${THEMES[t.id].bg}"
          aria-label="${st === "me" ? esc(f.name) : st === "known" ? `${esc(f.name)}（未発見）` : "？？？"}"><img src="${avatar(f.id, st !== "me")}" alt="">
          <span class="star">★${k + 1}</span>${st === "known" ? `<span class="znm">${esc(f.name)}</span>` : ""}${st === "locked" || st === "known" ? '<span class="lock">🔒</span>' : ""}</button>`;
      }).join("")}</div></div>`).join("")}
    <div style="display:grid;gap:10px"><a class="btn sub" href="#/me">マイページ</a><a class="btn sub" href="#/">トップへ</a></div>`;
  app.querySelectorAll(".zcell").forEach((b) => (b.onclick = () => {
    const { id, st } = b.dataset;
    if (st === "locked") return openPremium("zukan");
    if (st === "unseen") return toast("まだ出会っていません");
    if (st === "known") return toast(`${fig(id).name}：あなた自身の診断結果に出ると、図鑑に登録されます`);
    const tx = texts[id];
    sheet.hidden = false;
    sheet.innerHTML = `<div class="panel"><div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
        <img class="tile" src="${avatar(id)}" alt="" style="width:72px;height:72px;${themeVars(fig(id).type)}">
        <div><h2 style="margin:0">${esc(fig(id).name)}</h2><div class="note" style="text-align:left">${esc(sd_type(id).name)}・★${fig(id).tier + 1}</div></div></div>
      <p style="font-family:var(--serif);font-weight:900;margin:0 0 8px">「${esc(tx.serif)}」</p><p class="body">${esc(tx.body)}</p>
      <details><summary>元ネタを見る</summary><p>${esc(tx.motoneta.text)}</p></details>
      <button class="btn sub close" style="margin-top:14px">閉じる</button></div>`;
    const close = () => { sheet.hidden = true; sheet.innerHTML = ""; };
    sheet.onclick = (e) => { if (e.target === sheet) close(); };
    $(".close", sheet).onclick = close;
  }));
  window.scrollTo(0, 0);
}
const sd_type = (id) => SD.type(fig(id).type);

// ---------------- マイページ（#/me）：この端末の保存データを読むだけ。新しい保存はしない ----------------
function renderMe() {
  document.title = "マイページ｜世界の偉人性格診断";
  app.style.cssText = "";
  const MODES = [["normal", "性格診断"], ["love", "恋愛診断"]];
  const ok = (m, e) => e && engines[m] && validCode(engines[m], e.code) && SD.figures[e.fig];
  const date = (t) => (t ? new Date(t).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }) : "");
  const row = (m, e, lbl, face) => `<a class="me-row" href="#/r/${m}/${e.code}">
      <img class="tile" src="${face ?? avatar(e.fig)}" alt="" style="${themeVars(fig(e.fig).type)}">
      <span><span class="lbl">${esc(lbl)}</span><span class="nm">${esc(fig(e.fig).name)}</span></span><span class="go">›</span></a>`;
  // 自分の結果：いま・前の結果・この端末で診断した過去の結果（seen_results から計算し直す）
  const mineHtml = MODES.map(([m, name]) => {
    const cur = store.get("me." + m), prev = store.get("me.prev." + m);
    const shown = new Set([cur?.code, prev?.code]);
    const hist = store.get("seen_results", []).filter((x) => x.startsWith(m)).map((x) => x.slice(m.length)).reverse()
      .filter((c) => !shown.has(c) && validCode(engines[m], c)).slice(0, 5)
      .map((c) => ({ code: c, fig: engines[m].diagnose(answersOf(engines[m], c)).figure.id }));
    if (!ok(m, cur) && !ok(m, prev) && !hist.length)
      return `<div class="me-empty">${name}：まだ結果がありません　<a href="#/q/${m}" data-fresh="${m}">診断する</a></div>`;
    return (ok(m, cur) ? row(m, cur, `いまの${name}の結果${cur.via === "link" ? "（リンクから保存）" : ""}`) : "")
      + (ok(m, prev) ? row(m, prev, `前の${name}の結果${prev.via === "link" ? "（リンクから保存）" : ""} ${date(prev.at)}`) : "")
      + hist.map((h) => row(m, h, `以前の${name}の結果`)).join("");
  }).join("");
  const friends = store.get("friends", []).filter((x) => ok(x.mode, x));
  app.innerHTML = `
    <div class="zhead"><h1>マイページ</h1></div>
    <section class="card"><h2>自分の結果</h2><div class="me-list">${mineHtml}</div></section>
    <section class="card"><h2>図鑑</h2>
      <p style="margin:0 0 10px">発見 <b>${zukanCount()}</b> / ${FREE.length}人　・　名前だけ知っている 🔒 <b>${knownCount()}</b>人</p>
      <a class="btn sub" href="#/zukan">図鑑を見る</a></section>
    <section class="card"><h2>リンクで受け取った結果</h2>
      ${friends.length ? `<div class="me-list">${friends.map((x) => row(x.mode, x, `${x.mode === "love" ? "恋愛" : "性格"}・${date(x.at)}に受け取り${store.get("me." + x.mode)?.code === x.code ? "（いまの自分の結果に保存中）" : ""}`, relFace(x.fig))).join("")}</div>
        <p class="note" style="text-align:left;margin:8px 0 0">友達などから届いたリンクの結果です。あなたの結果とは別に保存されています（最大20件）。</p>`
        : `<p class="note" style="text-align:left;margin:0">まだありません。友達から結果のリンクが届くと、ここに並びます。</p>`}</section>
    <section class="card"><h2>保存について</h2>
      <p class="note" style="text-align:left;margin:0">この記録は、この端末のこのブラウザの中だけに保存されています（アカウントはありません）。機種変更、別のブラウザ、プライベートモード、ブラウザのデータ削除では消えることがあります。</p>
      <a class="btn sub" style="margin-top:12px" href="#/about">このサイトについて・記録を消す</a></section>
    <a class="btn sub" href="#/">トップへ</a>`;
  app.querySelectorAll("[data-fresh]").forEach((a) => a.addEventListener("click", () => { store.del("progress." + a.dataset.fresh); quiz = null; }));
  window.scrollTo(0, 0);
}

// このサイトについて（文案：docs/about-draft.md、根拠：docs/legal-check.md）
function renderAbout() {
  document.title = "このサイトについて｜世界の偉人性格診断";
  app.style.cssText = "";
  const contact = meta.contact
    ? `ご意見や不具合は、<a href="${esc(meta.contact)}" target="_blank" rel="noopener">GitHub の Issues</a> に書いてください（GitHub のアカウントが必要です）。書いた内容は、だれでも見られます。名前や住所など、あなたのことがわかる情報は書かないでください。`
    : "お問い合わせ先は準備中です。";
  app.innerHTML = `<article class="about">
    <h1>このサイトについて</h1>
    <p>「世界の偉人性格診断」は、12の質問に答えると、あなたに近い偉人がわかる遊びのサイトです。登録もお金もいりません。</p>
    <p><b>かんたんに言うと：</b>登録はいりません。質問への答えは、どこにも送りません。この端末に残る記録は、いつでも消せます。</p>
    <h2>遊びとして楽しんでください</h2>
    <p>この診断は、エンターテインメントです。心理検査ではなく、病気や心の状態を判断するものでもありません。結果は、あなたや誰かの価値を決めるものではありません。</p>
    <h2>偉人の話と台詞について</h2>
    <p>偉人のエピソードは、できるだけ調べて書いていますが、昔のことなので、いろいろな説があります。「と伝わる」「と言われる」と書いたものは、確かでない話です。偉人の台詞や恋愛版のひと言は、ほとんどがこのサイトで作ったものです。本人が言った・書いたとは限りません。</p>
    <h2>イラストについて</h2>
    <p>イラストは、このサイトが想像で描いたものです。本人の顔や姿をうつしたもの（肖像）ではありません。</p>
    <h2>利用状況の計測について</h2>
    <p>サイトをよくするために、Umami（ユーマミ）という計測サービスで、使われ方を数えています。Cookie は使いません。あなたが誰かは、わかりません。</p>
    <ul><li>集めるもの
        <ul><li>サイトでしたこと：診断を始めた・終えた（とちゅうでやめたときは、何問目までか）、どの偉人・系統・★になったか、友達の結果のリンクを開いたか、シェアしたか、「本格診断」の案内が出たか・押したか・アンケートの答え</li>
          <li>開いた画面の名前、性格版か恋愛版か</li>
          <li>この端末についての印：割り当てられた予定価格（300円・480円・680円のどれか）、前にも来たことがあるか、友達の結果のリンクを開いたことがあるか</li>
          <li>自動で届くもの：ブラウザ・OS・端末の種類、画面の大きさ、言語、国（IP アドレスから推定）</li></ul></li>
      <li>集めないもの：質問への一つひとつの答え、結果の URL の中の数字、前にいたページの URL、名前・メールアドレスなど、あなたが誰かわかる情報、広告のための情報</li></ul>
    <p>ブラウザの「Do Not Track（追跡拒否）」が有効な場合は、Umami の計測を行いません。</p>
    <h2>あなたの端末に保存するもの</h2>
    <p>次のものは、あなたのブラウザの中（localStorage）に保存します。保存したものを、そのまま送ることはありません。</p>
    <ul><li>とちゅうまでの答え、あなたの結果、友達の結果（最新20件まで）、図鑑に集めた偉人</li>
      <li>予定価格の種類、前に来たことがあるかの印、前に見た画面の印（はじめての人向けの説明を2回出さないため）</li></ul>
    <p>このうち「予定価格の種類」「前に来たことがあるか」「友達の結果を開いたことがあるか」は、上の計測で数えています。LINE や X の中で開いたときは、ふだんのブラウザとは別に保存されます。</p>
    <p>消したいときは、下の「この端末の記録をすべて消す」ボタンを押すか、ブラウザの設定でこのサイトのデータを消してください。</p>
    <h2>外部に送る情報</h2>
    <p>このサイトを表示したり、使われ方を数えたりするために、次の会社のサーバーに情報が送られます。</p>
    <ul><li>Umami Software, Inc.（Umami）：上の「集めるもの」。使われ方を数えて、サイトをよくするため</li>
      <li>Google LLC（Google Fonts）：IP アドレス、ブラウザの種類、開いたページの情報。文字（フォント）を表示するため</li></ul>
    <p>このほか、サイトの置き場所である GitHub, Inc.（GitHub Pages）にも、ページを届けるために IP アドレスなどが届きます。X・LINE・Wikipedia へのリンクは、押したときだけ、その先のサービスに移ります。</p>
    <h2>本格診断について</h2>
    <p>「本格診断」は、まだ準備中で、買うことはできません。表示している予定価格は、どのくらいの値段なら欲しいと思ってもらえるかを調べるためのもので、人によってちがう金額が出ます。内容や値段は、変わることがあります。</p>
    <h2>お問い合わせ</h2><p>${contact}</p>
    <h2>運営者</h2><p>世界の偉人性格診断　制作者（個人で運営しています）<br>最終更新：${esc(meta.updated ?? "")}</p>
    <button class="btn sub" data-clear>この端末の記録をすべて消す</button>
    <a class="btn sub" style="margin-top:10px" href="#/">トップへ</a></article>`;
  $("[data-clear]").onclick = () => {
    if (!confirm("このサイトの記録（結果・図鑑・とちゅうの答えなど）をすべて消しますか？")) return;
    try { Object.keys(localStorage).filter((k) => k.startsWith("ijin.")).forEach((k) => localStorage.removeItem(k)); } catch {}
    quiz = null;
    toast("この端末の記録を消しました");
    location.hash = "#/";
  };
  window.scrollTo(0, 0);
}

// 共有リンクから回答が落ちて届いたとき：その偉人の紹介と、診断への入口だけを出す
function renderFigure(mode, id) {
  const f = fig(id), t = sd_type(id), tl = typeLabel(t, mode), tx = texts[id];
  track("friend_view", { mode, figure: id, has_mine: "fallback" });
  document.title = `${f.name}タイプ｜${engines[mode].modeConf.name}`;
  app.style.cssText = themeVars(t.id);
  app.innerHTML = `
    <div class="friend-head"><h1>友達は「${esc(f.name)}」タイプでした</h1></div>
    <section class="rcard" style="${themeVars(t.id)}">
      <div class="stage" data-state="done"><img class="avatar color" src="${avatar(id)}" alt="${esc(f.name)}のイラスト"></div>
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
  overlay.hidden = true; sheet.hidden = true;
  app.style.cssText = "";
  const [, page, mode, code] = location.hash.split("/");
  if (page === "q" && engines[mode]) return renderQuiz(mode);
  if (page === "r" && engines[mode] && code) return renderResult(mode, code);
  if (page === "zukan") return renderZukan();
  if (page === "me") return renderMe();
  if (page === "about") return renderAbout();
  if (page === "f" && engines[mode] && SD.figures[code] && isFree(code)) return renderFigure(mode, code);
  quiz = null;
  renderTop();
}
window.addEventListener("hashchange", route);
addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) { sheet.hidden = true; sheet.innerHTML = ""; } });
addEventListener("pagehide", () => {
  if (quiz && quiz.answers.length && !quiz.abandonSent) { quiz.abandonSent = true; track("quiz_abandon", { mode: quiz.mode, n: quiz.answers.length, source: quiz.source }); }
});
route();
store.set("visited", true);

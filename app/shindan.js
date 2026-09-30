// 診断ロジック（logic/shindan.py の JavaScript 版）。
// 軸の順番は常に [O好奇, C規律, E社交, A協調, G胆力, M野心]。

export const AXES = ["O", "C", "E", "A", "G", "M"];

const norm = (v) => Math.hypot(...v);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

export async function loadData(base = "../data/") {
  const names = ["axes", "types", "rules", "plans", "questions", "questions_love", "questions_friend", "texts"];
  const jsons = await Promise.all(names.map((n) => fetch(`${base}${n}.json?v=c098414`).then((r) => r.json())));
  return Object.fromEntries(names.map((n, i) => [n, jsons[i]]));
}

export class Shindan {
  constructor(data, plan = "free", mode = "normal") {
    this.data = data;
    this.axes = data.axes.axes;
    this.rules = data.rules;
    this.tierLv = data.plans.tier_lv;
    this.planId = plan;
    this.plan = data.plans.plans[plan];
    this.mode = mode;
    this.modeConf = data.plans.modes[mode];
    const qsData = mode === "love" ? data.questions_love : mode === "friend" ? data.questions_friend : data.questions;
    const qs = qsData.questions;
    this.questions = qs.filter((q) => this.plan.questions === "all" || q.free);
    this.calib = data.rules.calib[mode === "normal" ? plan : `${mode}-${plan}`];
    this.types = data.types.types.map((t) => ({
      ...t,
      unit: t.proto ? t.proto.map((x) => x / norm(t.proto)) : null,
    }));
    this.M = this.buildBattleMatrix();
    this.figures = {};
    for (const t of this.types) t.figures.forEach((f, k) => (this.figures[f.id] = { ...f, type: t.id, tier: k }));
  }

  // 1. 回答 → 軸スコア（各 -1〜+1）
  score(answers) {
    const sums = Object.fromEntries(AXES.map((a) => [a, []]));
    for (const q of this.questions) sums[q.axis].push(((answers[q.id] - 3) / 2) * q.key);
    return AXES.map((a) => sums[a].reduce((s, x) => s + x, 0) / sums[a].length);
  }

  // 2. 系統判定：[系統, 第2候補]
  classify(u) {
    const bias = this.calib.type_bias;
    const n = norm(u) || 1e-9;
    const ranked = this.types
      .filter((t) => t.unit)
      .map((t) => [dot(u, t.unit) / n + (bias[t.id] || 0), t])
      .sort((a, b) => b[0] - a[0])
      .map((p) => p[1]);
    if (norm(u) < this.calib.norm_threshold) return [this.type("kinkou"), ranked[0]];
    return [ranked[0], ranked[1]];
  }

  // 3. レベル
  raw(u, t) {
    if (t.special === "balance") return 1 - (norm(u) / this.calib.norm_threshold) ** 6;
    return dot(u, t.unit);
  }
  breaks(t) {
    if (t.special === "balance") return [0, 0.25, 0.5, 0.72, 0.89, 1.0];
    return [0, ...this.calib.breaks];
  }
  lv(raw, t) {
    const b = this.breaks(t), L = this.tierLv;
    if (raw >= b[5]) return 99;
    let k = 0;
    if (raw >= 0) for (let i = 0; i < 5; i++) if (raw >= b[i]) k = i;
    const frac = Math.max(0, (raw - b[k]) / (b[k + 1] - b[k]));
    const top = k < 4 ? L[k + 1] - 1 : 99;
    return Math.max(1, Math.min(top, L[k] + Math.floor(frac * (top - L[k] + 1))));
  }
  tier(lv) {
    let k = 0;
    for (let i = 0; i < 5; i++) if (lv >= this.tierLv[i]) k = i;
    return k;
  }

  // 4. レベルアップ条件
  levelupHint(u, t, tier) {
    if (tier === 4) return null;
    const nxt = { to: t.figures[tier + 1].id, locked: tier + 1 > this.plan.max_tier };
    const needRaw = this.breaks(t)[tier + 1];
    if (t.special === "balance") {
      let i = 0;
      AXES.forEach((_, k) => { if (Math.abs(u[k]) > Math.abs(u[i])) i = k; });
      const target = this.calib.norm_threshold * (1 - needRaw) ** (1 / 6);
      const rest = Math.sqrt(Math.max(0, norm(u) ** 2 - u[i] ** 2));
      const pts = rest >= target ? null : Math.ceil((Math.abs(u[i]) - Math.sqrt(target ** 2 - rest ** 2)) * 50);
      return { ...nxt, axis: AXES[i], direction: "center", points: pts };
    }
    const needS = needRaw - dot(u, t.unit);
    const order = [...AXES.keys()].sort((a, b) => Math.abs(t.unit[b]) - Math.abs(t.unit[a]));
    for (const i of order) {
      const w = t.unit[i];
      if (Math.abs(w) < 0.2) continue;
      const sign = w > 0 ? 1 : -1;
      const du = needS / Math.abs(w);
      if (du > 1 - u[i] * sign) continue;
      const v = [...u];
      v[i] += du * sign;
      if (this.classify(v)[0].id === t.id)
        return { ...nxt, axis: AXES[i], direction: sign > 0 ? "up" : "down", points: Math.ceil(du * 50) };
    }
    return { ...nxt, axis: null, direction: null, points: null };
  }

  // 5. 相性
  buildBattleMatrix() {
    const idx = Object.fromEntries(AXES.map((a, i) => [a, i]));
    const M = AXES.map(() => AXES.map(() => 0));
    for (const c of this.rules.battle.cycles) {
      const o = c.order;
      o.forEach((a, k) => {
        const w = idx[a], l = idx[o[(k + 1) % o.length]];
        M[w][l] += 1;
        M[l][w] -= 1;
      });
    }
    return M;
  }
  battle(a, b) {
    let s = 0;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) s += a[i] * this.M[i][j] * b[j];
    return s;
  }
  matchups(u, t, tier, meFigId, n) {
    const strong = [], weak = [];
    for (const o of this.rules.battle.overrides) {
      if (o.winner === meFigId) strong.push(o.loser);
      else if (o.loser === meFigId) weak.push(o.winner);
    }
    if (t.special === "balance") {
      const sub = this.classify(u)[1];
      u = u.map((x, i) => x + 0.1 * sub.unit[i]);
    }
    const scored = this.types
      .filter((x) => x.unit && x.id !== t.id)
      .map((x) => [this.battle(u, x.unit), x])
      .sort((a, b) => a[0] - b[0]);
    const pick = (x) => x.figures[tier].id;
    strong.push(...[...scored].reverse().filter((p) => p[0] > 0).map((p) => pick(p[1])));
    weak.push(...scored.filter((p) => p[0] < 0).map((p) => pick(p[1])));
    // 史実ネタの相手が鍵つきの段階なら出さない（無料版では名前を見せないため）
    const ok = (id) => this.figures[id].tier <= this.plan.max_tier;
    return { strong: strong.filter(ok).slice(0, n), weak: weak.filter(ok).slice(0, n) };
  }

  // まとめ
  diagnose(answers) {
    const u = this.score(answers);
    const [t, sub] = this.classify(u);
    let lv = this.lv(this.raw(u, t), t);
    let capped = false;
    const neutral = this.questions.filter((q) => answers[q.id] === 3).length / this.questions.length;
    if (t.special === "balance" && neutral > 0.5) lv = Math.min(lv, this.tierLv[2] - 1);
    if (lv > this.plan.lv_cap) { lv = this.plan.lv_cap; capped = true; }
    const tier = this.tier(lv);
    const fig = t.figures[tier];
    let levelup;
    if (capped) levelup = { to: t.figures[tier + 1].id, locked: true, reason: "plan_cap" };
    else if (t.special === "balance" && neutral > 0.5 && tier === 1)
      levelup = { to: t.figures[2].id, locked: false, reason: "too_many_neutral" };
    else levelup = this.levelupHint(u, t, tier);
    return {
      u,
      scores: Object.fromEntries(AXES.map((a, i) => [a, Math.round((u[i] + 1) * 50)])),
      type: t, subType: this.plan.show_sub_type ? sub : null,
      figure: fig, tier, lv, capped, levelup,
      matchups: this.matchups(u, t, tier, fig.id, this.plan.matchups),
    };
  }

  type(id) { return this.types.find((t) => t.id === id); }
}

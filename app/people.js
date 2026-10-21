// 回答コードは人物の識別子ではない。同じ回答の別人もカード化できる。
import { validInviteToken } from "./social.js?v=1d63bbf-202610212246";

export function prependPersonCard(cards, card, maxCards = 50, isUsable = () => true) {
  if (!Array.isArray(cards) || cards.filter(isUsable).length >= maxCards) return null;
  return [card, ...cards];
}

// 人物カードに保存された偉人の「種類」だけを取り出す。
// 回答コードやカードIDは人の本人確認にならないため、呼び出し側で
// 回答から偉人IDまで再計算したカードだけを isVerified で通す。
export function distinctCardFigures(cards, isVerified) {
  if (!Array.isArray(cards) || typeof isVerified !== "function") return [];
  const seen = new Set();
  const figures = [];
  for (const card of cards) {
    if (!card || typeof card !== "object" || typeof card.fig !== "string" || !card.fig) continue;
    if (!isVerified(card) || seen.has(card.fig)) continue;
    seen.add(card.fig);
    figures.push(card.fig);
  }
  return figures;
}

export function figureSetProgress(figureIds, targetIds) {
  const have = new Set(figureIds);
  return {
    found: targetIds.filter((id) => have.has(id)),
    missing: targetIds.filter((id) => !have.has(id)),
  };
}

// 旧版のカードには固有IDがない。順序・呼び名を保ち、欠損や重複したIDだけ補う。
export function ensurePersonCardIds(cards, makeId) {
  const used = new Set();
  let changed = false;
  const updated = cards.map((card) => {
    let id = card.id;
    if (!validInviteToken(id) || used.has(id)) {
      for (let attempt = 0; attempt < 20; attempt++) {
        id = makeId();
        if (validInviteToken(id) && !used.has(id)) break;
      }
      if (!validInviteToken(id) || used.has(id)) throw new Error("人物カードIDを作れませんでした");
      changed = true;
    }
    used.add(id);
    return id === card.id ? card : { ...card, id };
  });
  return { cards: updated, changed };
}

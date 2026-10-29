// 回答コードは人物の識別子ではない。同じ回答の別人もカード化できる。
import { validInviteToken } from "./social.js?v=e1daf6f-202610300546";

export function prependPersonCard(cards, card, maxCards = 50, isUsable = () => true) {
  if (!Array.isArray(cards) || cards.filter(isUsable).length >= maxCards) return null;
  return [card, ...cards];
}

// The visible fallback must not change when a newer card is inserted ahead of
// this one. Old cards without a unique persisted ID retain the old index label.
// Old or damaged saved labels can contain invisible formatting characters that
// make a non-empty label appear blank (or reverse the visible card name).
const HIDDEN_LABEL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufeFF\uffa0]/g;
// Keep joiners and emoji variation selectors in a visible name, but do not
// accept a label made only of those otherwise invisible characters.
const VISIBLE_LABEL_CHAR = /[^\u200d\ufe00-\ufe0f\u{e0100}-\u{e01ef}\s]/u;

export function cleanPersonCardLabel(value) {
  if (typeof value !== "string") return "";
  const label = value.replace(HIDDEN_LABEL_CHARS, "").trim();
  const shortened = Array.from(label).slice(0, 20).join("");
  return VISIBLE_LABEL_CHAR.test(shortened) ? shortened : "";
}

export function personCardNeedsLabel(card) {
  return !cleanPersonCardLabel(card?.label);
}

export function personCardDisplayName(card, displayIndex) {
  const label = cleanPersonCardLabel(card?.label);
  if (label) return label;
  return validInviteToken(card?.id)
    ? `友達カード #${card.id.slice(0, 8).toUpperCase()}`
    : `友達カード ${displayIndex + 1}`;
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

// 回答コードは人物の識別子ではない。同じ回答の別人もカード化できる。
import { validInviteToken } from "./social.js?v=c733c90-202610172355";

export function prependPersonCard(cards, card, maxCards = 50) {
  if (!Array.isArray(cards) || cards.length >= maxCards) return null;
  return [card, ...cards];
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

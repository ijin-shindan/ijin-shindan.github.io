// 回答コードは人物の識別子ではない。同じ回答の別人もカード化できる。
export function prependPersonCard(cards, card, maxCards = 50) {
  if (!Array.isArray(cards) || cards.length >= maxCards) return null;
  return [card, ...cards];
}

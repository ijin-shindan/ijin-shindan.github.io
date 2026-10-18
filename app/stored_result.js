// 端末内に残した人物IDは、回答コードから再計算できる場合だけ表示に使う。
// 不一致の記録は消さず、呼び出し側で表示対象から外す。
export function storedResultMatches(mode, entry, engines, figures, validCode, answersOf) {
  const engine = engines[mode];
  if (!engine || !entry || typeof entry.code !== "string" || typeof entry.fig !== "string"
    || !Object.prototype.hasOwnProperty.call(figures, entry.fig)) return false;
  try {
    return validCode(engine, entry.code)
      && engine.diagnose(answersOf(engine, entry.code)).figure.id === entry.fig;
  } catch { return false; }
}

export const storedList = (value) => Array.isArray(value) ? value : [];

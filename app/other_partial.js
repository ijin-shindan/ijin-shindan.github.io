// 他己回答の「見ていない」(0) は中立(3)ではない。
// 観察できた質問だけで軸を作り、観察軸上で系統の方向を比較する。
// 未較正の参考候補であり、Lv・tier・総合診断には使わない。
export function partialOtherCandidate(questions, answerValues, types) {
  if (!Array.isArray(questions) || !Array.isArray(answerValues) || questions.length !== answerValues.length
    || !answerValues.every((v) => Number.isInteger(v) && v >= 0 && v <= 5)) return null;
  const observed = questions.map((q, i) => ({ ...q, answer: answerValues[i] })).filter((q) => q.answer > 0);
  const byAxis = new Map();
  for (const q of observed) {
    const score = ((q.answer - 3) / 2) * q.key;
    byAxis.set(q.axis, [...(byAxis.get(q.axis) || []), score]);
  }
  // 12問中8問・6軸中4軸が最低限。閾値は実ユーザーでの妥当性未検証。
  if (observed.length < 8 || byAxis.size < 4) return null;
  const axes = [...byAxis.keys()];
  const signal = axes.map((axis) => {
    const xs = byAxis.get(axis);
    return xs.reduce((sum, v) => sum + v, 0) / xs.length;
  });
  const userNorm = Math.hypot(...signal);
  if (userNorm < 1e-9) return null;
  const orderedAxes = ["O", "C", "E", "A", "G", "M"];
  const scored = types.filter((t) => Array.isArray(t.unit)).map((t) => {
    const direction = axes.map((axis) => t.unit[orderedAxes.indexOf(axis)]);
    const typeNorm = Math.hypot(...direction);
    const similarity = typeNorm ? signal.reduce((sum, v, i) => sum + v * direction[i], 0) / (userNorm * typeNorm) : -Infinity;
    return { type: t, similarity };
  }).sort((a, b) => b.similarity - a.similarity);
  if (!scored.length || !Number.isFinite(scored[0].similarity)) return null;
  return { type: scored[0].type, figure: scored[0].type.figures[0], observedQuestions: observed.length,
    observedAxes: byAxis.size, margin: scored.length > 1 ? scored[0].similarity - scored[1].similarity : null };
}

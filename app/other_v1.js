// OTHER v1 の返信コードは質問IDを持たず、以下の12位置に対応する。
// 新しい質問はこの配列を変更せず、別版の順序として定義する。
export const OTHER_V1_QUESTION_IDS = Object.freeze([
  'FO1', 'FC1', 'FE1', 'FA1', 'FG1', 'FM1',
  'FO2', 'FC2', 'FE2', 'FA2', 'FG2', 'FM2',
]);

export function orderOtherV1Questions(questions) {
  if (!Array.isArray(questions)) throw new TypeError('OTHER v1 の質問がありません');
  const byId = new Map(questions.map((question) => [question.id, question]));
  if (questions.length !== OTHER_V1_QUESTION_IDS.length || byId.size !== questions.length)
    throw new TypeError('OTHER v1 の質問数かIDが変わっています');
  return OTHER_V1_QUESTION_IDS.map((id) => {
    const question = byId.get(id);
    if (!question) throw new TypeError(`OTHER v1 の質問 ${id} がありません`);
    return question;
  });
}

export function otherV1ProgressIndex(rawIndex, answerCount) {
  const fallback = Math.min(answerCount, OTHER_V1_QUESTION_IDS.length - 1);
  if (rawIndex === null) return fallback;
  const index = Number(rawIndex);
  return Number.isInteger(index) && index >= 0 && index < OTHER_V1_QUESTION_IDS.length
    ? Math.min(index, fallback) : fallback;
}

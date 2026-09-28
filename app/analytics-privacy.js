// Umami の送信直前に URL・ページ名・参照元を最小限にする。
// 質問への回答を含む URL や、直前に見たページの情報を送らない。
window.ijinAnalyticsBeforeSend = function (type, payload) {
  if (type !== "event") return false;
  return { ...payload, url: "/app/", title: "世界の偉人性格診断", referrer: "" };
};

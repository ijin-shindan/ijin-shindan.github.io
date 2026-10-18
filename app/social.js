// 招待と返信のリンクはブラウザー内だけで組み立てる。
// トークンは招待の照合用であり、本人確認や回答者の独立性を証明しない。
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
// 0 は「見ていない／分からない」。3 は中立回答であり、両者を混同しない。
const FRIEND_CODE_PATTERN = /^1\.[0-5]{12}$/;
const FRIEND_CODE_VERSION = '1';

export function otherPilotAllowed(hostname) {
  // 個別回答を含む試作リンクは公開前にLANへ配らない。
  return /^(?:localhost|127\.0\.0\.1)$/.test(hostname);
}

export function validInviteToken(token) {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

export function validFriendCode(code) {
  return typeof code === "string" && FRIEND_CODE_PATTERN.test(code);
}

export function makeFriendCode(answers) {
  if (!Array.isArray(answers) || answers.length !== 12 ||
      !Array.from({ length: 12 }, (_, index) => answers[index])
        .every((answer) => Number.isInteger(answer) && answer >= 0 && answer <= 5)) {
    throw new TypeError('OTHER v1 の回答は0〜5を12個選んでください');
  }
  return `${FRIEND_CODE_VERSION}.${answers.join('')}`;
}

export function friendAnswersFromCode(code) {
  return validFriendCode(code) ? [...code.slice(2)].map(Number) : null;
}

export function createInviteToken(cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider || typeof cryptoProvider.getRandomValues !== "function") {
    throw new Error("安全な乱数を利用できません。招待リンクを作れません。");
  }
  const bytes = new Uint8Array(16);
  cryptoProvider.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function socialUrl(baseUrl, hash) {
  const url = new URL(baseUrl);
  if (!["http:", "https:", "file:"].includes(url.protocol)) {
    throw new TypeError("招待リンクに使えないURLです。");
  }
  // 既存ページの検索語や古い結果コードを、新しいリンクへ持ち込まない。
  url.search = "";
  url.hash = hash;
  return url.href;
}

export function makeInviteUrl(baseUrl, token) {
  if (!validInviteToken(token)) throw new TypeError("招待トークンが不正です。");
  return socialUrl(baseUrl, `#/ask/${token}`);
}

export function makeReplyUrl(baseUrl, token, code) {
  if (!validInviteToken(token)) throw new TypeError("招待トークンが不正です。");
  if (!validFriendCode(code)) throw new TypeError("回答コードが不正です。");
  return socialUrl(baseUrl, `#/reply/${token}/${code}`);
}

export function parseSocialHash(hash) {
  if (typeof hash !== "string") return null;
  let match = /^#\/ask\/([0-9a-f]{32})$/.exec(hash);
  if (match) return { kind: "invite", token: match[1] };
  match = /^#\/reply\/([0-9a-f]{32})\/(1\.[0-5]{12})$/.exec(hash);
  if (match) return { kind: "reply", token: match[1], code: match[2] };
  return null;
}

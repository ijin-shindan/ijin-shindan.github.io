// 外部の共有URLの形を変えず、アプリへ移った後の受信文脈だけを区別する。
// shared=1 は「共有ページを経由した」目印であり、別人や本人の証明ではない。
export const SHARED_RESULT_PARAM = "shared";

export function sharedResultViewPath(mode, code) {
  return `index.html?shared=1#/r/${mode}/${encodeURIComponent(code)}`;
}

export function isSharedResultEntry(url, mode, code) {
  try {
    const current = new URL(url);
    return current.searchParams.get(SHARED_RESULT_PARAM) === "1"
      && current.hash === `#/r/${mode}/${code}`;
  } catch { return false; }
}

export function withoutSharedResultParam(url) {
  const next = new URL(url);
  next.searchParams.delete(SHARED_RESULT_PARAM);
  next.searchParams.delete("shared_fig");
  next.searchParams.delete("shared_mode");
  return next.href;
}

// 他己回答は別人の証明ができない。端末内の返信記録としてだけ扱う。
import { validInviteToken, validFriendCode } from "./social.js?v=06bf198-202610301802";

export function appendOtherReply(records, entry, maxRecords = 50) {
  if (!Array.isArray(records) || !validInviteToken(entry?.token) || !validFriendCode(entry?.code))
    return { status: "invalid", records };
  if (records.some((x) => x?.token === entry.token && x?.code === entry.code))
    return { status: "duplicate", records };
  if (records.length >= maxRecords) return { status: "full", records };
  return { status: "saved", records: [entry, ...records] };
}

export function removeOtherReply(records, token, code) {
  if (!Array.isArray(records)) return null;
  return records.filter((x) => !(x?.token === token && x?.code === code));
}

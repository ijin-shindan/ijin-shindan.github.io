// A shared result is kept only for the tab in which the recipient chose to
// start a diagnosis. This is not a person card or a persistent result record.
const keyOf = (mode) => `ijin.shared.return.${mode}`;

export function rememberSharedReturn(storageOf, mode, friend, epoch, attemptId) {
  if (!['normal', 'love'].includes(mode) || epoch?.status !== 'present'
    || typeof epoch.token !== 'string' || !epoch.token
    || typeof attemptId !== 'string' || !attemptId
    || typeof friend?.code !== 'string' || typeof friend?.fig !== 'string') return false;
  try {
    const storage = storageOf();
    storage.setItem(keyOf(mode), JSON.stringify({ code: friend.code, fig: friend.fig,
      epoch: epoch.token, attemptId }));
    const saved = readSharedReturn(storageOf, mode, epoch, attemptId);
    return saved?.code === friend.code && saved.fig === friend.fig;
  } catch { return false; }
}

export function readSharedReturn(storageOf, mode, epoch, attemptId) {
  if (!['normal', 'love'].includes(mode) || epoch?.status !== 'present'
    || typeof epoch.token !== 'string' || !epoch.token
    || typeof attemptId !== 'string' || !attemptId) return null;
  try {
    const storage = storageOf();
    const entry = JSON.parse(storage.getItem(keyOf(mode)));
    return entry && entry.epoch === epoch.token && entry.attemptId === attemptId
      && typeof entry.code === 'string' && typeof entry.fig === 'string'
      ? { code: entry.code, fig: entry.fig } : null;
  } catch { return null; }
}

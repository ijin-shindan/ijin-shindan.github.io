/** A separate guide, never a diagnosis result or selectable roster entry. */
const mounted = new WeakMap();

export function mountGuide(container) {
  if (!container) return () => {};
  mounted.get(container)?.();
  const events = new AbortController();
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let timers = [];
  let disposed = false;
  let ready = false;
  const section = document.createElement('section');
  section.className = 'ng-guide';
  section.hidden = false;
  section.setAttribute('aria-label', '案内役 ナポレオン');
  section.innerHTML = `
    <div class="ng-label">案内役 ナポレオン</div>
    <div class="ng-stage"><div class="ng-portrait" role="img" aria-label="白馬に乗った案内役ナポレオン"></div></div>
    <div class="ng-buttons"><button type="button" class="ng-play" disabled>案内役のひと幕</button><button type="button" class="ng-stop" disabled>停止</button></div>
    <p class="ng-status" role="status" aria-live="polite">画像を準備しています。</p>`;
  container.append(section);
  const portrait = section.querySelector('.ng-portrait');
  const play = section.querySelector('.ng-play');
  const stop = section.querySelector('.ng-stop');
  const status = section.querySelector('.ng-status');
  const labels = ['通常', '馬が立ち上がる', '焦る', 'キメる', '怒る', '真顔で泣く'];
  const listen = (target, event, handler) => target.addEventListener(event, handler, { signal: events.signal });

  function pose(frame, x = 0) {
    portrait.style.backgroundPosition = `${frame % 3 * 50}% ${Math.floor(frame / 3) * 100}%`;
    portrait.style.transform = `translateX(${x}%)`;
    portrait.setAttribute('aria-label', `白馬に乗った案内役ナポレオン：${labels[frame]}`);
  }
  function cancel() {
    timers.forEach(clearTimeout);
    timers = [];
    play.disabled = !ready;
    stop.disabled = true;
  }
  function reset(message) {
    cancel();
    pose(0);
    if (message) status.textContent = message;
  }
  function later(time, fn) {
    timers.push(setTimeout(() => {
      if (!disposed && section.isConnected) fn();
    }, time));
  }
  listen(play, 'click', () => {
    cancel();
    if (!ready || disposed) return;
    if (media.matches) {
      pose(3);
      stop.disabled = false;
      status.textContent = '動きを抑えて、キメ顔を表示しています。';
      return;
    }
    play.disabled = true;
    stop.disabled = false;
    status.textContent = '案内役のひと幕を再生中。';
    pose(0);
    later(500, () => pose(1));
    later(800, () => pose(2));
    later(1250, () => pose(0));
    later(1600, () => pose(5));
    later(1780, () => pose(5, -.3));
    later(1860, () => pose(5, .3));
    later(1940, () => pose(5));
    later(2260, () => pose(0));
    later(2650, () => pose(3));
    later(3000, () => { cancel(); status.textContent = 'ひと幕が終わりました。'; });
  });
  listen(stop, 'click', () => reset('停止しました。'));
  listen(media, 'change', () => reset('端末の動きの設定を反映しました。'));
  listen(document, 'visibilitychange', () => {
    if (document.hidden) reset('停止しました。');
  });

  const atlas = new Image();
  atlas.onload = () => {
    if (disposed) return;
    ready = true;
    play.disabled = false;
    status.textContent = '音は鳴りません。';
    section.hidden = false;
    pose(0);
  };
  atlas.onerror = () => {
    if (disposed) return;
    ready = false;
    cancel();
    section.hidden = true;
  };
  atlas.src = new URL('assets/napoleon-atlas.png', import.meta.url).href;
  portrait.style.backgroundImage = `url("${atlas.src}")`;

  function cleanup() {
    if (disposed) return;
    disposed = true;
    cancel();
    events.abort();
    atlas.onload = null;
    atlas.onerror = null;
    section.remove();
    mounted.delete(container);
  }
  mounted.set(container, cleanup);
  return cleanup;
}

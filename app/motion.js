/** Articulated local SVG performance. No third-party library, sound or telemetry. */
const mounted = new WeakMap();
const cache = new Map();
const REST = {camera:1, x:0, y:0, body:0, torso:0, head:0, left:0, right:0, legLeft:0, legRight:0, elbowLeft:0, elbowRight:0, face:'neutral', tears:false, impact:false};
const SEQUENCES = {
  pose: [
    [0,{}], [300,{torso:-7,head:6,left:-20,right:18,legLeft:5,legRight:-3,camera:.96}],
    [680,{torso:-7,head:6,left:-20,right:18,legLeft:5,legRight:-3,camera:.96}],
    [820,{torso:8,head:-8,left:30,right:-45,elbowLeft:-35,elbowRight:80,legLeft:-8,legRight:8,camera:1.55,face:'happy',impact:true}],
    [960,{torso:5,head:-5,left:24,right:-38,elbowLeft:-28,elbowRight:68,legLeft:-6,legRight:6,camera:1.4,face:'happy',impact:true}],
    [1250,{torso:5,head:-5,left:24,right:-38,elbowLeft:-28,elbowRight:68,legLeft:-6,legRight:6,camera:1.4,face:'happy'}],
    [1630,{torso:-2,head:2,left:12,right:-15,camera:1.02,face:'happy'}], [1940,{}], [2350,{}]
  ],
  angry: [
    [0,{}], [300,{head:-7,torso:3,face:'angry',left:8,right:-8}],
    [610,{head:6,torso:-9,left:-22,right:20,legLeft:6,face:'angry',camera:.95}],
    [940,{head:6,torso:-9,left:-22,right:20,legLeft:6,face:'angry',camera:.95}],
    [1070,{head:-12,torso:11,left:24,right:-45,elbowLeft:-20,elbowRight:65,legRight:9,legLeft:-8,face:'angry',camera:1.28,impact:true}],
    [1190,{head:-7,torso:7,left:18,right:-35,elbowLeft:-18,elbowRight:55,legRight:6,legLeft:-5,face:'angry',camera:1.2}],
    [1460,{head:-7,torso:7,left:18,right:-35,elbowLeft:-18,elbowRight:55,legRight:6,legLeft:-5,face:'angry',camera:1.2}],
    [1800,{head:4,torso:-2,left:-3,right:4,face:'surprise'}], [2160,{}], [2500,{}]
  ],
  cry: [
    [0,{}], [450,{head:8,torso:4,left:-9,right:8,face:'sad'}],
    [850,{head:8,torso:4,left:-9,right:8,face:'sad'}],
    [860,{head:8,torso:4,left:-9,right:8,face:'sad',tears:true}],
    [1050,{head:6,torso:5,left:-14,right:13,face:'sad',tears:true}],
    [1180,{head:9,torso:3,left:-9,right:8,face:'sad',tears:true}],
    [1310,{head:6,torso:5,left:-14,right:13,face:'sad',tears:true}],
    [1440,{head:9,torso:3,left:-9,right:8,face:'sad',tears:true}],
    [1740,{head:9,torso:3,left:-9,right:8,face:'sad',tears:true}],
    [2020,{head:0,torso:0,face:'neutral'}], [2500,{}]
  ],
  think: [
    [0,{}], [380,{head:10,torso:-3,right:86,elbowRight:102,left:6,face:'neutral'}],
    [1050,{head:10,torso:-3,right:86,elbowRight:102,left:6,face:'neutral'}],
    [1170,{head:-8,torso:3,right:-55,left:12,face:'surprise'}],
    [1510,{head:-8,torso:3,right:-55,left:12,face:'surprise'}],
    [1830,{head:0,torso:0,right:0,face:'happy'}], [2280,{}]
  ]
};

function sanitizedSvg(text, label) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const source = doc.documentElement;
  if (source.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('Invalid portrait');
  source.querySelectorAll('script,foreignObject,iframe,animate,animateTransform,set').forEach(el => el.remove());
  for (const el of [source,...source.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || (/href$/i.test(attr.name) && !attr.value.startsWith('#'))) el.removeAttribute(attr.name);
    }
  }
  const svg = document.importNode(source, true);
  svg.classList.add('rig-art');
  svg.setAttribute('aria-label', `${label}の全身イラスト`);
  return svg;
}

export function mountMotion(stage, {name='偉人'}={}) {
  const original = stage?.querySelector('.avatar.color');
  if (!original) return () => {};
  mounted.get(stage)?.();
  const events = new AbortController();
  const listen = (el,event,fn) => el.addEventListener(event,fn,{signal:events.signal});
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let disposed=false, ready=false, svg=null, parts={}, raf=0, start=0, sequence=null, lastTick=-1;
  stage.classList.add('rig-stage');
  const controls=document.createElement('div');
  controls.className='rig-controls';
  controls.setAttribute('role','group');
  controls.setAttribute('aria-label',`${name}のリアクション`);
  controls.innerHTML='<div class="rig-buttons"><button data-motion="pose" disabled>キメる</button><button data-motion="angry" disabled>怒る</button><button data-motion="cry" disabled>泣く</button><button data-motion="think" disabled>考える</button><button data-motion="stop" disabled>停止</button></div><label class="rig-reduce"><input type="checkbox"> 動きを抑える</label><p class="rig-status" role="status" aria-live="polite">全身イラストを準備しています。</p>';
  stage.insertAdjacentElement('afterend',controls);
  const status=controls.querySelector('.rig-status');
  const reduce=controls.querySelector('input');
  const stop=controls.querySelector('[data-motion="stop"]');
  reduce.checked=media.matches;
  try { const saved=localStorage.getItem('ijin.motionReduced'); if(saved!==null) reduce.checked=saved==='true'; } catch {}
  const labels={pose:'キメる',angry:'怒る',cry:'泣く',think:'考える'};
  const fx=document.createElement('div');fx.className='rig-impact';fx.setAttribute('aria-hidden','true');stage.append(fx);

  function rotate(key, value) {
    const el=parts[key];if(!el)return;
    el.setAttribute('transform',`rotate(${value + Number(el.dataset.rest || 0)} ${el.dataset.pivot})`);
  }
  function frame(values={}) {
    if(!svg)return;
    const v={...REST,...values};
    parts.camera?.setAttribute('transform',`translate(160 145) scale(${v.camera}) translate(-160 -145)`);
    parts.body?.setAttribute('transform',`translate(${v.x} ${v.y}) rotate(${v.body} 160 398)`);
    for(const [part,key] of [['torso','torso'],['head','head'],['arm-left','left'],['arm-right','right'],['leg-left','legLeft'],['leg-right','legRight'],['forearm-left','elbowLeft'],['forearm-right','elbowRight']]) rotate(part,v[key]);
    svg.querySelectorAll('[data-face]').forEach(el=>{el.style.display=el.dataset.face===v.face?'inline':'none';});
    svg.querySelectorAll('[data-tears]').forEach(el=>{el.style.display=v.tears?'inline':'none';});
    if(v.tears) {
      const inverse=svg.getCTM()?.inverse();
      if(inverse)for(const side of ['left','right']) {
        const eye=svg.querySelector(`[data-eye="${side}"]`);
        const matrix=eye?.getCTM();if(!matrix)continue;
        const point=svg.createSVGPoint();point.x=Number(eye.getAttribute('cx'));point.y=Number(eye.getAttribute('cy'));
        const {x,y}=point.matrixTransform(matrix).matrixTransform(inverse);
        const bottom=403, mid=(y+bottom)/2;
        svg.querySelector(`[data-stream="${side}"]`).setAttribute('d',`M ${x-3} ${y} L ${x+4} ${y+1} L ${x+7} ${mid} L ${x+10} ${bottom-8} L ${x+23} ${bottom} L ${x+4} ${bottom-2} L ${x-12} ${bottom+2} L ${x-6} ${bottom-11} L ${x-5} ${mid} Z`);
        svg.querySelector(`[data-glint="${side}"]`).setAttribute('d',`M ${x-2} ${y+4} L ${x} ${y+4} L ${x+2} ${mid} L ${x-1} ${bottom-7} L ${x-4} ${bottom-1} L ${x-2} ${mid} Z`);
      }
    }
    fx.classList.toggle('active',v.impact);
  }
  function cancel() { cancelAnimationFrame(raf);raf=0;sequence=null;stop.disabled=true; }
  function reset(message='') { cancel();frame();if(message)status.textContent=message; }
  // 12fps stepped joint poses: deliberate holds, a sharp impulse, then a deadpan rest.
  function tick(now) {
    if(disposed || !sequence || !stage.isConnected)return;
    const elapsed=now-start;
    const tickIndex=Math.floor(elapsed/83.333);
    if(tickIndex!==lastTick) {
      lastTick=tickIndex;
      let at=0;while(at<sequence.length-1 && sequence[at+1][0]<=elapsed)at++;
      if(at===sequence.length-1){reset('リアクションが終わりました。');return;}
      const [ta,a0]=sequence[at], [tb,b0]=sequence[at+1];
      const a={...REST,...a0},b={...REST,...b0},p=Math.min(1,(elapsed-ta)/(tb-ta));
      const v={...a};
      for(const key of Object.keys(REST))if(typeof REST[key]==='number')v[key]=a[key]+(b[key]-a[key])*p;
      frame(v);
    }
    raf=requestAnimationFrame(tick);
  }
  function play(kind) {
    if(!ready || disposed)return;
    reset();
    const rect=stage.getBoundingClientRect();
    if(rect.top<0 || rect.bottom>innerHeight)stage.scrollIntoView({block:'center',behavior:'instant'});
    stop.disabled=false;
    if(reduce.checked) {
      frame(kind==='cry'?{face:'sad',tears:true,head:6,torso:3}:kind==='angry'?{face:'angry',head:-5,right:-20}:kind==='think'?{head:10,right:86,elbowRight:102}:{face:'happy',right:-45});
      status.textContent=`${labels[kind]}：止め絵で表示しています。`;
      return;
    }
    sequence=SEQUENCES[kind];start=performance.now();lastTick=-1;
    status.textContent=`${labels[kind]}のリアクションを再生中。`;
    raf=requestAnimationFrame(tick);
  }
  controls.querySelectorAll('[data-motion]').forEach(button=>listen(button,'click',()=>button.dataset.motion==='stop'?reset('停止しました。'):play(button.dataset.motion)));
  listen(reduce,'change',()=>{try{localStorage.setItem('ijin.motionReduced',String(reduce.checked));}catch{}reset('動きの設定を変更しました。');});
  listen(media,'change',()=>{reduce.checked=media.matches;try{localStorage.removeItem('ijin.motionReduced');}catch{}reset('端末の動きの設定を反映しました。');});
  listen(document,'visibilitychange',()=>{if(document.hidden)reset('停止しました。');});
  const url=original.currentSrc || original.src;
  if(!cache.has(url))cache.set(url,fetch(url).then(r=>{if(!r.ok)throw new Error('Portrait unavailable');return r.text();}).catch(e=>{cache.delete(url);throw e;}));
  cache.get(url).then(text=>{
    if(disposed)return;
    svg=sanitizedSvg(text,name);
    if(!svg.querySelector('[data-part="torso"]'))throw new Error('Portrait is not articulated');
    parts=Object.fromEntries([...svg.querySelectorAll('[data-part]')].map(el=>[el.dataset.part,el]));
    stage.insertBefore(svg,fx);
    original.hidden=true;
    ready=true;
    controls.querySelectorAll('[data-motion]:not([data-motion="stop"])').forEach(b=>{b.disabled=false;});
    status.textContent='表情としぐさを見てみる。音は鳴りません。';frame();
  }).catch(()=>{if(!disposed)status.textContent='いまは止め絵で表示しています。再読み込みで動きを試せます。';});
  function cleanup() {
    if(disposed)return;disposed=true;cancel();events.abort();svg?.remove();fx.remove();controls.remove();original.hidden=false;stage.classList.remove('rig-stage');mounted.delete(stage);
  }
  mounted.set(stage,cleanup);
  return cleanup;
}

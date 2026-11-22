/* 有機體 共用程式：載入畫面、細胞背景、文章列表。
   每頁先設定 window.SITE = { base, reports, tickers, types }，再載入本檔。 */
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const SITE=window.SITE||{};
const $=id=>document.getElementById(id);

/* loader：只有首頁有，0→100% 約 0.9 秒後滑走 */
(function(){const L=$('loader'),p=$('pct');if(!L)return;if(reduce){L.remove();return}
  const t0=performance.now();const f=now=>{const k=Math.min(1,(now-t0)/900);p.textContent=Math.round(k*100)+'%';if(k<1)requestAnimationFrame(f);else{L.classList.add('done');setTimeout(()=>L.remove(),1000)}};requestAnimationFrame(f);
  setTimeout(()=>{L.classList.add('done');setTimeout(()=>L.remove(),1000)},2500);})();

/* cells：橫條紋被緩慢呼吸的細胞膜裁切 */
function cells(c,blobs,opt){
  if(!c)return;
  const x=c.getContext('2d');let W,H,mx=.5,my=.5,tmx=.5,tmy=.5,vis=true;
  function size(){const d=Math.min(2,devicePixelRatio||1);W=c.clientWidth;H=c.clientHeight;c.width=W*d;c.height=H*d;x.setTransform(d,0,0,d,0,0)}
  size();addEventListener('resize',size);
  c.parentElement.addEventListener('pointermove',e=>{const r=c.getBoundingClientRect();tmx=(e.clientX-r.left)/r.width;tmy=(e.clientY-r.top)/r.height});
  if('IntersectionObserver' in window)new IntersectionObserver(es=>{vis=es[0].isIntersecting;if(vis&&!reduce)requestAnimationFrame(draw)}).observe(c);
  const R=(b,a,t)=>b.r*(1+.07*Math.sin(3*a+t*.5+b.ph)+.05*Math.sin(5*a-t*.35+b.ph*1.7)+.03*Math.sin(2*a+t*.8));
  function draw(t){
    t/=1000;mx+=(tmx-mx)*.04;my+=(tmy-my)*.04;x.clearRect(0,0,W,H);
    const S=opt.scale==='h'?H:Math.min(W,H),gap=opt.gap||6;
    for(const b of blobs){
      let cx=(b.cx+(mx-.5)*.03+(b.dx||0)*Math.sin(t*.12+b.ph))*W,cy=(b.cy+(my-.5)*.03+(b.dy||0)*Math.cos(t*.1+b.ph))*H;
      let k=1;if(opt.hover){const d=Math.hypot(cx-mx*W,cy-my*H)/S;k=1+.12*Math.max(0,1-d/ (b.r*2.2));}
      x.fillStyle=b.col;
      for(let y=0;y<H;y+=gap){const dy=(y-cy)/S;let l=null,r=null;
        for(let i=0;i<=72;i++){const a=i/72*Math.PI*2,rr=R(b,a,t)*k,py=Math.sin(a)*rr;
          if(Math.abs(py-dy)<rr*.06+.004){const X=cx+Math.cos(a)*rr*S;l=l===null?X:Math.min(l,X);r=r===null?X:Math.max(r,X)}}
        if(l!==null&&r-l>2)x.fillRect(l,y,r-l,Math.max(.8,1+2.2*(1-Math.abs(dy)/(b.r*k*1.1))))}
    }
    if(opt.grid){x.fillStyle='rgba(236,235,231,.16)';for(let y=0;y<H;y+=gap*3)x.fillRect(0,y,W,.6)}
    if(!reduce&&vis)requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}
cells($('org'),[{cx:.56,cy:.5,r:.36,ph:0,col:'rgba(236,235,231,.82)'},{cx:.34,cy:.62,r:.22,ph:2,col:'rgba(42,35,144,1)'},{cx:.78,cy:.3,r:.15,ph:4,col:'rgba(163,169,255,.9)'}],{grid:true});
(function(){const C=['rgba(184,183,175,.75)','rgba(42,35,144,1)','rgba(163,169,255,.85)','rgba(236,235,231,.6)'];const B=[];let seed=7;const rnd=()=>(seed=(seed*9301+49297)%233280)/233280;
  for(let i=0;i<10;i++){B.push({cx:.06+i/9*.88+(rnd()-.5)*.03,cy:.35+rnd()*.3,r:.08+rnd()*.12,ph:rnd()*6,col:C[i%4],dx:.01,dy:.04})}
  cells($('dish'),B,{scale:'h',hover:true,gap:5});})();
cells($('bg1'),[{cx:.9,cy:.12,r:.14,ph:1,col:'rgba(42,35,144,.10)',dx:.03,dy:.03},{cx:.08,cy:.42,r:.1,ph:3,col:'rgba(42,35,144,.08)',dx:.03,dy:.04},{cx:.95,cy:.62,r:.08,ph:5,col:'rgba(42,35,144,.09)',dx:.02,dy:.05},{cx:.3,cy:.95,r:.12,ph:2,col:'rgba(42,35,144,.07)',dx:.04,dy:.02}],{gap:6});
cells($('bg2'),[{cx:.12,cy:.2,r:.09,ph:1,col:'rgba(163,169,255,.10)',dx:.03,dy:.04},{cx:.88,cy:.9,r:.12,ph:4,col:'rgba(163,169,255,.08)',dx:.03,dy:.03}],{gap:6});

/* 文章列表：類型分頁、標的篩選、搜尋 */
(function(){
  const list=$('list');if(!list||!SITE.reports)return;
  const ZH={All:'全部',Deep:'個股深度',Preview:'財報前瞻',Review:'財報檢討',Industry:'產業研究',Deck:'簡報',Scorecard:'採信度盤'};
  const TYPES=SITE.types,TICKERS=SITE.tickers||{},base=SITE.base||'./';
  const tabs=$('tabs'),sel=$('tk'),q=$('q'),head=$('tkhead'),name=$('tkname'),empty=$('empty');
  let type='All';
  const R=[...SITE.reports].sort((a,b)=>b.date.localeCompare(a.date));
  const enc=p=>base+p.split('/').map(encodeURIComponent).join('/');
  const fmtDate=d=>d.replace(/-/g,'.');
  const used=[...new Set(R.flatMap(r=>r.tickers))].sort();
  used.forEach(t=>{const o=document.createElement('option');o.value=t;o.textContent=t+'　'+(TICKERS[t]||'');sel.appendChild(o)});
  function ticker(){const m=location.hash.match(/^#t-(.+)$/);return m?decodeURIComponent(m[1]):''}
  function counts(t){const c={};TYPES.forEach(k=>c[k]=0);R.forEach(r=>{if(t&&!r.tickers.includes(t))return;c.All++;c[r.type]++});return c}
  function render(){
    const t=ticker(),kw=q.value.trim().toLowerCase(),c=counts(t);
    tabs.innerHTML=TYPES.map(k=>`<button type="button" data-k="${k}" aria-pressed="${k===type}" title="${ZH[k]}">${k}<sup>${c[k]}</sup></button>`).join('');
    sel.value=t;head.hidden=!t;if(t)name.textContent='#'+t+'　'+(TICKERS[t]||'')+'　·　'+c.All+' 篇';
    const rows=R.filter(r=>(type==='All'||r.type===type)&&(!t||r.tickers.includes(t))&&(!kw||(r.title+' '+r.tickers.join(' ')+' '+r.tickers.map(x=>TICKERS[x]||'').join(' ')).toLowerCase().includes(kw)));
    list.innerHTML=rows.map(r=>`<div class="rep"><i class="cell a"></i><i class="cell b"></i><i class="cell c"></i><i class="cell d"></i>
      <span class="ty">${r.type}</span>
      <a class="ttl" href="${enc(r.href)}">${r.title}</a>
      <span class="tks">${r.tickers.map(x=>`<button type="button" class="tk" data-t="${x}" title="${TICKERS[x]||x}">#${x}</button>`).join('')}</span>
      <time>${fmtDate(r.date)}</time></div>`).join('');
    empty.hidden=rows.length>0;
  }
  tabs.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;type=b.dataset.k;render()});
  list.addEventListener('click',e=>{const b=e.target.closest('.tk');if(!b)return;location.hash='t-'+b.dataset.t;$('research').scrollIntoView({behavior:'smooth'})});
  list.addEventListener('pointermove',e=>{const el=e.target.closest('.rep');if(!el)return;const r=el.getBoundingClientRect();el.style.setProperty('--x',(e.clientX-r.left)+'px');el.style.setProperty('--y',(e.clientY-r.top)+'px')});
  sel.addEventListener('change',()=>{location.hash=sel.value?'t-'+sel.value:'research'});
  $('clr').addEventListener('click',()=>{location.hash='research'});
  q.addEventListener('input',render);addEventListener('hashchange',render);render();
})();

document.querySelectorAll('.row,.card').forEach(el=>el.addEventListener('pointermove',e=>{const r=el.getBoundingClientRect();el.style.setProperty('--x',(e.clientX-r.left)+'px');el.style.setProperty('--y',(e.clientY-r.top)+'px')}));

if(!reduce&&'IntersectionObserver' in window){
  const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.remove('pre');io.unobserve(e.target)}}),{threshold:.12});
  document.querySelectorAll('.rise').forEach(el=>{if(el.getBoundingClientRect().top>innerHeight){el.classList.add('pre');io.observe(el)}});
  setTimeout(()=>document.querySelectorAll('.rise.pre').forEach(el=>el.classList.remove('pre')),12000);
}

'use strict';
let me=null, worldId=null, tab='Lobby', playerPid=null, backTab='Auction', aucCache=null, sideCache=null;
// transfer market screen state: selected target club + a prefill from the player page
let trClub=null, trPrefill=null;
let focusPid=null, squadCache=null, squadSel=null;
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,o={}){const r=await fetch(p,{headers:{'Content-Type':'application/json'},...o});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d;}
function countdown(iso,serverNow){let ms=new Date(iso)-new Date(serverNow);if(ms<0)ms=0;const h=Math.floor(ms/36e5),m=Math.floor(ms%36e5/6e4),s=Math.floor(ms%6e4/1e3);return `${h}h ${m}m ${s}s`;}
function initials(name){return String(name||'?').split(/\s+/).map(x=>x[0]).join('').slice(0,3).toUpperCase();}
function crestHTML(name,cls){return `<span class="crest ${cls||''}"><span>${esc(initials(name))}</span></span>`;}

// ---- player portraits: role/rating based, hashed per-player variety ----
const PORTRAITS={
 'Batsman':['/assets/portrait-bat-star.jpg','/assets/portrait-bat-2.jpg'],
 'Bowler':['/assets/portrait-bowl-star.jpg','/assets/portrait-bowl-2.jpg'],
 'All-Rounder':['/assets/portrait-ar-star.jpg'],
 'Wicket-Keeper':['/assets/portrait-wk-star.jpg']};
function hashCode(s){let h=0;s=String(s||'');for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h;}
function portraitFor(p){if(!p)return null;if(p.photoUrl)return p.photoUrl;const set=PORTRAITS[p.role];if(!set)return null;const r=p.rating||0;
 if(r>=88||set.length===1)return set[0];
 return hashCode(p.worldPlayerId||p.id||p.name)%3===0?set[0]:set[1];}
function avatarHTML(p,cls){const src=portraitFor(p);
 if(src)return `<img class="avatar ${cls||''}" src="${src}" alt="" loading="lazy">`;
 return `<span class="avatar avatar-ini ${cls||''}">${esc(initials(p&&p.name))}<b>${(p&&p.rating)||''}</b></span>`;}
function pAvatar(a){return avatarHTML({...a.player,worldPlayerId:a.worldPlayerId});}
// ---- detailed tactics helpers (preferences, phases) ----
const PHASE_LABEL={powerplay:'Powerplay (1–6)',middle:'Middle (7–15)',death:'Death (16–20)'};
function phaseLabel(n){return PHASE_LABEL[n]||n;}
function cap1(s){return s?s[0].toUpperCase()+s.slice(1):s;}
function prefShort(p){if(!p)return '';const o=(p.prefOvers&&p.prefOvers.length)?' · '+p.prefOvers.map(n=>({powerplay:'PP',middle:'Mid',death:'Death'}[n]||n)).join('/') :'';return `Pref #${p.prefBatPos ?? '—'}${o}`;}
// Attribution for real Wikimedia Commons photos (detail page only).
function photoCreditHTML(p){if(!p||!p.photoUrl)return '';
 const inner=`Photo: ${esc(p.photoCredit||'Wikimedia Commons')}${p.photoLicense?' · '+esc(p.photoLicense):''}`;
 return `<div class="photocredit">${p.photoPage?`<a href="${esc(p.photoPage)}" target="_blank" rel="noopener">${inner}</a>`:inner}</div>`;}

// ---- nav persistence: refresh/reopen returns to the same screen ----
// The session itself is a 30-day JWT cookie (see COOKIE_OPTS in
// src/server.js), so a refresh keeps the user signed in; this block
// remembers WHERE they were (tab + world + player page) in
// localStorage so boot() can put them back instead of always landing
// on the Lobby. Keep this block self-contained (localStorage + the
// navigation globals only): test/api.test.js extracts and exercises it.
// [nav-persistence:start]
const NAV_KEY='cmw.nav.v1';
function saveNav(){try{localStorage.setItem(NAV_KEY,JSON.stringify({tab,worldId,playerPid,backTab,focusPid}));}catch{}}
function loadNav(){try{const s=JSON.parse(localStorage.getItem(NAV_KEY)||'null');return (s&&typeof s==='object'&&!Array.isArray(s))?s:null;}catch{return null;}}
function clearNav(){try{localStorage.removeItem(NAV_KEY);}catch{}}
// [nav-persistence:end]
// Restore the saved view after the session check. Anything stale —
// the world was deleted, the player is gone — falls back gracefully:
// player page -> its back tab, world view -> Lobby.
async function restoreNav(){const nav=loadNav();if(!nav||!nav.worldId)return;
 try{await api('/api/worlds/'+nav.worldId);}catch{return;}
 worldId=nav.worldId;backTab=nav.backTab||'Auction';focusPid=nav.focusPid||null;
 if(nav.tab==='Player'&&nav.playerPid){
  try{await api(`/api/worlds/${worldId}/players/${nav.playerPid}`);playerPid=nav.playerPid;tab='Player';}
  catch{tab=(backTab&&backTab!=='Player')?backTab:'Auction';}
 }else if(nav.tab&&nav.tab!=='Lobby'){tab=nav.tab;}}

// ---- auth ----
async function boot(){if(location.hash.includes('access_token=')){const h=new URLSearchParams(location.hash.slice(1));try{await api('/api/auth/google/session',{method:'POST',body:JSON.stringify({accessToken:h.get('access_token')})});}catch{}history.replaceState(null,'',location.pathname+location.search);}try{const d=await api('/api/auth/me');me=d.user;await restoreNav();showApp();}catch{$('#authView').classList.remove('hidden');}}
function authMode(reg){$('#tabSignIn').classList.toggle('on',!reg);$('#tabRegister').classList.toggle('on',reg);$('#loginBtn').classList.toggle('hidden',reg);$('#regBtn').classList.toggle('hidden',!reg);$('#mnameRow').classList.toggle('hidden',!reg);}
$('#tabSignIn').onclick=()=>authMode(false);
$('#tabRegister').onclick=()=>authMode(true);
$('#loginBtn').onclick=async()=>{try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})});me=d.user;showApp();}catch(e){$('#authErr').textContent=e.message;}};
$('#regBtn').onclick=async()=>{try{const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({name:$('#mname').value,email:$('#email').value,password:$('#password').value})});me=d.user;showApp();}catch(e){$('#authErr').textContent=e.message;}};
function showApp(){$('#authView').classList.add('hidden');$('#appView').classList.remove('hidden');$('#who').innerHTML=`<span class="mgr-ava">${esc(initials(me.name))}</span><span><span class="mgr-name">${esc(me.name)}</span> <span class="mgr-email">(${esc(me.email)})</span></span> <button class="secondary" onclick="logout()">Logout</button>`;renderTabs();render();}
window.logout=async()=>{clearNav();await api('/api/auth/logout',{method:'POST'});location.reload();};

// ---- sidebar menu: sections + SVG icons, active state, club header block ----
const IC={
 home:'<svg viewBox="0 0 24 24"><path d="M3 10.8 12 3l9 7.8"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-6h5v6"/></svg>',
 door:'<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="1.5"/><circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>',
 gavel:'<svg viewBox="0 0 24 24"><path d="M14.5 3.5 20.5 9.5 18 12l-6-6z"/><path d="m11 9-7.6 7.6a2.12 2.12 0 1 0 3 3L14 12"/><path d="M3 21.5h9"/></svg>',
 book:'<svg viewBox="0 0 24 24"><path d="M5 3h14v15H6.5A2.5 2.5 0 0 0 4 20.5v-15A2.5 2.5 0 0 1 6.5 3z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19"/></svg>',
 users:'<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.4"/><path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.1a3.4 3.4 0 0 1 0 5.8M18 15.3c1.7.9 2.7 2.5 3 4.7"/></svg>',
 target:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>',
 cal:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
 trophy:'<svg viewBox="0 0 24 24"><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.6A2.6 2.6 0 0 0 7 11M17 6h2.4A2.6 2.6 0 0 1 17 11"/><path d="M12 14v3.5M8.5 21h7M12 17.5 10.4 21h3.2z"/></svg>',
 coin:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><text x="12" y="16" text-anchor="middle" font-size="10.5" fill="currentColor" stroke="none" font-weight="700">₹</text></svg>',
 news:'<svg viewBox="0 0 24 24"><path d="M4 5h13v14H6.5A2.5 2.5 0 0 1 4 16.5z"/><path d="M17 9h3.2v7.5a2.5 2.5 0 0 1-2.5 2.5"/><path d="M7.5 9h6.5M7.5 13h6.5"/></svg>',
 clock:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/></svg>',
 mail:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.8 7.2 8.2 5.8 8.2-5.8"/></svg>',
 swap:'<svg viewBox="0 0 24 24"><path d="M4 7.5h13.5"/><path d="M14.5 4 18 7.5 14.5 11"/><path d="M20 16.5H6.5"/><path d="M9.5 13 6 16.5 9.5 20"/></svg>'};
const MENU=[
 {sec:'Home'},
 {key:'Home',icon:'home',label:'Home',worldOnly:true},
 {key:'Lobby',icon:'home',label:'Game World Lobby'},
 {key:'Waiting Room',icon:'door',label:'Waiting Room'},
 {sec:'Manage'},
 {key:'Auction',icon:'gavel',label:'Auction'},
 {key:'Players',icon:'book',label:'Player Database'},
 {key:'Squad',icon:'users',label:'Squad'},
 {key:'Transfers',icon:'swap',label:'Transfers & Offers',worldOnly:true},
 {key:'Tactics',icon:'target',label:'Captain & Tactics'},
 {sec:'World'},
 {key:'Fixtures',icon:'cal',label:'Fixtures'},
 {key:'League',icon:'trophy',label:'League Table'},
 {key:'Finance',icon:'coin',label:'Finance'},
 {key:'News',icon:'news',label:'News'},
 {key:'History',icon:'clock',label:'History'},
 {key:'Messages',icon:'mail',label:'Messages'},
];
function renderTabs(){$('#tabs').innerHTML=MENU.filter(m=>!m.worldOnly||worldId).map(m=>m.sec?`<div class="msec">${esc(m.sec)}</div>`:`<button class="${m.key===tab||(tab==='Player'&&m.key===backTab)?'on':''}" onclick="go('${m.key}')">${IC[m.icon]||''} ${esc(m.label)}</button>`).join('');paintClubBlock();}
function paintClubBlock(){const el=$('#clubBlock');if(!el)return;const chip=$('#clubChip');
 if(sideCache&&sideCache.clubName){el.innerHTML=`${crestHTML(sideCache.clubName)}<div class="cname">${esc(sideCache.clubName)}</div><div class="cbudget">₹${sideCache.budget} Cr</div><div class="cworld">${esc(sideCache.worldName||'')}</div>`;
  if(chip){chip.classList.remove('hidden');chip.innerHTML=`<span class="mini-crest">${esc(initials(sideCache.clubName))}</span><span class="chip-name">${esc(sideCache.clubName)}</span><span class="chip-budget">₹${sideCache.budget} Cr</span>`;}}
 else{el.innerHTML=`${crestHTML(me?me.name:'?')}<div class="cname">${esc(me?me.name:'')}</div><div class="cworld">${worldId?'No club in this world yet':'Open a world from the Lobby'}</div>`;
  if(chip){chip.classList.add('hidden');chip.innerHTML='';}}}
async function refreshClubBlock(){if(!worldId){sideCache=null;paintClubBlock();return;}
 try{const d=await api('/api/worlds/'+worldId);sideCache=d.myMembership?{clubName:d.myMembership.clubName,budget:d.myMembership.budget,worldName:d.world.name}:null;paintClubBlock();}catch{}}
window.go=t=>{tab=t;renderTabs();render();};
window.openPlayer=(pid,from)=>{if(!worldId)return;playerPid=pid;backTab=from||tab;tab='Player';renderTabs();render();};
window.focusAuction=pid=>{focusPid=pid;render();};
window.adjustBid=(id,delta)=>{const el=document.getElementById('bid-'+id);if(!el)return;const v=Math.round(((parseFloat(el.value)||0)+delta)*10)/10;el.value=v>0?v.toFixed(1):'';};
window.selectSquadPlayer=pid=>{squadSel=pid;document.querySelectorAll('#squadTable tr[data-pid]').forEach(tr=>tr.classList.toggle('sel',tr.dataset.pid===pid));const p=(squadCache&&squadCache.squad||[]).find(x=>x.worldPlayerId===pid);const host=$('#squadPanel');if(p&&host)host.innerHTML=squadPanelHTML(p,squadCache);};

function squadPanelHTML(p,d){const inXI=d.xi.includes(p.worldPlayerId);
 return `<div class="pcard-img">${avatarHTML(p,'lg')}<span class="ovr big focus-ovr">${p.rating}<small>OVR</small></span></div>
 <div class="focus-name">${esc(p.name)} ${p.isCaptain?'<span class="badge cap">© Captain</span>':''}${p.isViceCaptain?'<span class="badge cap">VC</span>':''}</div>
 <div class="focus-sub">${esc(p.role)} · ${esc(p.nationality)} · Age ${p.age ?? '—'}</div>
 <div style="margin-top:8px">
 <div class="kv"><span>Role</span><b>${esc(p.role)}</b></div>
 <div class="kv"><span>Nationality</span><b>${esc(p.nationality)}</b></div>
 <div class="kv"><span>Batting</span><b>${p.batting}</b></div>
 <div class="kv"><span>Bowling</span><b>${p.bowling}</b></div>
 <div class="kv"><span>Leadership</span><b>${p.leadership}</b></div>
 <div class="kv"><span>Prefers to bat</span><b>#${p.prefBatPos ?? '—'}</b></div>
 <div class="kv"><span>Preferred overs</span><b>${(p.prefOvers&&p.prefOvers.length)?p.prefOvers.map(phaseLabel).join(' + '):'—'}</b></div>
 <div class="kv"><span>Default approach</span><b>${esc(cap1(p.approach||'balanced'))}</b></div>
 <div class="kv"><span>Form / Fitness / Morale</span><b>${p.form} / ${p.fitness} / ${p.morale}</b></div>
 <div class="kv"><span>Value</span><span class="goldv">${p.baseValue!=null?'₹'+p.baseValue+' Cr':'—'}</span></div>
 <div class="kv"><span>Status</span><b>${inXI?'Playing XI':'Squad'}</b></div></div>
 <div class="bidform" style="margin-top:10px"><button class="secondary" onclick="cap('${p.worldPlayerId}','captain')">Captain</button>
 <button class="secondary" onclick="cap('${p.worldPlayerId}','vice')">Vice-captain</button>
 <button onclick="openPlayer('${p.worldPlayerId}','Squad')">Player page →</button></div>`;}

function squadTableHTML(d){return `<div class="tblwrap"><table id="squadTable"><tr><th>XI</th><th>Player</th><th>Role</th><th>OVR</th><th>Age</th><th>Value</th><th>Status</th><th>Form</th><th></th></tr>
   ${d.squad.map(p=>`<tr class="clickable ${p.worldPlayerId===squadSel?'sel':''}" data-pid="${p.worldPlayerId}" onclick="selectSquadPlayer('${p.worldPlayerId}')"><td onclick="event.stopPropagation()"><input type="checkbox" class="xi" value="${p.worldPlayerId}" ${d.xi.includes(p.worldPlayerId)?'checked':''} style="width:auto"></td>
   <td><span class="pcell">${avatarHTML(p)}<span><span class="pname">${esc(p.name)}</span> ${p.isCaptain?'<span class="badge cap">©</span>':''}${p.isViceCaptain?'<span class="badge cap">VC</span>':''}<br><span class="psub">${esc(p.nationality)} · ${prefShort(p)}</span></span></span></td>
   <td>${esc(p.role)}</td><td><span class="ovr">${p.rating}</span></td><td>${p.age ?? '—'}</td><td>${p.baseValue!=null?'₹'+p.baseValue+' Cr':'—'}</td><td>${d.xi.includes(p.worldPlayerId)?'Playing XI':'Squad'}</td><td>${p.form}</td>
   <td onclick="event.stopPropagation()"><button class="secondary" onclick="cap('${p.worldPlayerId}','captain')">Captain</button> <button class="secondary" onclick="cap('${p.worldPlayerId}','vice')">Vice-captain</button></td></tr>`).join('')}</table></div>`;}

// ---- detailed tactics editors (Captain & Tactics screen) ----
let tacOrder=[], tacPlan={}, tacApproach={};
const bowlEligible=p=>p.role==='Bowler'||p.role==='All-Rounder'||(p.bowling||0)>=60;
function tacPlayer(pid){return (squadCache&&squadCache.squad||[]).find(p=>p.worldPlayerId===pid);}
function initTacState(d){const xiSet=new Set(d.xi);const saved=(d.tactics&&d.tactics.battingOrder)||[];
 tacOrder=saved.filter(pid=>xiSet.has(pid));
 const rest=d.xi.filter(pid=>!tacOrder.includes(pid)).map(tacPlayer).filter(Boolean)
   .sort((a,b)=>(a.prefBatPos||11)-(b.prefBatPos||11)||(b.batting||0)-(a.batting||0));
 tacOrder=[...tacOrder,...rest.map(p=>p.worldPlayerId)];
 tacPlan={};Object.entries((d.tactics&&d.tactics.bowlingPlan)||{}).forEach(([pid,e])=>{tacPlan[pid]={pp:e.pp||0,mid:e.mid||0,death:e.death||0};});
 tacApproach={};d.xi.forEach(pid=>{const p=tacPlayer(pid);tacApproach[pid]=((d.tactics&&d.tactics.playerApproach)||{})[pid]||(p&&p.approach)||'balanced';});}
function tacOrderHTML(){if(!tacOrder.length)return '<p>Tick a playing XI in the squad table above first.</p>';
 return tacOrder.map((pid,i)=>{const p=tacPlayer(pid);if(!p)return '';const diff=Math.abs((i+1)-(p.prefBatPos||i+1));
  const fit=diff<=1?'<span class="badge" style="color:#7ee2a0">✓ happy</span>':`<span class="badge" style="color:#ffb35c">⚠ prefers #${p.prefBatPos}</span>`;
  return `<div class="tacrow"><span class="tacpos">${i+1}</span>${avatarHTML(p)}<span class="tacname">${esc(p.name)}<br><span class="psub">${esc(p.role)} · Bat ${p.batting} · ${prefShort(p)}</span></span>${fit}
  <select class="tacappr" onchange="setApproach('${pid}',this.value)">${['aggressive','balanced','defensive'].map(a=>`<option value="${a}" ${tacApproach[pid]===a?'selected':''}>${cap1(a)}</option>`).join('')}</select>
  <span class="tacmv"><button class="secondary" onclick="moveTac(${i},-1)" ${i===0?'disabled':''}>▲</button><button class="secondary" onclick="moveTac(${i},1)" ${i===tacOrder.length-1?'disabled':''}>▼</button></span></div>`;}).join('');}
function tacPlanTotals(){const t={pp:0,mid:0,death:0};Object.values(tacPlan).forEach(e=>{t.pp+=e.pp||0;t.mid+=e.mid||0;t.death+=e.death||0;});t.total=t.pp+t.mid+t.death;return t;}
function tacPlanHTML(d){const elig=d.xi.map(tacPlayer).filter(p=>p&&bowlEligible(p));
 if(!elig.length)return '<p>No bowlers in your XI yet — tick bowlers/all-rounders in the squad table and save.</p>';
 const rows=elig.map(p=>{const e=tacPlan[p.worldPlayerId]||{pp:0,mid:0,death:0};const tot=(e.pp||0)+(e.mid||0)+(e.death||0);
  const cell=(ph)=>`<span class="stepper sm"><button onclick="bowlStep('${p.worldPlayerId}','${ph}',-1)">−</button><b>${e[ph]||0}</b><button onclick="bowlStep('${p.worldPlayerId}','${ph}',1)">+</button></span>`;
  return `<div class="tacrow"><span class="tacname" style="flex:1">${esc(p.name)}<br><span class="psub">Bowl ${p.bowling} · Pref: ${(p.prefOvers&&p.prefOvers.length)?p.prefOvers.map(phaseLabel).join(' + '):'—'}</span></span>
  <span class="tacph">PP ${cell('pp')}</span><span class="tacph">Mid ${cell('mid')}</span><span class="tacph">Death ${cell('death')}</span><span class="tactot">${tot}/4</span></div>`;}).join('');
 const t=tacPlanTotals();const warn=(t.pp>6||t.mid>9||t.death>5||t.total>20)?' style="color:#ffb35c"':'';
 return rows+`<p${warn}>Totals — Powerplay <b>${t.pp}/6</b> · Middle <b>${t.mid}/9</b> · Death <b>${t.death}/5</b> · All overs <b>${t.total}/20</b>${t.total<20?` · the remaining ${20-t.total} over(s) go to your other bowlers automatically`:''}</p>`;}
window.moveTac=(i,dir)=>{const j=i+dir;if(j<0||j>=tacOrder.length)return;[tacOrder[i],tacOrder[j]]=[tacOrder[j],tacOrder[i]];const h=$('#tacOrder');if(h)h.innerHTML=tacOrderHTML();};
window.setApproach=(pid,val)=>{tacApproach[pid]=val;};
window.bowlStep=(pid,ph,delta)=>{const e=tacPlan[pid]||(tacPlan[pid]={pp:0,mid:0,death:0});const tot=(e.pp||0)+(e.mid||0)+(e.death||0);
 const nv=(e[ph]||0)+delta;if(nv<0||nv>4)return;if(delta>0&&tot>=4)return;e[ph]=nv;const h=$('#tacPlan');if(h&&squadCache)h.innerHTML=tacPlanHTML(squadCache);};

async function render(){saveNav();const v=$('#view');$('#err').textContent='';refreshClubBlock();
 try{
  if(tab==='Lobby'){const d=await api('/api/worlds');
   v.innerHTML=`<div class="panel"><h2>Game World Lobby</h2><div class="tblwrap"><table><tr><th>World</th><th>Creator</th><th>Managers</th><th>Status</th><th>Start</th><th>Format</th><th></th></tr>
   ${d.worlds.map(w=>`<tr><td><b>${esc(w.name)}</b> ${w.isPrivate?'<span class="lock">🔒 Private</span>':''} ${w.aiFill?'🤖':''} ${w.squadMode==='draft'?'<span class="pill">⚖️ Draft</span>':''}</td><td>${esc(w.creatorName)}</td><td>${w.managersCount}/${w.numberOfClubs}</td><td><span class="pill">${esc(w.state)}</span></td><td>${new Date(w.startDate).toLocaleString()}</td><td>${esc(w.format)}</td><td><button onclick="openWorld('${w.id}')">View / Join</button></td></tr>`).join('')}</table></div></div>
   <div class="panel"><h3>Create World</h3>
   <div class="formgrid">
   <span><label>World name</label><input id="wname" placeholder="World name"></span>
   <span><label>Description</label><input id="wdesc" placeholder="Description"></span>
   <span><label>Number of clubs</label><input id="wnum" type="number" value="10" min="2" max="10"></span>
   <span><label>Format</label><input id="wfmt" value="League (Home & Away)"></span>
   <span><label>Match interval (days)</label><input id="wint" type="number" value="3" min="1" max="7"></span>
   <span><label>Match time</label><input id="wtime" value="20:00"></span>
   <span><label>World start</label><input id="wstart" type="datetime-local"></span>
   <span><label>Auction start</label><input id="wauc" type="datetime-local"></span>
   <span><label>Season start</label><input id="wseason" type="datetime-local"></span>
   <span><label>World password (optional — stored hashed, never shown)</label><input id="wpass" type="password"></span>
   <span><label>Squad mode</label><select id="wmode"><option value="auction">Auction — empty squads, bid for players</option><option value="draft">Draft — squads distributed equally, then trade</option></select></span>
   </div>
   <label class="chk"><input type="checkbox" id="waifill" checked> Fill empty clubs with AI managers (world can be started any time)</label><br>
   <button class="goldbtn" onclick="createWorld()">Create World</button></div>`;}
  else if(!worldId){v.innerHTML='<div class="panel">Open a world from the Lobby first.</div>';}
  else if(tab==='Home'){const d=await api('/api/worlds/'+worldId);const w=d.world;const club=d.myMembership?d.myMembership.clubName:null;
   const [fx,sq,lg]=await Promise.all([api(`/api/worlds/${worldId}/fixtures`).catch(()=>null),api(`/api/worlds/${worldId}/squad`).catch(()=>null),api(`/api/worlds/${worldId}/league`).catch(()=>null)]);
   const fixtures=fx?fx.fixtures:[];const played=fixtures.filter(f=>f.result).length;
   const upcoming=fixtures.filter(f=>!f.result).slice().sort((a,b)=>new Date(a.scheduledAt)-new Date(b.scheduledAt));
   const next=upcoming.find(f=>club&&(f.homeClub===club||f.awayClub===club))||upcoming[0];
   const avg=sq&&sq.squad.length?Math.round(sq.squad.reduce((s,p)=>s+(p.rating||0),0)/sq.squad.length):0;
   const val=sq?sq.squad.reduce((s,p)=>s+(+p.baseValue||0),0):0;
   const pct=fixtures.length?Math.round(played/fixtures.length*100):0;
   v.innerHTML=`<div class="welcome"><div class="welcome-in"><h2>Welcome Back, <span>${esc(me.name)}</span></h2>
   <p>${club?`${crestHTML(club,'sm')} <b>${esc(club)}</b> · `:''}${esc(w.name)} · <span class="pill goldp">${esc(w.state)}</span></p></div></div>
   ${d.myMembership?'':`<div class="panel"><h3>No club yet</h3><p>You haven't joined a club in this world yet.</p><button class="goldbtn" onclick="go('Waiting Room')">Pick your club →</button></div>`}
   <div class="widgets">
   <div class="panel"><h3>🛡 Next Match</h3>${next?`<div class="vsrow"><div class="vsclub">${crestHTML(next.homeClub)}<span>${esc(next.homeClub)}</span></div><div class="vsmid">VS</div><div class="vsclub">${crestHTML(next.awayClub)}<span>${esc(next.awayClub)}</span></div></div>
   <p style="text-align:center;margin:4px 0">Round ${next.round} · ${new Date(next.scheduledAt).toLocaleString()} ${esc(next.timezone||'')}${next.locked?'<br>🔒 XI locked':''}</p>
   <button style="width:100%" onclick="go('Fixtures')">Match Centre</button>`:'<p>No upcoming fixtures — the season may not have started yet.</p>'}</div>
   <div class="panel"><h3>📊 Team Overview</h3>${sq?`<div class="rings">
   <div><div class="ring" style="--p:${avg}"><span>${avg}</span></div><div class="ringlab">Team OVR</div></div>
   <div><div class="ring" style="--p:${Math.round(sq.squad.length/25*100)}"><span>${sq.squad.length}</span></div><div class="ringlab">Players</div></div>
   <div><div class="ring" style="--p:100"><span style="font-size:13px">₹${val.toFixed(1)}<small> Cr</small></span></div><div class="ringlab">Squad Value</div></div></div>
   <p style="text-align:center;margin:8px 0 0">Budget remaining: <b style="color:var(--gold)">₹${sq.budget} Cr</b></p>`:'<p>Join a club to see your team overview.</p>'}</div>
   <div class="panel"><h3>🏆 League — Top 5</h3>${lg&&lg.table.length?`<div class="tblwrap"><table><tr><th>#</th><th>Club</th><th>P</th><th>W</th><th>L</th><th>Pts</th></tr>
   ${lg.table.slice(0,5).map((r,i)=>`<tr class="${club&&r.clubName===club?'mine':''}"><td>${i+1}</td><td>${esc(r.clubName)}</td><td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td><b>${r.points}</b></td></tr>`).join('')}</table></div>
   <button class="secondary" style="width:100%;margin-top:9px" onclick="go('League')">Full Table</button>`:'<p>No league table yet.</p>'}
   <h3 style="margin-top:14px">📈 Season Progress</h3>
   <p style="margin:2px 0">${played} / ${fixtures.length} matches played · Season starts ${new Date(w.seasonStartAt).toLocaleString()}</p>
   <div class="progress"><i style="width:${pct}%"></i></div>
   <p style="margin:2px 0">Matches every ${w.matchIntervalDays} days at ${esc(w.matchTime)} (${esc(w.timezone)})</p></div>
   </div>`;}
  else if(tab==='Waiting Room'){const d=await api('/api/worlds/'+worldId);const w=d.world;const canStart=w.creatorId===me.id&&['CREATED','RECRUITING'].includes(w.state);
   v.innerHTML=`<div class="panel"><h2>World Waiting Room — ${esc(w.name)}</h2><p>Status: <span class="pill">${esc(w.state)}</span> · Managers: ${w.managersCount}/${w.numberOfClubs} · Server time: ${new Date(d.serverNow).toLocaleString()}</p>
   <p>World start: ${new Date(w.startDate).toLocaleString()} · Auction: ${new Date(w.auctionStartAt).toLocaleString()} · Season: ${new Date(w.seasonStartAt).toLocaleString()}</p>
   <p>Rules: ${w.squadMode==='draft'?'Squads are <b>distributed equally</b> when the world starts (20 players per club, balanced by rating and role) — no auction; trade with other clubs afterwards in Transfers &amp; Offers.':'Squads start <b>empty</b>, 24-hour auctions,'} budget ₹100 Cr each, squads of 18–25 players, matches every ${w.matchIntervalDays} days at ${esc(w.matchTime)} (${esc(w.timezone)}), no Play Match button — fixtures auto-simulate at their scheduled server time.</p>
   <h3>Joined managers</h3><div class="members">${d.members.map(m=>`<div class="member">${crestHTML(m.clubName,'sm')}<span><div class="mclub">${esc(m.clubName)}</div><div class="mmgr">${esc(m.managerName)}${m.ai?' <span class="aitag">🤖 AI</span>':''}</div></span></div>`).join('')||'<p>None yet</p>'}</div>
   ${d.myMembership?'':`<h3 style="margin-top:14px">Select your club</h3><div class="clubpick">${d.availableClubs.map(c=>`<label><input type="radio" name="club" value="${esc(c)}">${crestHTML(c,'sm')} ${esc(c)}</label>`).join('')}</div>
   ${w.isPrivate?'<label>World password</label><input id="jpass" type="password">':''}<button class="goldbtn" onclick="joinWorld()">Join World</button>`}</div>
   ${canStart?`<div class="gold"><h3>▶ Start World Now</h3>
   <p>The world normally starts when its scheduled time arrives${w.managersCount<w.numberOfClubs?' or the room fills':''} — as creator you can start it right now, whatever the count.${w.aiFill?'<br>🤖 <b>AI managers will fill every empty club</b> and bid in the auction alongside you.':''}</p>
   ${d.myMembership?`<button class="goldbtn" onclick="startWorld()">▶ Start World Now</button>`:'<p><b>Join a club above first</b> — the creator must hold a club to start the world.</p>'}</div>`:''}`;}
  else if(tab==='Auction'){const d=await api(`/api/worlds/${worldId}/auction`);aucCache=d;
   const foc=d.auctions.find(a=>a.worldPlayerId===focusPid)||d.auctions.find(a=>a.status==='OPEN')||d.auctions[0];
   focusPid=foc?foc.worldPlayerId:null;
   let det=null;if(foc){try{det=await api(`/api/worlds/${worldId}/players/${foc.worldPlayerId}`);}catch{}}
   const fp=det?det.player:(foc?foc.player:null);
   const myValid=det?(det.bids||[]).some(b=>b.mine&&b.status==='VALID'):false;
   const recentBids=det?(det.bids||[]).slice(0,6):[];
   const nextBid=foc?(foc.highestBid?Math.round((foc.currentPrice+0.5)*10)/10:foc.baseValue):0;
   v.innerHTML=`<div class="panel"><h2>🔨 Player Auction Market <small>(world state: ${esc(d.state)})</small></h2>
   <p>Click a player in the list to focus them here, or click their name for the full page with bid history. Countdowns come from stored <code>auctionEndsAt</code> + server time (${new Date(d.serverNow).toLocaleString()}); auctions settle automatically at expiry. Tick <b>Undisclosed</b> to hide your bid amount and identity — the current price stays public.</p>
   <input id="afilter" placeholder="Filter by player name…" oninput="filterAuctions(this.value)" style="margin-bottom:0"></div>
   ${foc?`<div class="auc-grid">
   <div class="panel auc-focus"><h3>Current Player</h3>
     <div class="focus-img">${avatarHTML({...fp,worldPlayerId:foc.worldPlayerId},'lg')}<span class="ovr big focus-ovr">${fp.rating}<small>OVR</small></span></div>
     <div class="focus-name">${esc(fp.name)}</div>
     <div class="focus-sub">${esc(fp.role)} · ${esc(fp.nationality)} · Age ${fp.age ?? '—'}</div>
     <div style="margin-top:8px">
     <div class="kv"><span>Base Price</span><b>₹${foc.baseValue} Cr</b></div>
     <div class="kv"><span>Current Bid</span><span class="goldv">${foc.highestBid?'₹'+foc.currentPrice+' Cr':'No bids yet'}</span></div>
     <div class="kv"><span>Leader</span><b>${foc.highestBid?(foc.leaderUndisclosed?'<span class="undisc">Undisclosed</span>':esc(foc.highestBidderClub)):'—'}</b></div>
     <div class="kv"><span>Status</span><span class="pill">${esc(foc.status)}</span></div></div>
     <button style="width:100%;margin-top:10px" onclick="openPlayer('${foc.worldPlayerId}','Auction')">Full player page →</button></div>
   <div class="panel auc-bid"><h3>Bidding</h3>
     ${foc.status==='OPEN'?`<label>Your bid ₹ Cr</label>
     <div class="bidrow"><span class="stepper"><button onclick="adjustBid('${foc.auctionId}',-0.5)">−</button><input id="bid-${foc.auctionId}" type="number" step="0.1" value="${nextBid}"><button onclick="adjustBid('${foc.auctionId}',0.5)">+</button></span></div>
     <label class="chk"><input type="checkbox" id="undis-${foc.auctionId}"> Undisclosed bid (hide amount &amp; identity)</label><br>
     <button class="bidbtn" style="width:100%;padding:11px;font-size:15px" onclick="bid('${foc.auctionId}')">Place Bid</button>
     <div class="bidrow" style="margin-top:8px">${myValid?`<button class="secondary" style="flex:1" onclick="withdrawBid('${foc.auctionId}')">Withdraw my bid</button>`:''}<button class="secondary" style="flex:1" onclick="watch('${foc.auctionId}')">${foc.watched?'★ Watching':'☆ Watchlist'}</button></div>
     <div class="timeleft">${countdown(foc.auctionEndsAt,d.serverNow)}</div><div class="timeleft-lab">Time Left · ends ${new Date(foc.auctionEndsAt).toLocaleString()}</div>`
     :`<p>This auction has closed.</p><div class="kv"><span>Final price</span><span class="goldv">${foc.highestBid?'₹'+foc.currentPrice+' Cr':'Unsold'}</span></div><div class="kv"><span>Winner</span><b>${foc.ownerClub?esc(foc.ownerClub):(foc.highestBidderClub?esc(foc.highestBidderClub):'—')}</b></div>`}
     <h3 style="margin-top:16px">Recent Bids</h3>
     ${recentBids.length?`<div class="tblwrap"><table><tr><th>Club</th><th>Bid</th><th>Time</th></tr>${recentBids.map(b=>`<tr><td>${b.undisclosed&&!b.mine?'<span class="undisc">Undisclosed</span>':esc(b.clubName)}${b.mine?' (you)':''}</td><td>${b.amount==null?'<span class="undisc">Undisclosed</span>':'₹'+b.amount+' Cr'}</td><td>${new Date(b.createdAt).toLocaleTimeString()}</td></tr>`).join('')}</table></div>`:'<p>No bids yet on this player.</p>'}
   </div>
   <div class="panel auc-list"><h3>Auctions (${d.auctions.length})</h3><div class="auc-list-rows" id="aucList">${auctionListRows(d.auctions,d.serverNow)}</div></div>
   </div>`:'<div class="panel">No auctions in this world yet.</div>'}`;}
  else if(tab==='Players'){const d=await api(`/api/worlds/${worldId}/auction`);aucCache=d;
   v.innerHTML=`<div class="panel"><h2>📚 Player Database</h2><p>Every player in this world's central pool. Click a player for their page: full ratings, auction status and complete bid history.</p>
   <input id="afilter" placeholder="Filter by player name…" oninput="filterPlayers(this.value)" style="margin-bottom:0"></div>
   <div class="panel"><div class="tblwrap"><table><thead><tr><th>Player</th><th>Role</th><th>Nat</th><th>Age</th><th>OVR</th><th>Bat</th><th>Bowl</th><th>Lead</th><th>Base ₹ Cr</th><th>Market</th><th>Owner / Price</th></tr></thead><tbody id="aucBody">${playerRows(d.auctions)}</tbody></table></div><p class="dbfoot">Some player photos via Wikimedia Commons (CC licenses); generated artwork for others.</p></div>`;}
  else if(tab==='Player'){const d=await api(`/api/worlds/${worldId}/players/${playerPid}`);const p=d.player,a=d.auction;const myValid=(d.bids||[]).some(b=>b.mine&&b.status==='VALID');
   v.innerHTML=`<div class="panel"><button class="secondary" onclick="go('${backTab}')">← Back</button>
   <div class="phead" style="margin-top:12px"><div style="width:190px;flex:none"><div class="pcard-img">${avatarHTML(p,'lg')}<span class="ovr big focus-ovr">${p.rating}<small>OVR</small></span></div>${photoCreditHTML(p)}</div>
   <div class="pinfo"><div class="big">${esc(p.name)}</div><div class="focus-sub">${esc(p.role)} · ${esc(p.nationality)} · Age ${p.age ?? '—'}</div>
   <div style="margin-top:6px">${p.ownerClub?`Owned by <b>${esc(p.ownerClub)}</b>${p.ownerMembershipId&&d.myMembership&&p.ownerMembershipId!==d.myMembership.id?` <button class="goldbtn" style="margin-left:8px" onclick="openTransferFor('${p.worldPlayerId}','${p.ownerMembershipId}')">Make Offer</button>`:''}`:'In the central market'}</div>
   <div class="statgrid">
     <div class="stat">Rating<b>${p.rating}</b></div><div class="stat">Batting<b>${p.batting}</b></div><div class="stat">Bowling<b>${p.bowling}</b></div>
     <div class="stat">Leadership<b>${p.leadership}</b></div><div class="stat">Base price<b>₹${p.baseValue} Cr</b></div>
     <div class="stat">Form<b>${p.form}</b></div><div class="stat">Fitness<b>${p.fitness}</b></div><div class="stat">Morale<b>${p.morale}</b></div>
     <div class="stat">Prefers to bat<b>#${p.prefBatPos ?? '—'}</b></div><div class="stat">Preferred overs<b style="font-size:12px">${(p.prefOvers&&p.prefOvers.length)?p.prefOvers.map(phaseLabel).join(' + '):'—'}</b></div><div class="stat">Approach<b>${esc(cap1(p.approach||'balanced'))}</b></div>
   </div>
   <p style="margin-top:8px"><small>Players perform best in their preferred batting position and bowling phases — using them far from their preferences costs morale and form after the match (see the tactics report in the match result).</small></p></div></div></div>
   ${a?`<div class="panel"><h3>🔨 Auction</h3>
   <p>Status: <span class="pill">${esc(a.status)}</span> · Current price: <b style="color:var(--gold)">₹${a.currentPrice} Cr</b> · Leader: ${a.highestBid?(a.leaderUndisclosed?'<span class="undisc">Undisclosed</span>':esc(a.highestBidderClub)):'No bids yet'}
   <br>Ends: ${new Date(a.auctionEndsAt).toLocaleString()} (${countdown(a.auctionEndsAt,d.serverNow)} left) · ${a.bidsCount} bid(s)</p>
   ${a.status==='OPEN'?`<div class="bidform"><span><label>Your bid ₹ Cr</label><br><input id="bid-${a.auctionId}" class="inline-num" type="number" step="0.1" placeholder="₹ Cr"></span>
   <label class="chk"><input type="checkbox" id="undis-${a.auctionId}"> Undisclosed bid</label>
   <button class="bidbtn" onclick="bid('${a.auctionId}')">Place bid</button>
   ${myValid?`<button class="secondary" onclick="withdrawBid('${a.auctionId}')">Withdraw my bid</button>`:''}
   <button class="secondary" onclick="watch('${a.auctionId}')">${a.watched?'★ Watching':'☆ Watchlist'}</button></div>
   <p><small>Withdrawing removes your highest bid; the leader and price are recalculated from the remaining bids, and you may bid again. Squads must hold 18–25 players — bids that would leave you unable to afford an 18-player squad are rejected.</small></p>`:'<p>This auction has closed.</p>'}
   </div>
   <div class="panel"><h3>Bid History</h3>
   ${d.bids.length?`<div class="tblwrap"><table><tr><th>Time</th><th>Manager</th><th>Club</th><th>Amount ₹ Cr</th><th>Status</th></tr>
   ${d.bids.map(b=>`<tr><td>${new Date(b.createdAt).toLocaleString()}</td><td>${b.undisclosed&&!b.mine?'<span class="undisc">Undisclosed</span>':esc(b.managerName)}${b.mine?' (you)':''}</td><td>${b.undisclosed&&!b.mine?'<span class="undisc">Undisclosed</span>':esc(b.clubName)}</td><td>${b.amount==null?'<span class="undisc">Undisclosed</span>':'₹'+b.amount}</td><td>${esc(b.status)}</td></tr>`).join('')}</table></div>`:'<p>No bids yet.</p>'}
   </div>`:'<div class="panel">No auction for this player.</div>'}`;}
  else if(tab==='Squad'){const d=await api(`/api/worlds/${worldId}/squad`);squadCache=d;
   if(!d.squad.some(p=>p.worldPlayerId===squadSel))squadSel=(d.squad.find(p=>p.isCaptain)||d.squad.slice().sort((a,b)=>b.rating-a.rating)[0]||{}).worldPlayerId||null;
   const sel=d.squad.find(p=>p.worldPlayerId===squadSel);
   v.innerHTML=`<div class="split">
   <div class="panel"><h2>${esc(d.clubName)} — Squad (${d.squad.length} players) · Budget ₹${d.budget} Cr</h2>
   ${d.squad.length?'':'<p>Your squad is empty. Win players in the Auction.</p>'}
   ${squadTableHTML(d)}
   <p>Tick up to 11 players above as your Playing XI, then save. Captaincy lifts that player's morale and adds a chemistry/performance modifier in the match engine. Set the batting order, bowling phases and per-player approach on the <b>Captain &amp; Tactics</b> screen.</p>
   <label>Batting approach</label><select id="tbat"><option>Balanced</option><option>Aggressive</option><option>Defensive</option></select>
   <button class="goldbtn" onclick="saveXI()">Save XI & Tactics</button></div>
   <div class="panel" id="squadPanel">${sel?squadPanelHTML(sel,d):'<h3>Player</h3><p>No players yet — win some in the Auction.</p>'}</div>
   </div>`;$('#tbat').value=d.tactics.battingApproach||'Balanced';}
  else if(tab==='Tactics'){const d=await api(`/api/worlds/${worldId}/squad`);squadCache=d;initTacState(d);
   v.innerHTML=`<div class="panel"><h2>🎯 Captain &amp; Tactics — ${esc(d.clubName)}</h2>
   <p>Pick your XI, then set <b>where everyone bats</b>, <b>who bowls which overs</b> and <b>how each player plays</b>. Players used far from their preferred position/phases lose morale and form after the match — the match report carries a tactics report. Everything locks 30 minutes before your next match. If you change the XI ticks, save once and the editors below rebuild for the new XI.</p>
   ${squadTableHTML(d)}
   <label>Team batting approach</label><select id="tbat"><option>Balanced</option><option>Aggressive</option><option>Defensive</option></select></div>
   <div class="split">
   <div class="panel"><h3>🏏 Batting order &amp; player approach</h3><p>Move players with ▲▼. Each player's own approach sits next to their name — aggressive scores faster but risks their wicket.</p><div id="tacOrder">${tacOrderHTML()}</div></div>
   <div class="panel"><h3>🎳 Bowling plan — who bowls which overs</h3><p>Phases: <b>PP</b> overs 1–6 (max 6), <b>Mid</b> 7–15 (max 9), <b>Death</b> 16–20 (max 5). No bowler can bowl more than 4 overs. Bowlers are happiest bowling their preferred phases.</p><div id="tacPlan">${tacPlanHTML(d)}</div></div>
   </div>
   <div class="panel"><h3>🏟 Home pitch</h3>
   <p>Your home ground's default pitch — it applies to every home fixture unless you override a single match on the Fixtures screen (allowed until its tactical lock). A <b>batting</b> pitch lifts scores; a <b>bowling</b> pitch keeps them low and helps your bowlers.</p>
   <div class="bidform"><span><label>Home pitch</label><br><select id="tacpitch"><option value="batting">Batting pitch</option><option value="balanced">Balanced</option><option value="bowling">Bowling pitch</option></select></span></div>
   <button class="goldbtn" onclick="saveTactics()">Save XI &amp; Tactics</button></div>`;
   $('#tbat').value=d.tactics.battingApproach||'Balanced';$('#tacpitch').value=d.tactics.homePitch||'balanced';}
  else if(tab==='Transfers'){const d=await api(`/api/worlds/${worldId}/offers`);
   const others=d.members.filter(m=>!m.mine);
   if(trPrefill){trClub=trPrefill.ownerMid;}
   if(!others.some(m=>m.id===trClub))trClub=others.length?others[0].id:null;
   const theirPlayers=trClub?(d.playersByOwner[trClub]||[]):[];
   const myPlayers=d.playersByOwner[d.myMembershipId]||[];
   const selPid=trPrefill&&trPrefill.ownerMid===trClub?trPrefill.pid:(theirPlayers[0]||{}).worldPlayerId;
   const selPlayer=theirPlayers.find(p=>p.worldPlayerId===selPid);
   const incoming=d.offers.filter(o=>o.direction==='in'), outgoing=d.offers.filter(o=>o.direction==='out');
   const offerRow=(o,actions)=>`<div class="feeditem"><b>${esc(o.player?o.player.name:'')}</b> (${esc(o.player?o.player.role:'')}, OVR ${o.player?o.player.rating:''}) — ${esc(o.fromClub)} → ${esc(o.toClub)} · <b>₹${o.total} Cr</b> (fee ₹${o.fee}${o.bonus?` + bonus ₹${o.bonus}`:''})${o.swapPlayer?` · swap: ${esc(o.swapPlayer.name)} (OVR ${o.swapPlayer.rating})`:''}${o.promise?` · promise: ${o.promise==='captain'?'Captain':'Vice-captain'}`:''} <span class="pill">${esc(o.status)}</span><br><small>Sent ${new Date(o.createdAt).toLocaleString()} · expires ${new Date(o.expiresAt).toLocaleString()}</small> ${actions||''}</div>`;
   v.innerHTML=`<div class="panel"><h2>🔁 Transfers &amp; Offers</h2>
   <p>Football-style transfer market: offer money, add a <b>bonus</b>, throw in a <b>player swap</b>, or promise the incoming player the <b>captaincy</b>. The selling manager accepts or rejects — on acceptance the deal is re-checked (funds, squad sizes 18–25, ownership) and applied at once. Offers expire after 72 hours. Your budget: <b style="color:var(--gold)">₹${sideCache?sideCache.budget:'—'} Cr</b></p>
   <h3>Make an offer</h3>
   ${others.length?`<div class="formgrid">
   <span><label>Target club</label><select id="trclub" onchange="trSetClub(this.value)">${others.map(m=>`<option value="${m.id}" ${m.id===trClub?'selected':''}>${esc(m.clubName)}${m.ai?' 🤖':''}</option>`).join('')}</select></span>
   <span><label>Their player</label><select id="trplayer">${theirPlayers.map(p=>`<option value="${p.worldPlayerId}" ${p.worldPlayerId===selPid?'selected':''}>${esc(p.name)} — ${esc(p.role)} · OVR ${p.rating} · base ₹${p.baseValue} Cr</option>`).join('')}</select></span>
   <span><label>Fee ₹ Cr</label><input id="trfee" type="number" step="0.1" min="0" value="${selPlayer?selPlayer.baseValue:''}"></span>
   <span><label>Bonus ₹ Cr (optional, paid at once on acceptance)</label><input id="trbonus" type="number" step="0.1" min="0" value="0"></span>
   <span><label>Swap — one of your players (optional)</label><select id="trswap"><option value="">No swap</option>${myPlayers.map(p=>`<option value="${p.worldPlayerId}">${esc(p.name)} — ${esc(p.role)} · OVR ${p.rating}</option>`).join('')}</select></span>
   <span><label>Promise (optional)</label><select id="trpromise"><option value="">No promise</option><option value="captain">Make them Captain</option><option value="vice_captain">Make them Vice-Captain</option></select></span>
   </div>
   <button class="goldbtn" onclick="submitOffer()">Send Offer</button>
   ${theirPlayers.length?`<p style="margin-top:10px"><small>Target squad — click a name for the player page: ${theirPlayers.map(p=>`<a href="#" onclick="event.preventDefault();openPlayer('${p.worldPlayerId}','Transfers')">${esc(p.name)}</a>`).join(' · ')}</small></p>`:''}`
   :'<p>No other clubs in this world yet.</p>'}
   </div>
   <div class="panel"><h3>📥 Incoming offers (${incoming.length})</h3>${incoming.length?incoming.map(o=>offerRow(o,o.status==='PENDING'?`<button onclick="offerAccept('${o.id}')">Accept</button> <button class="secondary" onclick="offerReject('${o.id}')">Reject</button>`:'')).join(''):'<p>No offers for your players.</p>'}</div>
   <div class="panel"><h3>📤 Outgoing offers (${outgoing.length})</h3>${outgoing.length?outgoing.map(o=>offerRow(o,o.status==='PENDING'?`<button class="secondary" onclick="offerWithdraw('${o.id}')">Withdraw</button>`:'')).join(''):'<p>You have made no offers.</p>'}</div>`;
   trPrefill=null;}
  else if(tab==='Fixtures'){const d=await api(`/api/worlds/${worldId}/fixtures`);
   v.innerHTML=`<div class="panel"><h2>📅 Fixtures & Match Centre</h2><p>No “Play Match” button — matches start automatically at their scheduled server time. Tactical lock: 30 minutes before start. The <b>home manager</b> prepares the pitch — set it per match below (until the lock) or set a standing home pitch on Captain &amp; Tactics.</p>
   <div class="tblwrap"><table><tr><th>Rd</th><th>Fixture</th><th>Scheduled</th><th>Pitch</th><th>Status</th><th>Result / Report</th></tr>
   ${d.fixtures.map(f=>`<tr><td>${f.round}</td><td><span class="fxcell"><span class="pcell">${crestHTML(f.homeClub,'sm')}<span>${esc(f.homeClub)}</span></span><span class="vsmid" style="font-size:12px">vs</span><span class="pcell">${crestHTML(f.awayClub,'sm')}<span>${esc(f.awayClub)}</span></span></span></td><td>${new Date(f.scheduledAt).toLocaleString()} ${esc(f.timezone)}${f.locked?' · 🔒 XI locked':''}</td>
   <td>${f.isHome&&!f.result&&!f.locked?`<span class="bidform"><select id="pitch-${f.id}">${['batting','balanced','bowling'].map(pp=>`<option value="${pp}" ${f.pitch===pp?'selected':''}>${cap1(pp)}</option>`).join('')}</select><button class="secondary" onclick="setFixturePitch('${f.id}')">Set</button></span><br><small>${f.pitchSet?'Match pitch':'Your home default'}</small>`:`${cap1(f.pitch||'balanced')}${f.pitchSet?'':' (default)'}`}</td><td><span class="pill">${esc(f.status)}</span></td>
   <td>${f.result?`${f.result.home.runs}/${f.result.home.wickets} vs ${f.result.away.runs}/${f.result.away.wickets} — ${esc(f.result.summary)}<br>${esc((f.result.report||[]).join(' '))}`:'—'}</td></tr>`).join('')}</table></div></div>`;}
  else if(tab==='League'){const d=await api(`/api/worlds/${worldId}/league`);
   v.innerHTML=`<div class="panel"><h2>🏆 League Table</h2><div class="tblwrap"><table><tr><th>#</th><th>Club</th><th>P</th><th>W</th><th>L</th><th>T</th><th>NRR</th><th>Pts</th></tr>${d.table.map((r,i)=>`<tr class="${sideCache&&r.clubName===sideCache.clubName?'mine':''}"><td>${i+1}</td><td><span class="pcell">${crestHTML(r.clubName,'sm')}<span>${esc(r.clubName)}</span></span></td><td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.tied}</td><td>${r.nrr}</td><td><b>${r.points}</b></td></tr>`).join('')}</table></div></div>`;}
  else if(tab==='Finance'){const d=await api(`/api/worlds/${worldId}/finance`);
   v.innerHTML=`<div class="panel"><h2>💰 Finance</h2>
   <div class="statgrid">
     <div class="stat">Starting budget<b>₹${d.startingBudget} Cr</b></div>
     <div class="stat">Spent on players<b>₹${d.spentOnPlayers} Cr</b></div>
     <div class="stat">Remaining<b style="color:var(--gold)">₹${d.budget} Cr</b></div>
   </div>
   <p>Bids are validated against this balance on the server — the client cannot change it.</p></div>`;}
  else if(tab==='News'||tab==='History'){const d=await api(`/api/worlds/${worldId}/${tab==='News'?'news':'events'}`);const items=d.news||d.events;
   v.innerHTML=`<div class="panel"><h2>${tab==='News'?'📰 News':'🕘 History'}</h2>${items.map(n=>`<div class="feeditem"><b>${esc(n.headline||n.type)}</b> — ${esc(n.body||JSON.stringify(n.payload||{}))} <small>${new Date(n.createdAt).toLocaleString()}</small></div>`).join('')||'<p>Nothing yet.</p>'}</div>`;}
  else if(tab==='Messages'){const d=await api('/api/notifications');
   v.innerHTML=`<div class="panel"><h2>✉️ Messages</h2>${d.notifications.map(n=>`<div class="feeditem">${esc(n.message)} <small>${new Date(n.createdAt).toLocaleString()}</small></div>`).join('')||'<p>No messages yet.</p>'}</div>`;}
 }catch(e){$('#err').textContent=e.message;}
}
function auctionListRows(list,serverNow){return list.map(a=>`<div class="arow ${a.worldPlayerId===focusPid?'sel':''}" onclick="focusAuction('${a.worldPlayerId}')">
 ${pAvatar(a)}
 <span class="ainfo"><div class="aname">${esc(a.player.name)}</div><div class="asub">${esc(a.player.role)} · ${esc(a.player.nationality)} · Age ${a.player.age ?? '—'}</div></span>
 <span><div class="aprice">${a.highestBid?'₹'+a.currentPrice+' Cr':'₹'+a.baseValue+' Cr'}</div><div class="alead">${a.highestBid?(a.leaderUndisclosed?'<span class="undisc">Undisclosed</span>':esc(a.highestBidderClub)):'No bids'} · ${a.status==='OPEN'?countdown(a.auctionEndsAt,serverNow):esc(a.status)}</div></span>
 <button class="starbtn ${a.watched?'on':''}" title="Watchlist" onclick="event.stopPropagation();watch('${a.auctionId}')">${a.watched?'★':'☆'}</button></div>`).join('');}
function playerRows(list){return list.map(a=>`<tr class="clickable" onclick="openPlayer('${a.worldPlayerId}','Players')"><td><span class="pcell">${pAvatar(a)}<span class="pname">${esc(a.player.name)}</span></span></td><td>${esc(a.player.role)}</td><td>${esc(a.player.nationality)}</td><td>${a.player.age ?? '—'}</td><td><span class="ovr">${a.player.rating}</span></td><td>${a.player.batting}</td><td>${a.player.bowling}</td><td>${a.player.leadership}</td><td>${a.baseValue}</td>
 <td>${a.status==='SOLD'?'Sold':a.status}</td><td>${a.ownerClub?esc(a.ownerClub)+' · ':''}${a.highestBid?'₹'+a.highestBid+' Cr':''}</td></tr>`).join('');}
window.filterAuctions=q=>{if(!aucCache)return;const list=aucCache.auctions.filter(a=>a.player.name.toLowerCase().includes(q.toLowerCase()));const host=$('#aucList');if(host)host.innerHTML=auctionListRows(list,aucCache.serverNow);};
window.filterPlayers=q=>{if(!aucCache)return;const list=aucCache.auctions.filter(a=>a.player.name.toLowerCase().includes(q.toLowerCase()));$('#aucBody').innerHTML=playerRows(list);};
window.openWorld=id=>{worldId=id;sideCache=null;focusPid=null;tab='Waiting Room';renderTabs();render();};
window.createWorld=async()=>{try{const body={name:$('#wname').value,description:$('#wdesc').value,numberOfClubs:$('#wnum').value,format:$('#wfmt').value,matchIntervalDays:$('#wint').value,matchTime:$('#wtime').value,startDate:$('#wstart').value||undefined,auctionStartAt:$('#wauc').value||undefined,seasonStartAt:$('#wseason').value||undefined,password:$('#wpass').value||undefined,aiFill:$('#waifill').checked,squadMode:$('#wmode').value};
// ---- transfer market actions ----
window.trSetClub=v=>{trClub=v;render();};
window.openTransferFor=(pid,mid)=>{trPrefill={pid,ownerMid:mid};tab='Transfers';renderTabs();render();};
window.submitOffer=async()=>{try{const body={toMembershipId:$('#trclub').value,worldPlayerId:$('#trplayer').value,fee:+$('#trfee').value||0,bonus:+$('#trbonus').value||0,swapWorldPlayerId:$('#trswap').value||undefined,promise:$('#trpromise').value||undefined};await api(`/api/worlds/${worldId}/offers`,{method:'POST',body:JSON.stringify(body)});alert('Offer sent! The selling manager can accept or reject it in Transfers & Offers.');render();}catch(e){$('#err').textContent=e.message;}};
window.offerAccept=async id=>{try{await api(`/api/offers/${id}/accept`,{method:'POST',body:'{}'});render();}catch(e){$('#err').textContent=e.message;}};
window.offerReject=async id=>{try{await api(`/api/offers/${id}/reject`,{method:'POST',body:'{}'});render();}catch(e){$('#err').textContent=e.message;}};
window.offerWithdraw=async id=>{try{await api(`/api/offers/${id}/withdraw`,{method:'POST',body:'{}'});render();}catch(e){$('#err').textContent=e.message;}};const d=await api('/api/worlds',{method:'POST',body:JSON.stringify(body)});openWorld(d.world.id);}catch(e){$('#err').textContent=e.message;}};
window.joinWorld=async()=>{try{const club=document.querySelector('input[name=club]:checked');if(!club)throw new Error('Select a club first.');await api(`/api/worlds/${worldId}/join`,{method:'POST',body:JSON.stringify({clubName:club.value,password:($('#jpass')||{}).value})});render();}catch(e){$('#err').textContent=e.message;}};
window.startWorld=async()=>{try{const d=await api(`/api/worlds/${worldId}/start`,{method:'POST',body:'{}'});alert(`World started! ${d.aiAdded?d.aiAdded+' AI manager(s) filled the empty clubs. ':''}The auction is open.`);tab='Auction';renderTabs();render();}catch(e){$('#err').textContent=e.message;}};
window.bid=async id=>{try{const u=document.getElementById('undis-'+id);await api(`/api/auctions/${id}/bid`,{method:'POST',body:JSON.stringify({amount:+document.getElementById('bid-'+id).value,undisclosed:!!(u&&u.checked)})});render();}catch(e){$('#err').textContent=e.message;}};
window.withdrawBid=async id=>{try{await api(`/api/auctions/${id}/withdraw`,{method:'POST',body:'{}'});render();}catch(e){$('#err').textContent=e.message;}};
window.watch=async id=>{await api(`/api/auctions/${id}/watchlist`,{method:'POST',body:'{}'});render();};
window.cap=async(pid,role)=>{await api(`/api/worlds/${worldId}/captain`,{method:'POST',body:JSON.stringify({worldPlayerId:pid,role})});render();};
window.saveXI=async()=>{try{const xi=[...document.querySelectorAll('.xi:checked')].map(x=>x.value);await api(`/api/worlds/${worldId}/xi`,{method:'POST',body:JSON.stringify({xi,tactics:{battingApproach:$('#tbat').value}})});alert('XI & tactics saved.');}catch(e){$('#err').textContent=e.message;}};
window.saveTactics=async()=>{try{const xi=[...document.querySelectorAll('.xi:checked')].map(x=>x.value);
 const order=tacOrder.filter(pid=>xi.includes(pid));xi.forEach(pid=>{if(!order.includes(pid))order.push(pid);});
 const plan={};Object.entries(tacPlan).forEach(([pid,e])=>{if(xi.includes(pid)&&((e.pp||0)+(e.mid||0)+(e.death||0))>0)plan[pid]={pp:e.pp||0,mid:e.mid||0,death:e.death||0};});
 const appr={};xi.forEach(pid=>{if(tacApproach[pid])appr[pid]=tacApproach[pid];});
 await api(`/api/worlds/${worldId}/xi`,{method:'POST',body:JSON.stringify({xi,tactics:{battingApproach:$('#tbat').value,battingOrder:order,bowlingPlan:plan,playerApproach:appr,homePitch:$('#tacpitch').value}})});
 alert('XI & tactics saved.');render();}catch(e){$('#err').textContent=e.message;}};
window.setFixturePitch=async fid=>{try{const sel=document.getElementById('pitch-'+fid);await api(`/api/worlds/${worldId}/fixtures/${fid}/pitch`,{method:'POST',body:JSON.stringify({pitch:sel.value})});render();}catch(e){$('#err').textContent=e.message;}};
boot(); setInterval(()=>{if(me)render();},30000); // refresh renders server state; it never advances game time itself

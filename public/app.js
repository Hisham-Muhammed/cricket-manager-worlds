'use strict';
let me=null, worldId=null, tab='Lobby', playerPid=null, backTab='Auction', aucCache=null, sideCache=null;
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,o={}){const r=await fetch(p,{headers:{'Content-Type':'application/json'},...o});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d;}
function countdown(iso,serverNow){let ms=new Date(iso)-new Date(serverNow);if(ms<0)ms=0;const h=Math.floor(ms/36e5),m=Math.floor(ms%36e5/6e4),s=Math.floor(ms%6e4/1e3);return `${h}h ${m}m ${s}s`;}
async function boot(){if(location.hash.includes('access_token=')){const h=new URLSearchParams(location.hash.slice(1));try{await api('/api/auth/google/session',{method:'POST',body:JSON.stringify({accessToken:h.get('access_token')})});}catch{}history.replaceState(null,'',location.pathname+location.search);}try{const d=await api('/api/auth/me');me=d.user;showApp();}catch{$('#authView').classList.remove('hidden');}}
$('#loginBtn').onclick=async()=>{try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})});me=d.user;showApp();}catch(e){$('#authErr').textContent=e.message;}};
$('#regBtn').onclick=async()=>{try{const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({name:$('#mname').value,email:$('#email').value,password:$('#password').value})});me=d.user;showApp();}catch(e){$('#authErr').textContent=e.message;}};
function showApp(){$('#authView').classList.add('hidden');$('#appView').classList.remove('hidden');$('#who').innerHTML=`${esc(me.name)} (${esc(me.email)}) <button class="secondary" onclick="logout()">Logout</button>`;renderTabs();render();}
window.logout=async()=>{await api('/api/auth/logout',{method:'POST'});location.reload();};

// ---- sidebar menu: sections + icons, active state, club header block ----
const MENU=[
 {sec:'Home'},
 {key:'Lobby',icon:'🏠',label:'Home / Lobby'},
 {key:'Waiting Room',icon:'🚪',label:'Waiting Room'},
 {sec:'Manage'},
 {key:'Auction',icon:'🔨',label:'Auction'},
 {key:'Players',icon:'📚',label:'Player Database'},
 {key:'Squad',icon:'👥',label:'Squad'},
 {key:'Tactics',icon:'🎯',label:'Captain & Tactics'},
 {sec:'World'},
 {key:'Fixtures',icon:'📅',label:'Fixtures'},
 {key:'League',icon:'🏆',label:'League Table'},
 {key:'Finance',icon:'💰',label:'Finance'},
 {key:'News',icon:'📰',label:'News'},
 {key:'History',icon:'🕘',label:'History'},
 {key:'Messages',icon:'✉️',label:'Messages'},
];
function renderTabs(){$('#tabs').innerHTML=MENU.map(m=>m.sec?`<div class="msec">${esc(m.sec)}</div>`:`<button class="${m.key===tab||(tab==='Player'&&m.key===backTab)?'on':''}" onclick="go('${m.key}')">${m.icon} ${esc(m.label)}</button>`).join('');paintClubBlock();}
function initials(name){return String(name||'?').split(/\s+/).map(x=>x[0]).join('').slice(0,3).toUpperCase();}
function paintClubBlock(){const el=$('#clubBlock');if(!el)return;
 if(sideCache&&sideCache.clubName){el.innerHTML=`<div class="crest">${esc(initials(sideCache.clubName))}</div><div class="cname">${esc(sideCache.clubName)}</div><div class="cbudget">₹${sideCache.budget} Cr</div><div class="cworld">${esc(sideCache.worldName||'')}</div>`;}
 else el.innerHTML=`<div class="crest">${esc(initials(me?me.name:'?'))}</div><div class="cname">${esc(me?me.name:'')}</div><div class="cworld">${worldId?'No club in this world yet':'Open a world from the Lobby'}</div>`;}
async function refreshClubBlock(){if(!worldId){sideCache=null;paintClubBlock();return;}
 try{const d=await api('/api/worlds/'+worldId);sideCache=d.myMembership?{clubName:d.myMembership.clubName,budget:d.myMembership.budget,worldName:d.world.name}:null;paintClubBlock();}catch{}}
window.go=t=>{tab=t;renderTabs();render();};
window.openPlayer=(pid,from)=>{if(!worldId)return;playerPid=pid;backTab=from||tab;tab='Player';renderTabs();render();};

async function render(){const v=$('#view');$('#err').textContent='';refreshClubBlock();
 try{
  if(tab==='Lobby'){const d=await api('/api/worlds');
   v.innerHTML=`<div class="card"><h2>Game World Lobby</h2><table><tr><th>World</th><th>Creator</th><th>Managers</th><th>Status</th><th>Start</th><th>Format</th><th></th></tr>
   ${d.worlds.map(w=>`<tr><td>${esc(w.name)} ${w.isPrivate?'<span class="lock">🔒 Private</span>':''} ${w.aiFill?'🤖':''}</td><td>${esc(w.creatorName)}</td><td>${w.managersCount}/${w.numberOfClubs}</td><td><span class="pill">${esc(w.state)}</span></td><td>${new Date(w.startDate).toLocaleString()}</td><td>${esc(w.format)}</td><td><button onclick="openWorld('${w.id}')">View / Join</button></td></tr>`).join('')}</table></div>
   <div class="card"><h3>Create World</h3>
   <input id="wname" placeholder="World name"><input id="wdesc" placeholder="Description">
   <label>Number of clubs</label><input id="wnum" type="number" value="10" min="2" max="10">
   <label>Format</label><input id="wfmt" value="League (Home & Away)">
   <label>Match interval (days)</label><input id="wint" type="number" value="3" min="1" max="7">
   <label>Match time</label><input id="wtime" value="20:00">
   <label>World start</label><input id="wstart" type="datetime-local">
   <label>Auction start</label><input id="wauc" type="datetime-local">
   <label>Season start</label><input id="wseason" type="datetime-local">
   <label>World password (optional — stored hashed, never shown)</label><input id="wpass" type="password">
   <label class="chk"><input type="checkbox" id="waifill" checked> Fill empty clubs with AI managers (world can be started any time)</label><br>
   <button onclick="createWorld()">Create World</button></div>`;}
  else if(!worldId){v.innerHTML='<div class="card">Open a world from the Lobby first.</div>';}
  else if(tab==='Waiting Room'){const d=await api('/api/worlds/'+worldId);const w=d.world;const canStart=w.creatorId===me.id&&['CREATED','RECRUITING'].includes(w.state);
   v.innerHTML=`<div class="card"><h2>World Waiting Room — ${esc(w.name)}</h2><p>Status: <span class="pill">${esc(w.state)}</span> · Managers: ${w.managersCount}/${w.numberOfClubs} · Server time: ${new Date(d.serverNow).toLocaleString()}</p>
   <p>World start: ${new Date(w.startDate).toLocaleString()} · Auction: ${new Date(w.auctionStartAt).toLocaleString()} · Season: ${new Date(w.seasonStartAt).toLocaleString()}</p>
   <p>Rules: Squads start <b>empty</b>, budget ₹100 Cr each, squads of 18–25 players, 24-hour auctions, matches every ${w.matchIntervalDays} days at ${esc(w.matchTime)} (${esc(w.timezone)}), no Play Match button — fixtures auto-simulate at their scheduled server time.</p>
   <h3>Joined managers</h3>${d.members.map(m=>`<div>${esc(m.clubName)} — ${esc(m.managerName)}${m.ai?' 🤖 AI':''}</div>`).join('')||'None yet'}
   ${d.myMembership?'':`<h3>Select your club</h3>${d.availableClubs.map(c=>`<div><label><input type="radio" name="club" value="${esc(c)}" style="width:auto"> ${esc(c)}</label></div>`).join('')}
   ${w.isPrivate?'<label>World password</label><input id="jpass" type="password">':''}<button onclick="joinWorld()">Join World</button>`}</div>
   ${canStart?`<div class="gold"><h3>▶ Start World Now</h3>
   <p>The world normally starts when its scheduled time arrives${w.managersCount<w.numberOfClubs?' or the room fills':''} — as creator you can start it right now, whatever the count.${w.aiFill?'<br>🤖 <b>AI managers will fill every empty club</b> and bid in the auction alongside you.':''}</p>
   ${d.myMembership?`<button class="goldbtn" onclick="startWorld()">▶ Start World Now</button>`:'<p><b>Join a club above first</b> — the creator must hold a club to start the world.</p>'}</div>`:''}`;}
  else if(tab==='Auction'){const d=await api(`/api/worlds/${worldId}/auction`);aucCache=d;
   v.innerHTML=`<div class="card"><h2>🔨 Player Auction Market <small>(world state: ${esc(d.state)})</small></h2>
   <p>Click any player for their full page with bid history. Countdowns come from stored <code>auctionEndsAt</code> + server time (${new Date(d.serverNow).toLocaleString()}); auctions settle automatically at expiry. Tick <b>Undisclosed</b> to hide your bid amount and identity — the current price stays public.</p>
   <input id="afilter" placeholder="Filter by player name…" oninput="filterAuctions(this.value)"></div>
   <table><thead><tr><th>Player</th><th>Role</th><th>Nat</th><th>Age</th><th>Rating</th><th>Base ₹ Cr</th><th>Price ₹ Cr</th><th>Leader</th><th>Ends (left)</th><th>Status</th><th>Your bid ₹ Cr</th><th></th></tr></thead><tbody id="aucBody">${auctionRows(d.auctions,d.serverNow)}</tbody></table>`;}
  else if(tab==='Players'){const d=await api(`/api/worlds/${worldId}/auction`);aucCache=d;
   v.innerHTML=`<div class="card"><h2>📚 Player Database</h2><p>Every player in this world's central pool. Click a player for their page: full ratings, auction status and complete bid history.</p>
   <input id="afilter" placeholder="Filter by player name…" oninput="filterPlayers(this.value)"></div>
   <table><thead><tr><th>Player</th><th>Role</th><th>Nat</th><th>Age</th><th>Rating</th><th>Bat</th><th>Bowl</th><th>Lead</th><th>Base ₹ Cr</th><th>Market</th><th>Owner / Price</th></tr></thead><tbody id="aucBody">${playerRows(d.auctions)}</tbody></table>`;}
  else if(tab==='Player'){const d=await api(`/api/worlds/${worldId}/players/${playerPid}`);const p=d.player,a=d.auction;const myValid=(d.bids||[]).some(b=>b.mine&&b.status==='VALID');
   v.innerHTML=`<div class="card"><button class="secondary" onclick="go('${backTab}')">← Back</button>
   <div class="phead"><div class="crest">${esc(initials(p.name))}</div><div><div class="big">${esc(p.name)}</div><div>${esc(p.role)} · ${esc(p.nationality)} · Age ${p.age ?? '—'}</div>
   <div>${p.ownerClub?`Owned by <b>${esc(p.ownerClub)}</b>`:'In the central market'}</div></div></div>
   <div class="statgrid">
     <div class="stat">Rating<b>${p.rating}</b></div><div class="stat">Batting<b>${p.batting}</b></div><div class="stat">Bowling<b>${p.bowling}</b></div>
     <div class="stat">Leadership<b>${p.leadership}</b></div><div class="stat">Base price<b>₹${p.baseValue} Cr</b></div>
     <div class="stat">Form<b>${p.form}</b></div><div class="stat">Fitness<b>${p.fitness}</b></div><div class="stat">Morale<b>${p.morale}</b></div>
   </div></div>
   ${a?`<div class="card"><h3>🔨 Auction</h3>
   <p>Status: <span class="pill">${esc(a.status)}</span> · Current price: <b>₹${a.currentPrice} Cr</b> · Leader: ${a.highestBid?(a.leaderUndisclosed?'<span class="undisc">Undisclosed</span>':esc(a.highestBidderClub)):'No bids yet'}
   <br>Ends: ${new Date(a.auctionEndsAt).toLocaleString()} (${countdown(a.auctionEndsAt,d.serverNow)} left) · ${a.bidsCount} bid(s)</p>
   ${a.status==='OPEN'?`<div class="bidform"><span><label>Your bid ₹ Cr</label><br><input id="bid-${a.auctionId}" class="inline-num" type="number" step="0.1" placeholder="₹ Cr"></span>
   <label class="chk"><input type="checkbox" id="undis-${a.auctionId}"> Undisclosed bid</label>
   <button onclick="bid('${a.auctionId}')">Place bid</button>
   ${myValid?`<button class="secondary" onclick="withdrawBid('${a.auctionId}')">Withdraw my bid</button>`:''}
   <button class="secondary" onclick="watch('${a.auctionId}')">${a.watched?'★ Watching':'☆ Watchlist'}</button></div>
   <p><small>Withdrawing removes your highest bid; the leader and price are recalculated from the remaining bids, and you may bid again. Squads must hold 18–25 players — bids that would leave you unable to afford an 18-player squad are rejected.</small></p>`:'<p>This auction has closed.</p>'}
   </div>
   <div class="card"><h3>Bid History</h3>
   ${d.bids.length?`<table><tr><th>Time</th><th>Manager</th><th>Club</th><th>Amount ₹ Cr</th><th>Status</th></tr>
   ${d.bids.map(b=>`<tr><td>${new Date(b.createdAt).toLocaleString()}</td><td>${b.undisclosed&&!b.mine?'<span class="undisc">Undisclosed</span>':esc(b.managerName)}${b.mine?' (you)':''}</td><td>${b.undisclosed&&!b.mine?'<span class="undisc">Undisclosed</span>':esc(b.clubName)}</td><td>${b.amount==null?'<span class="undisc">Undisclosed</span>':'₹'+b.amount}</td><td>${esc(b.status)}</td></tr>`).join('')}</table>`:'<p>No bids yet.</p>'}
   </div>`:'<div class="card">No auction for this player.</div>'}`;}
  else if(tab==='Squad'||tab==='Tactics'){const d=await api(`/api/worlds/${worldId}/squad`);
   v.innerHTML=`<div class="card"><h2>${esc(d.clubName)} — Squad (${d.squad.length} players) · Budget ₹${d.budget} Cr</h2>
   ${d.squad.length?'':'<p>Your squad is empty. Win players in the Auction.</p>'}
   <table><tr><th></th><th>Player</th><th>Role</th><th>Rating</th><th>Form</th><th>Fitness</th><th>Leadership</th><th></th></tr>
   ${d.squad.map(p=>`<tr class="clickable" onclick="openPlayer('${p.worldPlayerId}','Squad')"><td onclick="event.stopPropagation()"><input type="checkbox" class="xi" value="${p.worldPlayerId}" ${d.xi.includes(p.worldPlayerId)?'checked':''} style="width:auto"></td><td><a class="plink">${esc(p.name)}</a> ${p.isCaptain?'©':''}${p.isViceCaptain?' (VC)':''}</td><td>${esc(p.role)}</td><td>${p.rating}</td><td>${p.form}</td><td>${p.fitness}</td><td>${p.leadership}</td>
   <td onclick="event.stopPropagation()"><button class="secondary" onclick="cap('${p.worldPlayerId}','captain')">Captain</button> <button class="secondary" onclick="cap('${p.worldPlayerId}','vice')">Vice-captain</button></td></tr>`).join('')}</table>
   <p>Tick up to 11 players above as your Playing XI. Captaincy lifts that player's morale and adds a chemistry/performance modifier in the match engine.</p>
   <label>Batting approach</label><select id="tbat"><option>Balanced</option><option>Aggressive</option><option>Defensive</option></select>
   <button onclick="saveXI()">Save XI & Tactics</button></div>`;$('#tbat').value=d.tactics.battingApproach||'Balanced';}
  else if(tab==='Fixtures'){const d=await api(`/api/worlds/${worldId}/fixtures`);
   v.innerHTML=`<div class="card"><h2>📅 Fixtures & Match Centre</h2><p>No “Play Match” button — matches start automatically at their scheduled server time. Tactical lock: 30 minutes before start.</p>
   <table><tr><th>Round</th><th>Fixture</th><th>Scheduled</th><th>Status</th><th>Result / Report</th></tr>
   ${d.fixtures.map(f=>`<tr><td>${f.round}</td><td>${esc(f.homeClub)} vs ${esc(f.awayClub)}</td><td>${new Date(f.scheduledAt).toLocaleString()} ${esc(f.timezone)}${f.locked?' · 🔒 XI locked':''}</td><td>${esc(f.status)}</td>
   <td>${f.result?`${f.result.home.runs}/${f.result.home.wickets} vs ${f.result.away.runs}/${f.result.away.wickets} — ${esc(f.result.summary)}<br>${esc((f.result.report||[]).join(' '))}`:'—'}</td></tr>`).join('')}</table></div>`;}
  else if(tab==='League'){const d=await api(`/api/worlds/${worldId}/league`);
   v.innerHTML=`<div class="card"><h2>🏆 League Table</h2><table><tr><th>Club</th><th>P</th><th>W</th><th>L</th><th>T</th><th>NRR</th><th>Pts</th></tr>${d.table.map(r=>`<tr><td>${esc(r.clubName)}</td><td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.tied}</td><td>${r.nrr}</td><td><b>${r.points}</b></td></tr>`).join('')}</table></div>`;}
  else if(tab==='Finance'){const d=await api(`/api/worlds/${worldId}/finance`);
   v.innerHTML=`<div class="card"><h2>💰 Finance</h2><p>Starting budget: ₹${d.startingBudget} Cr<br>Spent on players: ₹${d.spentOnPlayers} Cr<br><b>Remaining: ₹${d.budget} Cr</b></p><p>Bids are validated against this balance on the server — the client cannot change it.</p></div>`;}
  else if(tab==='News'||tab==='History'){const d=await api(`/api/worlds/${worldId}/${tab==='News'?'news':'events'}`);const items=d.news||d.events;
   v.innerHTML=`<div class="card"><h2>${tab}</h2>${items.map(n=>`<div><b>${esc(n.headline||n.type)}</b> — ${esc(n.body||JSON.stringify(n.payload||{}))} <small>${new Date(n.createdAt).toLocaleString()}</small></div>`).join('')||'Nothing yet.'}</div>`;}
  else if(tab==='Messages'){const d=await api('/api/notifications');
   v.innerHTML=`<div class="card"><h2>✉️ Messages</h2>${d.notifications.map(n=>`<div>${esc(n.message)} <small>${new Date(n.createdAt).toLocaleString()}</small></div>`).join('')||'No messages yet.'}</div>`;}
 }catch(e){$('#err').textContent=e.message;}
}
function auctionRows(list,serverNow){return list.map(a=>`<tr class="clickable" onclick="openPlayer('${a.worldPlayerId}','Auction')"><td><a class="plink">${esc(a.player.name)}</a></td><td>${esc(a.player.role)}</td><td>${esc(a.player.nationality)}</td><td>${a.player.age ?? '—'}</td><td>${a.player.rating}</td><td>${a.baseValue}</td>
 <td><b>${a.highestBid?'₹'+a.currentPrice:'—'}</b></td><td>${a.highestBid?(a.leaderUndisclosed?'<span class="undisc">Undisclosed</span>':esc(a.highestBidderClub)):'No bids'}</td>
 <td>${countdown(a.auctionEndsAt,serverNow)}</td><td>${esc(a.status)}</td>
 <td onclick="event.stopPropagation()"><input id="bid-${a.auctionId}" class="inline-num" type="number" step="0.1" placeholder="₹ Cr"> <label class="chk"><input type="checkbox" id="undis-${a.auctionId}"> Undisc.</label></td>
 <td onclick="event.stopPropagation()"><button onclick="bid('${a.auctionId}')">Bid</button> <button class="secondary" onclick="watch('${a.auctionId}')">${a.watched?'★':'☆'}</button></td></tr>`).join('');}
function playerRows(list){return list.map(a=>`<tr class="clickable" onclick="openPlayer('${a.worldPlayerId}','Players')"><td><a class="plink">${esc(a.player.name)}</a></td><td>${esc(a.player.role)}</td><td>${esc(a.player.nationality)}</td><td>${a.player.age ?? '—'}</td><td>${a.player.rating}</td><td>${a.player.batting}</td><td>${a.player.bowling}</td><td>${a.player.leadership}</td><td>${a.baseValue}</td>
 <td>${a.status==='SOLD'?'Sold':a.status}</td><td>${a.ownerClub?esc(a.ownerClub)+' · ':''}${a.highestBid?'₹'+a.highestBid+' Cr':''}</td></tr>`).join('');}
window.filterAuctions=q=>{if(!aucCache)return;const list=aucCache.auctions.filter(a=>a.player.name.toLowerCase().includes(q.toLowerCase()));$('#aucBody').innerHTML=auctionRows(list,aucCache.serverNow);};
window.filterPlayers=q=>{if(!aucCache)return;const list=aucCache.auctions.filter(a=>a.player.name.toLowerCase().includes(q.toLowerCase()));$('#aucBody').innerHTML=playerRows(list);};
window.openWorld=id=>{worldId=id;sideCache=null;tab='Waiting Room';renderTabs();render();};
window.createWorld=async()=>{try{const body={name:$('#wname').value,description:$('#wdesc').value,numberOfClubs:$('#wnum').value,format:$('#wfmt').value,matchIntervalDays:$('#wint').value,matchTime:$('#wtime').value,startDate:$('#wstart').value||undefined,auctionStartAt:$('#wauc').value||undefined,seasonStartAt:$('#wseason').value||undefined,password:$('#wpass').value||undefined,aiFill:$('#waifill').checked};const d=await api('/api/worlds',{method:'POST',body:JSON.stringify(body)});openWorld(d.world.id);}catch(e){$('#err').textContent=e.message;}};
window.joinWorld=async()=>{try{const club=document.querySelector('input[name=club]:checked');if(!club)throw new Error('Select a club first.');await api(`/api/worlds/${worldId}/join`,{method:'POST',body:JSON.stringify({clubName:club.value,password:($('#jpass')||{}).value})});render();}catch(e){$('#err').textContent=e.message;}};
window.startWorld=async()=>{try{const d=await api(`/api/worlds/${worldId}/start`,{method:'POST',body:'{}'});alert(`World started! ${d.aiAdded?d.aiAdded+' AI manager(s) filled the empty clubs. ':''}The auction is open.`);tab='Auction';renderTabs();render();}catch(e){$('#err').textContent=e.message;}};
window.bid=async id=>{try{const u=document.getElementById('undis-'+id);await api(`/api/auctions/${id}/bid`,{method:'POST',body:JSON.stringify({amount:+document.getElementById('bid-'+id).value,undisclosed:!!(u&&u.checked)})});render();}catch(e){$('#err').textContent=e.message;}};
window.withdrawBid=async id=>{try{await api(`/api/auctions/${id}/withdraw`,{method:'POST',body:'{}'});render();}catch(e){$('#err').textContent=e.message;}};
window.watch=async id=>{await api(`/api/auctions/${id}/watchlist`,{method:'POST',body:'{}'});render();};
window.cap=async(pid,role)=>{await api(`/api/worlds/${worldId}/captain`,{method:'POST',body:JSON.stringify({worldPlayerId:pid,role})});render();};
window.saveXI=async()=>{try{const xi=[...document.querySelectorAll('.xi:checked')].map(x=>x.value);await api(`/api/worlds/${worldId}/xi`,{method:'POST',body:JSON.stringify({xi,tactics:{battingApproach:$('#tbat').value}})});alert('XI & tactics saved.');}catch(e){$('#err').textContent=e.message;}};
boot(); setInterval(()=>{if(me)render();},30000); // refresh renders server state; it never advances game time itself

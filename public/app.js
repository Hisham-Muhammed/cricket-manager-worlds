'use strict';
let me=null, worldId=null, tab='Lobby';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,o={}){const r=await fetch(p,{headers:{'Content-Type':'application/json'},...o});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d;}
function countdown(iso,serverNow){let ms=new Date(iso)-new Date(serverNow);if(ms<0)ms=0;const h=Math.floor(ms/36e5),m=Math.floor(ms%36e5/6e4),s=Math.floor(ms%6e4/1e3);return `${h}h ${m}m ${s}s`;}
async function boot(){if(location.hash.includes('access_token=')){const h=new URLSearchParams(location.hash.slice(1));try{await api('/api/auth/google/session',{method:'POST',body:JSON.stringify({accessToken:h.get('access_token')})});}catch{}history.replaceState(null,'',location.pathname+location.search);}try{const d=await api('/api/auth/me');me=d.user;showApp();}catch{$('#authView').classList.remove('hidden');}}
$('#loginBtn').onclick=async()=>{try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})});me=d.user;showApp();}catch(e){$('#authErr').textContent=e.message;}};
$('#regBtn').onclick=async()=>{try{const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({name:$('#mname').value,email:$('#email').value,password:$('#password').value})});me=d.user;showApp();}catch(e){$('#authErr').textContent=e.message;}};
function showApp(){$('#authView').classList.add('hidden');$('#appView').classList.remove('hidden');$('#who').innerHTML=`${esc(me.name)} (${esc(me.email)}) <button class="secondary" onclick="logout()">Logout</button>`;renderTabs();render();}
window.logout=async()=>{await api('/api/auth/logout',{method:'POST'});location.reload();};
const TABS=['Lobby','Waiting Room','Auction','Squad','Tactics','Fixtures','Match Centre','League','Finance','News','Notifications','History'];
function renderTabs(){$('#tabs').innerHTML=TABS.map(t=>`<button class="${t===tab?'on':''}" onclick="go('${t}')">${t}</button>`).join('');}
window.go=t=>{tab=t;renderTabs();render();};
async function render(){const v=$('#view');$('#err').textContent='';
 try{
  if(tab==='Lobby'){const d=await api('/api/worlds');
   v.innerHTML=`<div class="card"><h2>Game World Lobby</h2><table><tr><th>World</th><th>Creator</th><th>Managers</th><th>Status</th><th>Start</th><th>Format</th><th></th></tr>
   ${d.worlds.map(w=>`<tr><td>${esc(w.name)} ${w.isPrivate?'<span class="lock">🔒 Private</span>':''}</td><td>${esc(w.creatorName)}</td><td>${w.managersCount}/${w.numberOfClubs}</td><td><span class="pill">${esc(w.state)}</span></td><td>${new Date(w.startDate).toLocaleString()}</td><td>${esc(w.format)}</td><td><button onclick="openWorld('${w.id}')">View / Join</button></td></tr>`).join('')}</table></div>
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
   <button onclick="createWorld()">Create World</button></div>`;}
  else if(!worldId){v.innerHTML='<div class="card">Open a world from the Lobby first.</div>';}
  else if(tab==='Waiting Room'){const d=await api('/api/worlds/'+worldId);const w=d.world;
   v.innerHTML=`<div class="card"><h2>World Waiting Room — ${esc(w.name)}</h2><p>Status: <span class="pill">${esc(w.state)}</span> · Managers: ${w.managersCount}/${w.numberOfClubs} · Server time: ${new Date(d.serverNow).toLocaleString()}</p>
   <p>World start: ${new Date(w.startDate).toLocaleString()} · Auction: ${new Date(w.auctionStartAt).toLocaleString()} · Season: ${new Date(w.seasonStartAt).toLocaleString()}</p>
   <p>Rules: Squads start <b>empty</b>, budget ₹100 Cr each, 24-hour auctions, matches every ${w.matchIntervalDays} days at ${esc(w.matchTime)} (${esc(w.timezone)}), no Play Match button — fixtures auto-simulate at their scheduled server time.</p>
   <h3>Joined managers</h3>${d.members.map(m=>`<div>${esc(m.clubName)} — ${esc(m.managerName)}</div>`).join('')||'None yet'}
   ${d.myMembership?'':`<h3>Select your club</h3>${d.availableClubs.map(c=>`<div><label><input type="radio" name="club" value="${esc(c)}" style="width:auto"> ${esc(c)}</label></div>`).join('')}
   ${w.isPrivate?'<label>World password</label><input id="jpass" type="password">':''}<button onclick="joinWorld()">Join World</button>`}</div>`;}
  else if(tab==='Auction'){const d=await api(`/api/worlds/${worldId}/auction`);
   v.innerHTML=`<div class="card"><h2>Player Auction Market (world state: ${esc(d.state)})</h2><p>Countdowns are computed from stored <code>auctionEndsAt</code> + server time (${new Date(d.serverNow).toLocaleString()}). Auctions settle automatically at expiry.</p></div><div class="grid">
   ${d.auctions.map(a=>`<div class="card"><b>${esc(a.player.name)}</b> · ${esc(a.player.role)} · ${esc(a.player.nationality)}<br>Age ${a.player.age ?? '—'} · Rating ${a.player.rating} · Base ₹${a.baseValue} Cr<br>
   Ends: ${new Date(a.auctionEndsAt).toLocaleString()} (${countdown(a.auctionEndsAt,d.serverNow)} left) · Status ${esc(a.status)}<br>
   Highest: ${a.highestBid?`₹${a.highestBid} Cr — ${esc(a.highestBidderClub)}`:'No bids yet'}<br>
   <input id="bid-${a.auctionId}" type="number" step="0.1" placeholder="Your bid ₹ Cr"><button onclick="bid('${a.auctionId}')">Place bid</button>
   <button class="secondary" onclick="watch('${a.auctionId}')">${a.watched?'★ Watching':'☆ Watchlist'}</button></div>`).join('')}</div>`;}
  else if(tab==='Squad'||tab==='Tactics'){const d=await api(`/api/worlds/${worldId}/squad`);
   v.innerHTML=`<div class="card"><h2>${esc(d.clubName)} — Squad (${d.squad.length} players) · Budget ₹${d.budget} Cr</h2>
   ${d.squad.length?'':'<p>Your squad is empty. Win players in the Auction.</p>'}
   <table><tr><th></th><th>Player</th><th>Role</th><th>Rating</th><th>Form</th><th>Fitness</th><th>Leadership</th><th></th></tr>
   ${d.squad.map(p=>`<tr><td><input type="checkbox" class="xi" value="${p.worldPlayerId}" ${d.xi.includes(p.worldPlayerId)?'checked':''} style="width:auto"></td><td>${esc(p.name)} ${p.isCaptain?'©':''}${p.isViceCaptain?' (VC)':''}</td><td>${esc(p.role)}</td><td>${p.rating}</td><td>${p.form}</td><td>${p.fitness}</td><td>${p.leadership}</td>
   <td><button class="secondary" onclick="cap('${p.worldPlayerId}','captain')">Captain</button> <button class="secondary" onclick="cap('${p.worldPlayerId}','vice')">Vice-captain</button></td></tr>`).join('')}</table>
   <p>Tick up to 11 players above as your Playing XI. Captaincy lifts that player's morale and adds a chemistry/performance modifier in the match engine.</p>
   <label>Batting approach</label><select id="tbat"><option>Balanced</option><option>Aggressive</option><option>Defensive</option></select>
   <button onclick="saveXI()">Save XI & Tactics</button></div>`;$('#tbat').value=d.tactics.battingApproach||'Balanced';}
  else if(tab==='Fixtures'||tab==='Match Centre'){const d=await api(`/api/worlds/${worldId}/fixtures`);
   v.innerHTML=`<div class="card"><h2>${tab}</h2><p>No “Play Match” button — matches start automatically at their scheduled server time. Tactical lock: 30 minutes before start.</p>
   <table><tr><th>Round</th><th>Fixture</th><th>Scheduled</th><th>Status</th><th>Result / Report</th></tr>
   ${d.fixtures.map(f=>`<tr><td>${f.round}</td><td>${esc(f.homeClub)} vs ${esc(f.awayClub)}</td><td>${new Date(f.scheduledAt).toLocaleString()} ${esc(f.timezone)}${f.locked?' · 🔒 XI locked':''}</td><td>${esc(f.status)}</td>
   <td>${f.result?`${f.result.home.runs}/${f.result.home.wickets} vs ${f.result.away.runs}/${f.result.away.wickets} — ${esc(f.result.summary)}<br>${esc((f.result.report||[]).join(' '))}`:'—'}</td></tr>`).join('')}</table></div>`;}
  else if(tab==='League'){const d=await api(`/api/worlds/${worldId}/league`);
   v.innerHTML=`<div class="card"><h2>League Table</h2><table><tr><th>Club</th><th>P</th><th>W</th><th>L</th><th>T</th><th>NRR</th><th>Pts</th></tr>${d.table.map(r=>`<tr><td>${esc(r.clubName)}</td><td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.tied}</td><td>${r.nrr}</td><td><b>${r.points}</b></td></tr>`).join('')}</table></div>`;}
  else if(tab==='Finance'){const d=await api(`/api/worlds/${worldId}/finance`);
   v.innerHTML=`<div class="card"><h2>Finance</h2><p>Starting budget: ₹${d.startingBudget} Cr<br>Spent on players: ₹${d.spentOnPlayers} Cr<br><b>Remaining: ₹${d.budget} Cr</b></p><p>Bids are validated against this balance on the server — the client cannot change it.</p></div>`;}
  else if(tab==='News'||tab==='History'){const d=await api(`/api/worlds/${worldId}/${tab==='News'?'news':'events'}`);const items=d.news||d.events;
   v.innerHTML=`<div class="card"><h2>${tab}</h2>${items.map(n=>`<div><b>${esc(n.headline||n.type)}</b> — ${esc(n.body||JSON.stringify(n.payload||{}))} <small>${new Date(n.createdAt).toLocaleString()}</small></div>`).join('')||'Nothing yet.'}</div>`;}
  else if(tab==='Notifications'){const d=await api('/api/notifications');
   v.innerHTML=`<div class="card"><h2>Notifications</h2>${d.notifications.map(n=>`<div>${esc(n.message)} <small>${new Date(n.createdAt).toLocaleString()}</small></div>`).join('')||'No notifications.'}</div>`;}
 }catch(e){$('#err').textContent=e.message;}
}
window.openWorld=id=>{worldId=id;tab='Waiting Room';renderTabs();render();};
window.createWorld=async()=>{try{const body={name:$('#wname').value,description:$('#wdesc').value,numberOfClubs:$('#wnum').value,format:$('#wfmt').value,matchIntervalDays:$('#wint').value,matchTime:$('#wtime').value,startDate:$('#wstart').value||undefined,auctionStartAt:$('#wauc').value||undefined,seasonStartAt:$('#wseason').value||undefined,password:$('#wpass').value||undefined};const d=await api('/api/worlds',{method:'POST',body:JSON.stringify(body)});openWorld(d.world.id);}catch(e){$('#err').textContent=e.message;}};
window.joinWorld=async()=>{try{const club=document.querySelector('input[name=club]:checked');if(!club)throw new Error('Select a club first.');await api(`/api/worlds/${worldId}/join`,{method:'POST',body:JSON.stringify({clubName:club.value,password:($('#jpass')||{}).value})});render();}catch(e){$('#err').textContent=e.message;}};
window.bid=async id=>{try{await api(`/api/auctions/${id}/bid`,{method:'POST',body:JSON.stringify({amount:+document.getElementById('bid-'+id).value})});render();}catch(e){$('#err').textContent=e.message;}};
window.watch=async id=>{await api(`/api/auctions/${id}/watchlist`,{method:'POST',body:'{}'});render();};
window.cap=async(pid,role)=>{await api(`/api/worlds/${worldId}/captain`,{method:'POST',body:JSON.stringify({worldPlayerId:pid,role})});render();};
window.saveXI=async()=>{try{const xi=[...document.querySelectorAll('.xi:checked')].map(x=>x.value);await api(`/api/worlds/${worldId}/xi`,{method:'POST',body:JSON.stringify({xi,tactics:{battingApproach:$('#tbat').value}})});alert('XI & tactics saved.');}catch(e){$('#err').textContent=e.message;}};
boot(); setInterval(()=>{if(me)render();},30000); // refresh renders server state; it never advances game time itself

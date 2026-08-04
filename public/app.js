const API = '/api';
let token = localStorage.getItem('ob_token') || '';
let me = null;
let characters = [];
let currentCharId = null;
let socialLinksDraft = [];
let agSources = [];

// ── helpers ─────────────────────────────────────────────
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function escAttr(s){return esc(s).replace(/'/g,'&#39;')}
function fmtNum(n){n=Number(n)||0;if(n>=1e9)return (n/1e9).toFixed(1)+'B';if(n>=1e6)return (n/1e6).toFixed(1)+'M';if(n>=1e3)return (n/1e3).toFixed(1)+'k';return String(n)}
function toast(msg,err){const t=$('toast');t.textContent=msg;t.className='toast show'+(err?' err':'');setTimeout(()=>t.className='toast',2500)}
function copyText(t){navigator.clipboard?.writeText(t).then(()=>toast('Copied!')).catch(()=>{const x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();document.execCommand('copy');x.remove();toast('Copied!')})}
function fmt(t){if(!t)return '—';const d=new Date(t);return isNaN(d)?'—':d.toLocaleString()}
function pct(a,b){if(!b)return '—';return Math.round(a/b*100)+'%'}
function badge(status){const s=String(status||'unknown').toLowerCase();const on=['ready','active','connected'];
  return '<span class="badge '+(on.includes(s)?'green':'yellow')+'">'+esc(status||'—')+'</span>'}
function emptyRows(cols,msg){return '<tr><td colspan="'+cols+'"><div class="empty">'+esc(msg||'No data')+'</div></td></tr>'}
function pager(el,meta,fn){if(!el)return;if(!meta||meta.total<=meta.perPage){el.innerHTML='';return}
  el.innerHTML='<span>'+meta.total+' result(s)</span> <button class="btn sm" '+(meta.page<=1?'disabled':'')+' onclick="'+fn+'('+(meta.page-1)+')">‹ Prev</button> <span class="pg-cur">'+meta.page+' / '+meta.pages+'</span> <button class="btn sm" '+(meta.page>=meta.pages?'disabled':'')+' onclick="'+fn+'('+(meta.page+1)+')">Next ›</button>';}

async function api(path, opts={}){
  const headers = {'Content-Type':'application/json'};
  if(token) headers['Authorization']='Bearer '+token;
  const res = await fetch(API+path, {...opts, headers});
  const data = await res.json().catch(()=>({}));
  if(res.status===401 && token){logout();throw new Error('unauthorized')}
  if(!res.ok){const err=new Error(data.error||res.status);err.configMissing=!!data.configMissing;throw err}
  return data;
}

// ── auth ────────────────────────────────────────────────
let authMode='login';
function showAuth(mode){
  authMode=mode;
  $('tabLogin').className=mode==='login'?'active':'';
  $('tabRegister').className=mode==='register'?'active':'';
  $('authName').className=mode==='register'?'':'hidden';
  $('authBtn').textContent=mode==='login'?'Login':'Create Account';
  $('authHint').textContent=mode==='login'
    ?'Login to your tenant dashboard. New here? Register a free account — you get a unique webhook URL to connect your OpenWA.'
    :'Registering gives you a unique authenticated webhook URL, unlimited characters, and per-session character assignment.';
}

async function submitAuth(e){
  e.preventDefault();
  const email=$('authEmail').value.trim(), password=$('authPass').value;
  const body = authMode==='login'?{email,password}:{email,password,name:$('authName').value.trim()};
  try{
    const res=await fetch(API+'/auth/'+(authMode==='login'?'login':'register'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'failed');
    token=data.token;localStorage.setItem('ob_token',token);me=data.user;
    enterApp();
  }catch(err){toast(err.message,true)}
}

function logout(){token='';localStorage.removeItem('ob_token');me=null;location.reload()}

async function enterApp(){
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  try{const d=await api('/auth/me');me=d.user;}catch{}
  $('meName').textContent=me?.name||'—';
  $('meEmail').textContent=me?.email||'—';
  $('meRole').textContent=me?.role==='admin'?'ADMIN':'';
  const adminNav=document.querySelectorAll('.admin-only');
  adminNav.forEach(x=>x.classList.toggle('hidden', me?.role!=='admin'));
  refreshAll();
  pollNotifications();
  if(me?.role==='admin'){adminTab('overview');loadAdminStats();loadAdminUsers();}
}

(async function showAdminCreds(){
  try{
    const d=await fetch(API+'/auth/admin-info').then(r=>r.json());
    if(d.show_credentials&&d.admin_email){
      $('adminCreds').style.display='block';
      $('adminCreds').innerHTML='<strong>Admin panel</strong><br>Email: <code>'+esc(d.admin_email)+'</code> · Password: <code>'+esc(d.admin_password)+'</code>';
    }
  }catch{}
})();

// ── nav ─────────────────────────────────────────────────
document.querySelectorAll('.nav-item[data-view]').forEach(item=>{
  item.onclick=()=>{
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));
    item.classList.add('active');
    ['overview','characters','sessions','webhooks','stats','admin','settings'].forEach(v=>{
      $('view-'+v).classList.toggle('hidden', v!==item.dataset.view);
    });
    if(item.dataset.view==='characters')loadCharacters();
    if(item.dataset.view==='sessions')loadSessions();
    if(item.dataset.view==='webhooks')loadWebhooks();
    if(item.dataset.view==='stats')loadUserStats();
    if(item.dataset.view==='admin'){adminTab('overview');loadAdminStats();}
    if(item.dataset.view==='settings')loadSettingsForm();
  };
});

// ── notifications ───────────────────────────────────────
const NOTIF_ICON={info:'ℹ️',success:'✅',warning:'⚠️',error:'🚨',danger:'🚨'};
function relTime(t){
  const d=new Date(t);if(isNaN(d))return '';
  const s=Math.max(1,Math.floor((Date.now()-d)/1000));
  if(s<60)return 'just now';
  const m=Math.floor(s/60);if(m<60)return m+'m ago';
  const h=Math.floor(m/60);if(h<24)return h+'h ago';
  const days=Math.floor(h/24);if(days<7)return days+'d ago';
  return d.toLocaleDateString([],{month:'short',day:'numeric'});
}
function toggleBell(){
  const d=$('bellDrop');
  d.classList.toggle('hidden');
  if(!d.classList.contains('hidden'))loadBell();
}
async function loadBell(){
  try{
    const d=await api('/notifications?limit=25');
    const el=$('bellList');
    if(!d.items.length){el.innerHTML='<div class="empty">You\'re all caught up 🎉</div>';return}
    el.innerHTML=d.items.map(n=>{
      const lv=['error','danger'].includes(n.level)?'error':n.level;
      return '<div class="bell-item'+(n.read?'':' unread')+'" data-id="'+n.id+'" onclick="markNotifRead(this)">'+
        '<div class="bell-title '+lv+'"><span class="bell-ico">'+(NOTIF_ICON[lv]||'ℹ️')+'</span>'+esc(n.title)+'</div>'+
        '<div class="bell-body">'+esc(n.body)+'</div>'+
        '<div class="bell-time">'+relTime(n.created_at)+(n.read?'':' · <span class="bell-unread-dot"></span>')+'</div></div>';
    }).join('');
  }catch{}
}
async function markNotifRead(el){
  const wasUnread=el.classList.contains('unread');
  if(wasUnread){
    try{
      await api('/notifications/read',{method:'POST',body:JSON.stringify({ids:[el.dataset.id]})});
      el.classList.remove('unread');
      el.querySelector('.bell-unread-dot')?.remove();
      pollNotifications(true);
    }catch{}
  }
}
async function markAllRead(){
  try{
    await api('/notifications/read',{method:'POST',body:JSON.stringify({})});
    document.querySelectorAll('.bell-item').forEach(i=>i.classList.remove('unread'));
    $('bellBadge').classList.add('hidden');
    toast('All notifications marked read');
  }catch(e){toast(e.message,true)}
}
async function clearAllNotifications(){
  if(!confirm('Clear all notifications?'))return;
  try{
    await api('/notifications',{method:'DELETE'});
    $('bellBadge').classList.add('hidden');
    loadBell();
    toast('Notifications cleared');
  }catch(e){toast(e.message,true)}
}
async function pollNotifications(skipRecurse){
  if(!token)return;
  try{
    const d=await api('/notifications/unread-count');
    const b=$('bellBadge');
    if(d.count>0){b.textContent=d.count>99?'99+':d.count;b.classList.remove('hidden')}
    else b.classList.add('hidden');
  }catch{}
  if(!skipRecurse)setTimeout(pollNotifications,15000);
}

// ── overview ────────────────────────────────────────────
async function refreshAll(){
  try{
    const d=await api('/dashboard/stats?range=30d');
    $('mMsgs').textContent=d.stats.messages;
    $('mIn').textContent=d.stats.incoming; $('mOut').textContent=d.stats.outgoing;
    $('mChars').textContent=d.stats.characters;
    $('mSess').textContent=d.stats.sessions;
    $('mLlm').textContent=d.stats.llmCalls;
    $('ovSub').textContent='Updated '+new Date().toLocaleTimeString();
  }catch{}

  try{
    const wh=await api('/webhooks');
    $('genUrl').value=wh.generic.url;
  }catch{}

  try{
    const logs=await api('/dashboard/logs?lines=60');
    renderLogs('overviewLogs',logs.lines||[]);
  }catch{}

  try{
    const msgs=await api('/dashboard/messages?limit=10');
    renderRecent(msgs.messages||[]);
  }catch{}
}

function renderRecent(msgs){
  const el=$('recentMsgs');
  if(!msgs.length){el.innerHTML='<div class="empty">No messages yet — send a WhatsApp message to your linked number</div>';return}
  el.innerHTML=msgs.map(m=>{
    const c=m.character_id?' ('+ (characters.find(x=>x.id===m.character_id)?.name||'?') +')':'';
    return '<div class="msg '+m.direction+'"><div class="sender">'+m.direction+' · '+new Date(m.created_at).toLocaleTimeString()+c+'</div>'+esc(m.body)+'</div>';
  }).join('');
}

function renderLogs(id,lines){
  const el=$(id);if(!el)return;
  el.innerHTML=lines.map(l=>{
    let cls='',tag='';
    if(l.includes('[msg]')){cls='t-msg';tag='MSG'}
    else if(l.includes('[llm]')){cls='t-llm';tag='LLM'}
    else if(l.includes('[poll]')){cls='t-poll';tag='POLL'}
    else if(l.includes('[health]')){cls='t-health';tag='HEALTH'}
    else if(l.includes('[catchup]')){cls='t-catch';tag='CATCH'}
    else if(l.includes('[webhook]')||l.includes('[handle]')){cls='t-webhook';tag='WH'}
    return '<div class="log-line"><span class="tag '+cls+'">'+(tag?'['+tag+']':'')+'</span>'+esc(l.replace(/^\[.*?\]\s*/,''))+'</div>';
  }).join('');
  el.scrollTop=el.scrollHeight;
}

// ── characters ──────────────────────────────────────────
function charColor(id){let h=0;for(const ch of String(id))h=(h*31+ch.charCodeAt(0))>>>0;return PG_PALETTE[h%PG_PALETTE.length]}
function charAvatar(c){
  const initial = esc(c.name?.charAt(0)?.toUpperCase() || '?');
  const col = charColor(c.name||'');
  if(c.avatar) return '<div class="ch-avatar"><img src="'+escAttr(c.avatar)+'" alt="" onerror="this.parentNode.innerHTML=\'<span>'+initial+'</span>\'"><span class="ch-dot '+esc(c.status||'sleeping')+'"></span></div>';
  return '<div class="ch-avatar init" style="background:'+col+'"><span>'+initial+'</span><span class="ch-dot '+esc(c.status||'sleeping')+'"></span></div>';
}
function charStatusBadge(c){
  const st=c.status||'sleeping';
  const map={live:['green','LIVE · awake'],sleeping:['yellow','sleeping'],off:['red','inactive']};
  const [cls,label]=map[st]||map.sleeping;
  return '<span class="badge '+cls+'">'+label+'</span>';
}
async function loadCharacters(){
  const d=await api('/characters');
  characters=d.characters;
  const el=$('charList');
  if(!characters.length){el.innerHTML='<div class="empty">No characters yet. Create your first persona.</div>';return}
  el.innerHTML=characters.map(c=>{
    const webhook = me?`${me.webhook_base}/webhook/${me.webhook_token}/${c.slug}`:'';
    return '<div class="char-form" data-id="'+c.id+'">'+
      '<div class="head">'+charAvatar(c)+
      '<div style="flex:1"><strong>'+esc(c.name)+'</strong> '+charStatusBadge(c)+
      '<div style="font-size:11px;color:var(--muted);font-weight:400">'+esc(c.tagline||c.slug||'')+'</div></div>'+
      '<span class="spacer"></span>'+
      '<label class="switch" title="Active — when off, this character ignores webhook traffic"><input type="checkbox"'+(c.active?' checked':'')+' onchange="toggleCharacterActive(\''+c.id+'\',this.checked)"><span class="slider"></span></label> '+
      '<button class="btn sm" onclick="fillCharacter(\''+c.id+'\')">Edit</button> '+
      '<button class="btn sm success" onclick="openPlayground(\''+c.id+'\')">Test</button> '+
      '<button class="btn sm danger" onclick="delCharacter(\''+c.id+'\')">Delete</button></div>'+
      '<div style="font-size:11px;color:var(--muted)">slug: '+esc(c.slug)+' · webhook: <code>'+esc(webhook)+'</code></div>'+
      '<div style="font-size:12px;color:var(--muted);margin-top:6px">'+esc(c.personality?.slice(0,90)||'')+'</div>'+
    '</div>';
  }).join('');
}
async function toggleCharacterActive(id,active){
  try{
    await api('/characters/'+id+'/active',{method:'PATCH',body:JSON.stringify({active})});
    toast(active?'Character activated':'Character deactivated');
    loadCharacters();
  }catch(e){toast(e.message,true);loadCharacters()}
}

function newCharacter(){
  currentCharId=null;
  showCharEditor({
    name:'',slug:'',tagline:'',greeting:'',bio:'',personality:'',reply_style:'',extra_rules:'',
    languages:['English'],tags:[],visibility:'private',active:true,avatar:'',
    example_messages:[],typing_profile:{},
    knowledge_base:'',social_links:[],drive_link:'',source_links:[],sources_verified:false
  });
}

function fillCharacter(id){
  const c=characters.find(x=>x.id===id);if(!c)return;
  currentCharId=id;
  showCharEditor(c);
}

function showCharEditor(c){
  socialLinksDraft = Array.isArray(c.social_links) ? c.social_links.map(x => ({ ...x })) : [];
  const el=$('charList');
  el.innerHTML='<div class="char-form">'+
    '<div class="head"><strong>'+(currentCharId?'Edit Character':'New Character')+'</strong>'+
    ' <span class="spacer"></span>'+
    '<button class="btn sm" onclick="toggleImag()">✨ Create from prompt</button> '+
    '<button class="btn sm" onclick="toggleAutogen()">⚡ Auto-build from links</button> '+
    '<button class="btn sm success" onclick="saveCharacter()">Save</button> '+
    '<button class="btn sm" onclick="loadCharacters()">Cancel</button></div>'+

    '<div id="imagPanel" class="autogen hidden">'+
      '<div class="autogen-tip">Describe the character you imagine — a persona, a brand voice, a celebrity-style host, an avatar. OpenBridge will draft the whole character from your prompt for you to review and accept.</div>'+
      '<label>Character idea (prompt)</label><textarea id="imPrompt" rows="3" placeholder="e.g. A wise Nepali mountain guide named Ramesh who gives trekking tips, tells stories about the Himalayas, and recommends hidden trails. Warm, humble, talks like a friend. He knows the Annapurna circuit inside out."></textarea>'+
      '<label>How will this character be used? (optional)</label><input id="imHint" placeholder="e.g. tourism hotline assistant, product promoter, virtual celebrity">'+
      '<div class="flex" style="margin-top:10px">'+
        '<button class="btn sm success" onclick="runImagine()" id="imGenBtn">Generate character</button> '+
        '<button class="btn sm" onclick="toggleImag()">Close</button>'+
      '</div>'+
      '<div id="imResults"></div>'+
    '</div>'+

    '<div id="autogenPanel" class="autogen hidden">'+
      '<div class="autogen-tip">Paste your public links (website, wiki, Instagram, Facebook, …). OpenBridge scrapes them, builds a verified knowledge base, and drafts the whole character for you to review.</div>'+
      '<label>Links (one per line)</label><textarea id="agLinks" rows="3" placeholder="https://en.wikipedia.org/wiki/Your_Name&#10;https://www.instagram.com/yourpage/&#10;https://www.yourwebsite.com"></textarea>'+
      '<label>How will this character be used? (optional)</label><input id="agHint" placeholder="e.g. company receptionist, sales agent for my fashion brand">'+
      '<div class="flex" style="margin-top:10px">'+
        '<button class="btn sm" onclick="runScrape()">1 · Scrape links</button> '+
        '<button class="btn sm success" onclick="runAutogen()" disabled id="agGenBtn">2 · Generate character</button>'+
      '</div>'+
      '<div id="agResults"></div>'+
    '</div>'+

    '<div class="grid2">'+
      '<div><label>Name</label><input id="cName" value="'+esc(c.name)+'"></div>'+
      '<div><label>Slug (webhook url)</label><input id="cSlug" value="'+esc(c.slug)+'" placeholder="auto from name"></div>'+
    '</div>'+
    '<label>Avatar URL <span class="hint">profile picture shown on the dashboard</span></label><input id="cAvatar" value="'+esc(c.avatar||'')+'" placeholder="https://… or leave empty for a colored initial">'+
    '<label>Tagline</label><input id="cTagline" value="'+esc(c.tagline)+'">'+
    '<label>Greeting</label><input id="cGreeting" value="'+esc(c.greeting)+'" placeholder="First message for a new chat">'+
    '<label>Bio</label><textarea id="cBio" rows="3">'+esc(c.bio)+'</textarea>'+
    '<label>Personality</label><textarea id="cPersonality" rows="2">'+esc(c.personality)+'</textarea>'+
    '<label>Reply Style</label><textarea id="cReplyStyle" rows="2">'+esc(c.reply_style)+'</textarea>'+
    '<label>Extra Rules</label><textarea id="cExtraRules" rows="2">'+esc(c.extra_rules)+'</textarea>'+
    '<label>Knowledge Base <span class="hint">verified facts this character answers from (auto-filled by Auto-build)</span></label><textarea id="cKnowledge" rows="6">'+esc(c.knowledge_base||'')+'</textarea>'+
    '<label>Media gallery (Google Drive link) <span class="hint">when someone asks for a photo, character sends an image from here</span></label><input id="cDrive" value="'+esc(c.drive_link||'')+'" placeholder="https://drive.google.com/drive/folders/… or /file/d/…">'+
    '<label>Social links <span class="hint">shared naturally in chats when relevant</span></label><div id="socialRows"></div>'+
    '<button class="btn sm" style="margin-top:6px" onclick="addSocialRow()">+ Add social link</button>'+
    '<div class="grid2" style="margin-top:10px">'+
      '<div><label>Languages (comma)</label><input id="cLanguages" value="'+esc((c.languages||[]).join(', '))+'" placeholder="English, Nepali"></div>'+
      '<div><label>Tags (comma)</label><input id="cTags" value="'+esc((c.tags||[]).join(', '))+'" placeholder="actress, model"></div>'+
    '</div>'+
    '<label>Example messages (user: / assistant: per line)</label><textarea id="cExamples" rows="3">'+esc(renderExamples(c.example_messages))+'</textarea>'+
    '<div class="switch-row"><span>Active</span><label class="switch"><input id="cActive" type="checkbox"'+(c.active?' checked':'')+'><span class="slider"></span></label></div>'+
    '<div class="switch-row"><span>Public</span><span class="hint">listed in the public directory</span><label class="switch"><input id="cVisibility" type="checkbox"'+(c.visibility==='public'?' checked':'')+'><span class="slider"></span></label></div>'+
    '<div class="switch-row"><span>Sources verified</span><span class="hint">facts checked against your links</span><label class="switch"><input id="cVerified" type="checkbox"'+(c.sources_verified?' checked':'')+'><span class="slider"></span></label></div>'+
  '</div>';
  renderSocialRows();
}

function renderExamples(ex){
  const arr = Array.isArray(ex) ? ex : [];
  return arr.map(m=>(m.role||'user')+': '+m.content).join('\n');
}

async function saveCharacter(){
  const body={
    name:$('cName').value.trim(),
    slug:$('cSlug').value.trim()||undefined,
    tagline:$('cTagline').value.trim(),
    greeting:$('cGreeting').value.trim(),
    bio:$('cBio').value,
    personality:$('cPersonality').value,
    reply_style:$('cReplyStyle').value,
    extra_rules:$('cExtraRules').value,
    knowledge_base:$('cKnowledge').value,
    drive_link:$('cDrive').value.trim(),
    avatar:$('cAvatar').value.trim(),
    social_links:socialLinksDraft.filter(s=>s.url&&s.url.trim()),
    languages:$('cLanguages').value.split(',').map(s=>s.trim()).filter(Boolean),
    tags:$('cTags').value.split(',').map(s=>s.trim()).filter(Boolean),
    visibility:$('cVisibility').checked?'public':'private',
    active:$('cActive').checked,
    sources_verified:document.querySelector('#cVerified')?.checked||false,
    example_messages:$('cExamples').value.split('\n').map(l=>{const m=l.match(/^(user|assistant|character):\s?(.*)$/i);return m?{role:m[1].toLowerCase()==='user'?'user':'assistant',content:m[2]}:null}).filter(Boolean),
  };
  try{
    if(currentCharId)await api('/characters/'+currentCharId,{method:'PUT',body:JSON.stringify(body)});
    else await api('/characters',{method:'POST',body:JSON.stringify(body)});
    toast('Character saved!');loadCharacters();
  }catch(e){toast(e.message,true)}
}

async function delCharacter(id){
  if(!confirm('Delete this character?'))return;
  try{await api('/characters/'+id,{method:'DELETE'});toast('Deleted');loadCharacters()}catch(e){toast(e.message,true)}
}

// ── social links editor ────────────────────────────────
function renderSocialRows(){
  const el=$('socialRows');
  if(!el)return;
  if(!socialLinksDraft.length){el.innerHTML='<div class="empty" style="padding:12px">No social links yet</div>';return}
  el.innerHTML=socialLinksDraft.map((s,i)=>{
    const types=['instagram','facebook','tiktok','youtube','twitter/x','website','whatsapp','email','other'];
    const opts=types.map(t=>'<option'+(s.type===t?' selected':'')+'>'+t+'</option>').join('');
    return '<div class="flex social-row" data-i="'+i+'">'+
      '<select style="width:120px" onchange="socialLinksDraft['+i+'].type=this.value">'+opts+'</select>'+
      '<input placeholder="Label (e.g. Instagram)" style="width:150px" value="'+esc(s.label||'')+'" oninput="socialLinksDraft['+i+'].label=this.value">'+
      '<input placeholder="https://…" value="'+esc(s.url||'')+'" oninput="socialLinksDraft['+i+'].url=this.value">'+
      '<button class="btn sm danger" onclick="removeSocialRow('+i+')">✕</button></div>';
  }).join('');
}
function addSocialRow(){socialLinksDraft.push({type:'website',label:'',url:''});renderSocialRows()}
function removeSocialRow(i){socialLinksDraft.splice(i,1);renderSocialRows()}

// ── auto-build wizard ──────────────────────────────────
function agShow(msg, pct){
  const r=$('agResults');
  if(!r)return;
  const bar=pct==null?'<div class="ag-fill indet"></div>':'<div class="ag-fill" style="width:'+pct+'%"></div>';
  r.innerHTML='<div class="ag-progress"><div class="ag-bar">'+bar+'</div>'+
    '<div class="ag-status"><span class="spin"></span><span>'+esc(msg)+'</span>'+(pct==null?'':'<span class="pct">'+pct+'%</span>')+'</div></div>';
}
function toggleAutogen(){
  const p=$('autogenPanel');
  if(!p)return;
  p.classList.toggle('hidden');
  if(!p.classList.contains('hidden')&&$('agLinks'))$('agLinks').focus();
}

// ── imagine (create character from a prompt) ───────────
let imDraft=null;
function toggleImag(){
  const p=$('imagPanel');
  if(!p)return;
  p.classList.toggle('hidden');
  if(!p.classList.contains('hidden')&&$('imPrompt'))$('imPrompt').focus();
}
function imShow(msg, pct){
  const r=$('imResults');if(!r)return;
  const bar=pct==null?'<div class="ag-fill indet"></div>':'<div class="ag-fill" style="width:'+pct+'%"></div>';
  r.innerHTML='<div class="ag-progress"><div class="ag-bar">'+bar+'</div>'+
    '<div class="ag-status"><span class="spin"></span><span>'+esc(msg)+'</span>'+(pct==null?'':'<span class="pct">'+pct+'%</span>')+'</div></div>';
}
async function runImagine(){
  const prompt=$('imPrompt').value.trim();
  if(!prompt){toast('Describe the character you imagine first',true);return}
  const btn=$('imGenBtn');btn.disabled=true;
  const stages=[
    ['Reading your idea…',8],
    ['Imagining the persona…',34],
    ['Writing personality…',55],
    ['Building knowledge base…',74],
    ['Creating example chats…',88],
    ['Finalizing profile…',95],
  ];
  let si=0;
  const anim=setInterval(()=>{if(si<stages.length){const [m,p]=stages[si++];imShow(m,p)}},5000);
  imShow('Starting…',0);
  try{
    const d=await api('/autogen/imagine',{method:'POST',body:JSON.stringify({prompt,hint:$('imHint').value.trim()})});
    clearInterval(anim);
    imDraft=d.draft||{};
    const g=imDraft;
    const hasExamples=Array.isArray(g.example_messages)&&g.example_messages.length;
    const socials=Array.isArray(g.social_links)&&g.social_links.length?'<tr><td>Social links</td><td>'+g.social_links.map(s=>esc(s.label||s.type||s.url||'')).join(', ')+'</td></tr>':'';
    $('imResults').innerHTML=
      '<div class="imag-card">'+
        '<div class="imag-card-head"><div class="imag-avatar">'+esc((g.name||'?').charAt(0).toUpperCase())+'</div>'+
        '<div><strong>'+esc(g.name||'')+'</strong><div class="imag-tag">'+esc(g.tagline||'')+'</div></div></div>'+
        '<table class="imag-table">'+
        (g.greeting?'<tr><td>Greeting</td><td>'+esc(g.greeting)+'</td></tr>':'')+
        (g.bio?'<tr><td>Bio</td><td>'+esc(g.bio)+'</td></tr>':'')+
        (g.personality?'<tr><td>Personality</td><td>'+esc(g.personality)+'</td></tr>':'')+
        (g.reply_style?'<tr><td>Reply style</td><td>'+esc(g.reply_style)+'</td></tr>':'')+
        (g.extra_rules?'<tr><td>Extra rules</td><td>'+esc(g.extra_rules)+'</td></tr>':'')+
        ((g.languages||[]).length?'<tr><td>Languages</td><td>'+esc(g.languages.join(', '))+'</td></tr>':'')+
        ((g.tags||[]).length?'<tr><td>Tags</td><td>'+esc(g.tags.join(', '))+'</td></tr>':'')+
        (g.knowledge_base?'<tr><td>Knowledge base</td><td>'+esc(g.knowledge_base)+'</td></tr>':'')+
        (hasExamples?'<tr><td>Example chats</td><td>'+g.example_messages.slice(0,4).map(m=>'<div class="imag-ex">'+esc((m.role||'user')+': '+m.content)+'</div>').join('')+'</td></tr>':'')+
        socials+
        '</table>'+
        '<div class="imag-actions">'+
          '<button class="btn sm success" onclick="acceptImag()">✓ Accept & fill form</button> '+
          '<button class="btn sm" onclick="regenImag()">↻ Regenerate</button>'+
        '</div>'+
      '</div>';
    toast('Character drafted — review below');
    $('imResults').scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(e){clearInterval(anim);$('imResults').innerHTML='<div class="pg-error">'+esc(e.message)+'</div>';toast(e.message,true)}
  btn.disabled=false;
}
function acceptImag(){
  if(!imDraft)return;
  const g=imDraft;
  applyCharacterDraft(g);
  toast('Accepted — review fields above, tweak anything, then Save');
  const p=$('imagPanel');if(p)p.classList.add('hidden');
  const cName=$('cName');if(cName)cName.focus();
}
function regenImag(){imDraft=null;$('imGenBtn').disabled=false;runImagine()}
// shared: fill the character form from a draft (imagine or autogen)
function applyCharacterDraft(g){
  $('cName').value=g.name||'';$('cSlug').value='';
  $('cTagline').value=g.tagline||'';$('cGreeting').value=g.greeting||'';
  $('cBio').value=g.bio||'';$('cPersonality').value=g.personality||'';
  $('cReplyStyle').value=g.reply_style||'';$('cExtraRules').value=g.extra_rules||'';
  $('cKnowledge').value=g.knowledge_base||'';
  $('cLanguages').value=(g.languages||['English']).join(', ');
  $('cTags').value=(g.tags||[]).join(', ');
  $('cExamples').value=(g.example_messages||[]).map(m=>(m.role||'user')+': '+m.content).join('\n');
  const verified=document.querySelector('#cVerified');if(verified)verified.checked=true;
  const act=document.querySelector('#cActive');if(act)act.checked=true;
  if(Array.isArray(g.social_links)&&g.social_links.length){
    socialLinksDraft=g.social_links.map(s=>({type:s.type||'website',label:s.label||s.type||'',url:s.url||''}));
    renderSocialRows();
  }
}
async function runScrape(){
  const links=$('agLinks').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if(!links.length){toast('Paste at least one link',true);return}
  const res=$('agResults');
  const btn=document.querySelector('#autogenPanel button.btn');
  btn.disabled=true;
  agShow('Scraping '+links.length+' source'+(links.length===1?'':'s')+'…');
  try{
    const d=await api('/autogen/scrape',{method:'POST',body:JSON.stringify({links})});
    agSources=d.sources;
    $('agGenBtn').disabled = d.ok===0;
    res.innerHTML='<div class="src-list">'+(agSources.map(s=>'<div class="src '+(s.status==='ok'?'ok':'err')+'">'+
      '<div class="src-url">'+esc(s.url)+' <span class="badge '+(s.status==='ok'?'green':'red')+'">'+(s.status==='ok'?'scraped · '+s.wordCount+' words':'failed')+'</span></div>'+
      (s.error?'<div class="src-err">'+esc(s.error)+'</div>':'<div class="src-excerpt">'+esc((s.excerpt||'').slice(0,280))+'…</div>')+
      '</div>').join('')||'')+
      '<div class="src-tip">Review the scraped content above — your replies will be based ONLY on this. If something is wrong, edit the links and scrape again.</div></div>';
    toast('Scraped '+d.ok+'/'+agSources.length+' sources');
  }catch(e){res.innerHTML='<div class="pg-error">'+esc(e.message)+'</div>'}
  btn.disabled=false;
}
async function runAutogen(){
  const usable=agSources.filter(s=>s.status==='ok'&&s.text);
  if(!usable.length){toast('No scraped content to build from',true);return}
  const btn=$('agGenBtn');btn.disabled=true;
  const stages=[
    ['Reading verified sources…',6],
    ['Learning the voice & tone…',28],
    ['Drafting personality…',50],
    ['Writing knowledge base…',70],
    ['Building example chats…',84],
    ['Finalizing profile…',93],
  ];
  let si=0;
  const anim=setInterval(()=>{
    if(si<stages.length){const [m,p]=stages[si++];agShow(m,p)}
  },6000);
  agShow('Starting character build…',0);
  try{
    const d=await api('/autogen/generate',{method:'POST',body:JSON.stringify({sources:usable,hint:$('agHint').value.trim()})});
    clearInterval(anim);
    const g=d.draft||{};
    applyCharacterDraft(g);
    agShow('Done',100);
    $('agResults').innerHTML='<div class="ag-progress"><div class="ag-bar"><div class="ag-fill" style="width:100%"></div></div>'+
      '<div class="src-tip" style="margin-top:10px;border-color:#34c75944;color:var(--success)">✓ Character drafted from '+(d.sources||[]).length+' source(s). Review every field above, tweak anything, then Save.</div></div>';
    toast('Character drafted — review & save');
    loadAutogenSocials(d.sources||[]);
  }catch(e){clearInterval(anim);$('agResults').innerHTML='<div class="pg-error">'+esc(e.message)+'</div>';toast(e.message,true)}
  btn.disabled=false;
}
function loadAutogenSocials(sources){
  if(!Array.isArray(sources)||!sources.length)return;
  const seen=new Set(socialLinksDraft.map(s=>s.url));
  const added=[];
  sources.forEach(s=>{
    const url=String(s.url||'');
    if(seen.has(url))return;
    const host=url.replace(/^https?:\/\//,'').split('/')[0];
    let type='website';
    if(/instagram/.test(host))type='instagram';
    else if(/facebook|fb\./.test(host))type='facebook';
    else if(/youtube|youtu\./.test(host))type='youtube';
    else if(/tiktok/.test(host))type='tiktok';
    else if(/x\.com|twitter/.test(host))type='twitter/x';
    socialLinksDraft.push({type,label:host,url});seen.add(url);added.push(host);
  });
  renderSocialRows();
  if(added.length)toast('Added '+added.length+' social link(s) — saved with character');
}

// ── playground ──────────────────────────────────────────
const PG_PALETTE=['#0a84ff','#30d158','#ff9f0a','#ff375f','#bf5af2','#64d2ff','#ffd60a','#ff6482'];
let pgLive=null;           // chatId when browsing a live WhatsApp conversation
let pgLiveSession='';      // session name of the live conversation being viewed
let pgHistoryCount=0;      // stored playground messages for the open character

function pgColor(id){let h=0;for(const ch of String(id))h=(h*31+ch.charCodeAt(0))>>>0;return PG_PALETTE[h%PG_PALETTE.length]}
function pgNow(t){const d=t?new Date(t):new Date();return isNaN(d)?'':d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function pgDay(t){const d=new Date(t);return isNaN(d)?'':d.toLocaleDateString([],{month:'short',day:'numeric'})}
function pgBubble(role,name,text,meta,at){
  return '<div class="msg '+role+'"><div class="bub">'+esc(text)+'</div>'+
    '<div class="meta">'+esc(name)+(meta?' · '+esc(meta):'')+' · '+pgNow(at)+'</div></div>';
}
function shortChat(chat){
  const m=String(chat||'').split('@')[0];
  return m.length>16?m.slice(0,7)+'…'+m.slice(-4):(m||'chat');
}
function pgHello(name,tagline,initial){
  return '<div class="pg-hello"><div class="pg-avatar big">'+esc(initial)+'</div>'+
    '<strong>'+esc(name)+'</strong>'+
    '<div class="pg-tip">'+(tagline?esc(tagline):'Ask anything — this character answers as its persona.')+'</div></div>';
}
function pgSetComposer(enabled){
  const msg=$('pgMsg'), send=document.querySelector('.pg-send'), comp=document.querySelector('.pg-composer');
  msg.readOnly=!enabled;
  if(send)send.disabled=!enabled;
  if(enabled){msg.placeholder='Message…';comp.classList.remove('live')}
  else{msg.placeholder='Read-only — viewing a live WhatsApp conversation';comp.classList.add('live')}
}
async function openPlayground(id){
  const c=characters.find(x=>x.id===id);
  if(!c)return;
  if(!window.__pgKeyBound){window.__pgKeyBound=true;window.addEventListener('keydown',e=>{if(e.key==='Escape')closePlayground()})}
  const ch=$('pgName');
  ch.textContent=c.name;
  const av=$('pgAvatar');
  av.textContent=(c.name||'?').trim().charAt(0).toUpperCase();
  av.style.background=pgColor(id);
  $('pgCharId').value=id;
  $('pgMsg').value='';
  const meta=[];
  if(c.model)meta.push(c.model);
  if(c.languages&&c.languages.length)meta.push(c.languages.join(', '));
  $('pgMeta').textContent=meta.join(' · ')||'ready to chat';
  $('pgChips').innerHTML=(c.personality?String(c.personality).split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean).slice(0,4):[])
    .map(p=>'<span class="chip">'+esc(p)+'</span>').join('');
  pgLive=null;pgLiveSession='';
  pgSetComposer(true);
  $('pgOverlay').classList.remove('hidden');
  await loadPgHistory();
  setTimeout(()=>$('pgMsg').focus(),50);
}
function closePlayground(){$('pgOverlay')?.classList.add('hidden')}
function pgKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendPlayground()}}
function pgScroll(){const o=$('pgOut');o.scrollTop=o.scrollHeight}
function pgTyping(on){
  const o=$('pgOut');
  const t=o.querySelector('.typing');
  if(on&&!t)o.insertAdjacentHTML('beforeend','<div class="msg out typing"><div class="bub"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div></div>');
  else if(!on&&t)t.remove();
  pgScroll();
}
function fmtWhen(at){
  if(!at)return '';
  const d=new Date(at);
  if(isNaN(d))return '';
  return pgDay(d)+' · '+pgNow(at);
}
async function loadPgHistory(){
  const cid=$('pgCharId').value;
  if(!cid)return;
  const out=$('pgOut');
  let msgs=[];
  try{const d=await api('/playground/history/'+encodeURIComponent(cid));msgs=d.messages||[]}catch(e){}
  pgHistoryCount=msgs.length;
  $('pgCount').textContent=msgs.length+(msgs.length===1?' message':' messages');
  if(msgs.length){
    out.innerHTML=msgs.map(m=>pgBubble(m.role==='user'?'in':'out', m.role==='user'?'You':$('pgName').textContent, m.content, null, m.at)).join('');
    const last=msgs[msgs.length-1];
    out.insertAdjacentHTML('beforeend','<div class="pg-divider">continued today</div>');
  }else{
    const av=$('pgAvatar');
    out.innerHTML=pgHello($('pgName').textContent, characters.find(x=>x.id===cid)?.tagline, av.textContent);
  }
  pgScroll();
  renderPgLive();
}
async function renderPgLive(){
  const cid=$('pgCharId').value;
  const el=$('pgLiveList');
  if(!cid||!el)return;
  let chats=[];
  try{const d=await api('/playground/live/'+encodeURIComponent(cid));chats=d.chats||[]}catch(e){}
  if(!chats.length){el.innerHTML='<div class="pg-tip">No WhatsApp conversations for this character yet.</div>';return}
  el.innerHTML=chats.map(c=>
    '<div class="chat-row" onclick="pgOpenLive(\''+esc(c.chatId)+'\')">'+
      '<div class="chat-row-top"><strong>'+esc(shortChat(c.chatId))+'</strong><span class="badge">'+c.n+'</span></div>'+
      '<div class="chat-row-sub">'+esc(c.lastBody||'')+'</div>'+
      '<div class="chat-row-time">'+fmtWhen(c.lastAt)+'</div>'+
    '</div>').join('');
}
async function pgOpenLive(chatId){
  const cid=$('pgCharId').value;
  pgLive=chatId;
  pgSetComposer(false);
  const out=$('pgOut');
  out.innerHTML='<div class="pg-divider live"><span>LIVE · '+esc(shortChat(chatId))+'</span>'+
    '<button class="btn sm" onclick="pgBackToPlayground()">Back to playground</button></div>';
  try{
    const d=await api('/playground/live/'+encodeURIComponent(cid)+'/'+encodeURIComponent(chatId));
    for(const m of d.messages||[]){
      out.insertAdjacentHTML('beforeend',pgBubble(
        m.role==='user'?'in':'out',
        m.role==='user'?'Contact':$('pgName').textContent,
        m.content, m.session||null, m.at));
    }
  }catch(e){
    out.insertAdjacentHTML('beforeend','<div class="pg-error">'+esc(e.message)+'</div>');
  }
  pgScroll();
}
function pgBackToPlayground(){
  pgLive=null;pgLiveSession='';
  pgSetComposer(true);
  loadPgHistory();
}
async function clearPgHistory(charId){
  if(!charId)return;
  await api('/playground/history/'+encodeURIComponent(charId),{method:'DELETE'});
  toast('Playground history cleared');
  openPlayground(charId);
}
function pgRandInt(min,max){min=Math.max(0,min|0);max=Math.max(0,max|0);if(max<min)max=min;return Math.floor(Math.random()*(max-min+1))+min}
function pgMediaCards(urls){
  if(!urls||!urls.length)return '';
  return urls.map(u=>'<a class="pg-media" href="'+esc(u)+'" target="_blank" rel="noopener">'+
    (/(\.(jpg|jpeg|png|gif|webp)(\?|$))|drive\.google/i.test(u)
      ?'<img src="'+esc(u)+'" alt="media" loading="lazy" onerror="this.closest(\'.pg-media\').classList.add(\'nothumb\');this.remove()">'
      :'')+
    '<span class="pg-media-link">'+esc(u)+'</span></a>').join('');
}
async function sendPlayground(){
  if(pgLive){toast('Viewing a live conversation — switch back to the playground to send',true);return}
  const cid=$('pgCharId').value;
  const msg=$('pgMsg').value.trim();
  if(!msg){toast('Type a message first',true);return}
  const history=($('pgContext').value.split('\n').map(l=>{
    const m=l.match(/^(user|assistant|character):\s?(.*)$/i);
    return m?{role:m[1].toLowerCase()==='user'?'user':'assistant',content:m[2]}:null;
  }).filter(Boolean)||[]);
  const out=$('pgOut');
  if(out.querySelector('.pg-hello'))out.innerHTML='';
  out.insertAdjacentHTML('beforeend',pgBubble('in','You',msg));
  $('pgMsg').value='';
  const send=document.querySelector('.pg-send');
  if(send)send.disabled=true;
  $('pgMsg').readOnly=true;

  // Human-like reading → typing phases, same feel as the real webhook.
  const typing=me?.typing||{};
  const simOn=typing.enabled!==false;
  const rr=typing.readDelayMs||[2000,5000];
  const status=$('pgStatus');
  let dotsTimer=null;
  const showTyping=()=>{pgTyping(true);if(status){status.textContent='Typing…';status.classList.add('on')}};
  if(simOn&&status){status.textContent='Reading…';status.classList.add('on');dotsTimer=setTimeout(showTyping,pgRandInt(rr[0],rr[1]))}
  else showTyping();

  try{
    const d=await api('/playground',{method:'POST',body:JSON.stringify({characterId:cid,message:msg,history})});
    clearTimeout(dotsTimer);pgTyping(false);
    if(status){status.classList.remove('on');status.textContent=''}
    const meta=[d.model+' · '+d.latencyMs+'ms'];
    if(d.typingMs)meta.push('typed '+Math.round(d.typingMs/1000)+'s');
    out.insertAdjacentHTML('beforeend',pgBubble('out',$('pgName').textContent,d.reply||'(empty reply)',meta.join(' · ')));
    if(d.media&&d.media.length)out.insertAdjacentHTML('beforeend',pgMediaCards(d.media));
    pgHistoryCount+=2;
    $('pgCount').textContent=pgHistoryCount+(pgHistoryCount===1?' message':' messages');
  }catch(e){
    clearTimeout(dotsTimer);pgTyping(false);
    if(status){status.classList.remove('on');status.textContent=''}
    out.insertAdjacentHTML('beforeend','<div class="pg-error">'+esc(e.message)+'</div>');
  }
  if(send)send.disabled=false;
  $('pgMsg').readOnly=false;
  $('pgMsg').focus();
  pgScroll();
}

// ── sessions ────────────────────────────────────────────
async function loadSessions(manual){
  const el=$('sessionRows');
  el.innerHTML='<tr><td colspan="5"><div class="empty">'+(manual?'Refreshing...':'Loading...')+'</div></td></tr>';
  let data;
  try{data=await api('/sessions')}catch(e){
    if(e.configMissing)el.innerHTML=emptyRows(5,e.message);
    else el.innerHTML=emptyRows(5,e.message+' — connect your OpenWA in Settings first');
    return;
  }
  const list=data.sessions||[];
  if(!list.length){el.innerHTML=emptyRows(5,'No sessions found in your OpenWA');return}
  el.innerHTML=list.map(s=>{
    const opts='<option value="">(none — use default)</option>'+characters.map(c=>'<option value="'+c.id+'"'+(c.id===s.character_id?' selected':'')+'>'+esc(c.name)+'</option>').join('');
    const off=s.disconnected_at?'<div style="font-size:10px;color:var(--danger)">offline since '+fmt(s.disconnected_at)+'</div>':'';
    return '<tr>'+
      '<td><strong>'+esc(s.name)+'</strong><div style="font-size:10px;color:var(--muted)">'+esc(s.openwa_session_id)+'</div>'+off+'</td>'+
      '<td>'+badge(s.status)+'</td>'+
      '<td>'+esc(s.phone||'—')+'</td>'+
      '<td><select onchange="assignSession(\''+s.id+'\',this.value)">'+opts+'</select></td>'+
      '<td><button class="btn sm" onclick="registerSessWebhooks(\''+s.id+'\')">Register</button></td>'+
    '</tr>';
  }).join('');
}

async function assignSession(id,characterId){
  try{
    await api('/sessions/'+id,{method:'PUT',body:JSON.stringify({character_id:characterId||null})});
    toast('Session → character updated');
  }catch(e){toast(e.message,true);loadSessions()}
}

async function registerSessWebhooks(id){
  try{
    const d=await api('/sessions/'+id+'/webhooks/register',{method:'PUT',body:JSON.stringify({})});
    toast('Registered '+d.urls.length+' webhook(s)');
  }catch(e){toast(e.message,true)}
}

// ── webhooks ────────────────────────────────────────────
function isPrivateWebhookHost(host){
  host=(host||'').toLowerCase();
  if(!host||host==='localhost'||host.endsWith('.localhost'))return true;
  const h=host.replace(/^\[|\]$/g,'').split(':')[0];
  if(/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h))return true;
  if(/^172\./.test(h)){
    const n=parseInt(h.split('.')[1],10);
    if(n>=16&&n<=31)return true;
  }
  if(/^169\.254\./.test(h))return true;
  if(/^[0-9a-f:]+$/.test(h)&&h.includes('::'))return true;
  return false;
}
function showWebhookTip(url){
  const tip=$('webhookTip');
  if(!tip)return;
  let host;
  try{host=new URL(url).hostname}catch{return}
  const priv=isPrivateWebhookHost(host);
  const lines=[];
  if(priv)lines.push('This host ('+esc(host)+') is private/local. OpenWA will refuse to deliver to it unless its SSRF_ALLOWED_HOSTS includes it, and the host must be reachable from OpenWA (not from your browser).');
  else lines.push('This host resolves publicly, so OpenWA can deliver to it — as long as it points at this bridge.');
  tip.style.display=lines.length?'block':'none';
  tip.innerHTML='<strong>Reachability:</strong> '+lines.join(' ');
}
async function loadWebhooks(){
  let d;
  try{d=await api('/webhooks')}catch{return}
  $('genWebhookRow').innerHTML='<tr><td style="width:120px"><strong>All messages</strong></td>'+
    '<td><code>'+esc(d.generic.url)+'</code></td>'+
    '<td style="width:80px"><button class="btn sm" onclick="copyText(\''+esc(d.generic.url)+'\')">Copy</button></td></tr>';
  $('charWebhookRows').innerHTML=(d.webhooks||[]).map(w=>'<tr>'+
    '<td><strong>'+esc(w.characterName)+'</strong><div style="font-size:10px;color:var(--muted)">'+esc(w.slug)+'</div></td>'+
    '<td><code>'+esc(w.url)+'</code></td>'+
    '<td style="width:80px"><button class="btn sm" onclick="copyText(\''+esc(w.url)+'\')">Copy</button></td></tr>').join('') ||
    emptyRows(3,'Create characters to get per-character webhooks');
  showWebhookTip(d.generic.url);
}

async function regenerateToken(){
  if(!confirm('Regenerating invalidates all your webhook URLs (you must update OpenWA). Continue?'))return;
  try{
    const d=await api('/webhooks/regenerate',{method:'POST'});
    me.webhook_token=d.token;
    toast('Token regenerated — update OpenWA webhooks');
    loadWebhooks();refreshAll();
  }catch(e){toast(e.message,true)}
}

// ── stats (user) ────────────────────────────────────────
let uPage=1;
function stFilters(){
  const range=document.querySelector('#stRange button.active')?.dataset.r||'30d';
  return 'range='+range+'&sessionId='+encodeURIComponent($('stSession').value)+'&characterId='+encodeURIComponent($('stCharacter').value);
}
document.querySelectorAll('#stRange button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('#stRange button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');loadUserStats(true);
});
async function loadUserStats(){
  try{
    const d=await api('/dashboard/stats?'+stFilters());
    const s=d.stats;
    $('stMsgs').textContent=s.messages;$('stIn').textContent=s.incoming;$('stOut').textContent=s.outgoing;
    $('stRate').textContent=pct(s.outgoing,s.incoming);
    d.perSession.forEach(x=>{if(!document.querySelector('#stSession option[value="'+x.id+'"]')){const o=document.createElement('option');o.value=x.id;o.textContent=x.name||x.openwa_session_id;$('stSession').appendChild(o)}});
    d.perCharacter.forEach(x=>{if(!document.querySelector('#stCharacter option[value="'+x.id+'"]')){const o=document.createElement('option');o.value=x.id;o.textContent=x.name;$('stCharacter').appendChild(o)}});
    const selS=$('stSession').value,selC=$('stCharacter').value;
    $('stSessionRows').innerHTML=d.perSession.map(x=>'<tr><td><strong>'+esc(x.name||x.openwa_session_id)+'</strong><div style="font-size:10px;color:var(--muted)">'+esc(x.phone||'')+'</div></td><td>'+badge(x.status)+'</td><td>'+x.inbound+'</td><td>'+x.outbound+'</td><td>'+pct(x.outbound,x.inbound)+'</td><td>'+fmt(x.last_activity)+'</td></tr>').join('')||emptyRows(6,'No session activity in this period');
    $('stCharRows').innerHTML=d.perCharacter.map(x=>'<tr><td><strong>'+esc(x.name)+'</strong><div style="font-size:10px;color:var(--muted)">'+esc(x.slug)+'</div></td><td>'+x.inbound+'</td><td>'+x.outbound+'</td><td>'+pct(x.outbound,x.inbound)+'</td><td>'+fmt(x.last_activity)+'</td></tr>').join('')||emptyRows(5,'No character activity in this period');
    if(selS!==$('stSession').value||selC!==$('stCharacter').value)loadUserStats();
  }catch{}
}
async function loadUserMsgs(reset){
  if(reset)uPage=1;
  const q='range='+(document.querySelector('#stRange button.active')?.dataset.r||'30d')+
    '&sessionId='+encodeURIComponent($('stSession').value)+'&characterId='+encodeURIComponent($('stCharacter').value)+
    '&direction='+encodeURIComponent($('stDir').value)+'&chatId='+encodeURIComponent($('stChat').value.trim())+
    '&page='+uPage+'&perPage=15';
  try{
    const d=await api('/dashboard/messages?'+q);
    $('stMsgRows').innerHTML=d.messages.map(m=>'<tr><td style="white-space:nowrap">'+fmt(m.created_at)+'</td>'+
      '<td><span class="badge '+(m.direction==='incoming'?'green':'blue')+'">'+esc(m.direction==='incoming'?'in':'out')+'</span></td>'+
      '<td style="font-size:12px">'+esc(m.chat_id)+'</td><td>'+esc(m.character_name||'—')+'</td><td>'+esc(m.body.slice(0,80))+'</td></tr>').join('')||emptyRows(5,'No messages match');
    pager($('stMsgPager'),d.meta,'loadUserMsgs');
  }catch{}
}

// ── admin ───────────────────────────────────────────────
function adminTab(name){
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.atab===name));
  ['overview','users','llm'].forEach(v=>{$('adminTab-'+v).classList.toggle('hidden',v!==name)});
  if(name==='llm')loadLlm();
  if(name==='users'&&!$('adUserList').childElementCount)loadAdminUsers();
  if(name==='overview'&&!$('adUserRows').childElementCount)loadAdminStats();
}
function adFilters(){
  const range=document.querySelector('#adRange button.active')?.dataset.r||'30d';
  const q='range='+range;
  const u=$('adUser').value.trim();
  return q+(u?'&userId='+encodeURIComponent(u):'');
}
document.querySelectorAll('#adRange button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('#adRange button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');loadAdminStats(true);
});
let aUpage=1,aSpage=1,aCpage=1;
async function loadAdminStats(reset){
  if(reset){aUpage=1;aSpage=1;aCpage=1}
  const base=adFilters();
  try{
    const d=await api('/admin/stats?'+base+'&upage='+aUpage+'&spage='+aSpage+'&cpage='+aCpage);
    $('adUsers').textContent=d.platform.users;
    $('adSess').textContent=d.platform.sessions;
    $('adMsgs').textContent=d.totals.total;
    $('adIn').textContent=d.totals.incoming;$('adOut').textContent=d.totals.outgoing;
    $('adActive').textContent=d.platform.active_users_range;
    $('adUserRows').innerHTML=d.perUser.items.map(x=>'<tr><td><strong>'+esc(x.email)+'</strong><div style="font-size:10px;color:var(--muted)">'+esc(x.name||'')+'</div></td><td>'+esc(x.plan)+'</td><td>'+x.inbound+'</td><td>'+x.outbound+'</td><td>'+x.sessions_used+'</td><td>'+fmt(x.last_activity)+'</td></tr>').join('')||emptyRows(6,'No user activity in period');
    $('adSessionRows').innerHTML=d.perSession.items.map(x=>'<tr><td>'+esc(x.name||x.openwa_session_id)+'<div style="font-size:10px;color:var(--muted)">'+esc(x.phone||'')+'</div></td><td style="font-size:11px">'+esc(x.user_email)+'</td><td>'+x.inbound+'</td><td>'+x.outbound+'</td><td>'+pct(x.outbound,x.inbound)+'</td></tr>').join('')||emptyRows(5,'No activity');
    $('adCharRows').innerHTML=d.perCharacter.items.map(x=>'<tr><td>'+esc(x.name)+'<div style="font-size:10px;color:var(--muted)">'+esc(x.slug)+'</div></td><td style="font-size:11px">'+esc(x.user_email)+'</td><td>'+x.inbound+'</td><td>'+x.outbound+'</td><td>'+pct(x.outbound,x.inbound)+'</td></tr>').join('')||emptyRows(5,'No activity');
    pager($('adUserPager'),d.perUser.meta,'pageAdminUsers');
    pager($('adSessionPager'),d.perSession.meta,'pageAdminSessions');
    pager($('adCharPager'),d.perCharacter.meta,'pageAdminChars');
  }catch(e){toast(e.message,true)}
}
function pageAdminUsers(p){aUpage=p;loadAdminStats()}
function pageAdminSessions(p){aSpage=p;loadAdminStats()}
function pageAdminChars(p){aCpage=p;loadAdminStats()}

let aUPage=1;
async function loadAdminUsers(reset){
  if(reset)aUPage=1;
  const search=encodeURIComponent($('adSearch').value.trim());
  try{
    const d=await api('/admin/users?page='+aUPage+'&perPage=20'+(search?'&search='+search:''));
    $('adUserList').innerHTML=d.users.map(u=>'<tr><td><strong>'+esc(u.email)+'</strong></td><td>'+esc(u.name||'—')+'</td><td>'+esc(u.plan)+'</td><td>'+(u.role==='admin'?'<span class="badge yellow">admin</span>':esc(u.role))+'</td><td>'+u.character_count+'</td><td>'+u.session_count+'</td><td>'+u.inbound+'</td><td>'+u.outbound+'</td><td>'+fmt(u.last_activity)+'</td><td><button class="btn sm" onclick="adminUserDetail(\''+u.id+'\')">Details</button></td></tr>').join('')||emptyRows(10,'No users');
    pager($('adUserListPager'),d.meta,'pageAdminUserList');
  }catch(e){toast(e.message,true)}
}
function pageAdminUserList(p){aUPage=p;loadAdminUsers()}

let aDetPage=1;
async function adminUserDetail(id){
  aDetPage=1;
  $('adUserDetail').style.display='block';
  $('adUserDetail').innerHTML='<h3>Loading user…</h3>';
  await renderUserDetail(id);
}
async function renderUserDetail(id){
  try{
    const d=await api('/admin/users/'+id+'?page='+aDetPage+'&perPage=15');
    const u=d.user;
    let h='<div class="head"><strong>'+esc(u.name||u.email)+'</strong> <span class="spacer"></span><button class="btn sm" onclick="$(\'adUserDetail\').style.display=\'none\'">Close</button></div>';
    h+='<div class="kv"><span>Email</span>'+esc(u.email)+'</div><div class="kv"><span>Plan</span>'+esc(u.plan)+'</div><div class="kv"><span>Joined</span>'+fmt(u.created_at)+'</div>';
    h+='<div class="kv"><span>Characters</span>'+(d.characters.map(c=>esc(c.name)+' <span class="badge '+(c.active?'green':'red')+'">'+(c.active?'on':'off')+'</span>').join(' · ')||'—')+'</div>';
    h+='<div class="kv"><span>Sessions</span>'+(d.sessions.map(s=>esc(s.name||s.openwa_session_id)+' '+badge(s.status)).join(' · ')||'—')+'</div>';
    h+='<h3 style="margin-top:16px">Recent messages</h3><table><thead><tr><th>Time</th><th>Dir</th><th>Chat</th><th>Char</th><th>Body</th></tr></thead><tbody>';
    h+=d.messages.items.map(m=>'<tr><td style="white-space:nowrap;font-size:11px">'+fmt(m.created_at)+'</td><td>'+esc(m.direction)+'</td><td style="font-size:11px">'+esc(m.chat_id)+'</td><td>'+esc(m.character_name||'—')+'</td><td>'+esc(m.body.slice(0,60))+'</td></tr>').join('')||emptyRows(5,'No messages');
    h+='</tbody></table>';
    const meta=d.messages.meta;
    if(meta.total>meta.perPage){h+='<div style="margin-top:10px"><button class="btn sm" '+(meta.page<=1?'disabled':'')+' onclick="aDetPage='+(meta.page-1)+';renderUserDetail(\''+id+'\')">‹ Prev</button> <span>'+meta.page+' / '+meta.pages+'</span> <button class="btn sm" '+(meta.page>=meta.pages?'disabled':'')+' onclick="aDetPage='+(meta.page+1)+';renderUserDetail(\''+id+'\')">Next ›</button></div>'}
    $('adUserDetail').innerHTML=h;
  }catch(e){toast(e.message,true)}
}

async function loadLlm(){
  try{
    const d=await api('/admin/llm');
    $('llmTotalCalls').textContent=d.totals.calls;
    $('llmTotalTokens').textContent=fmtNum(d.totals.total_tokens);
    const active=d.endpoints.find(e=>e.id===d.active_id);
    $('llmActiveName').textContent=active?esc(active.name):'none';
    $('llmEndpointList').innerHTML=d.endpoints.map(e=>{
      const on=e.id===d.active_id;
      const u=e.usage;
      const usage=u?'<span class="llm-usage">'+fmtNum(u.total_tokens)+' tokens · '+u.calls+' calls</span>':'<span class="llm-usage muted">no usage yet</span>';
      return '<div class="llm-endpoint '+(on?'on':'')+'">'+
        '<div class="llm-ep-head">'+
          '<span class="llm-ep-name">'+esc(e.name)+(on?'<span class="badge green">ACTIVE</span>':'')+'</span>'+
          '<label class="switch" title="Set active gateway"><input type="checkbox"'+(on?' checked':'')+' onchange="toggleLlm(\''+e.id+'\')"><span class="slider"></span></label>'+
        '</div>'+
        '<div class="llm-ep-meta"><code>'+esc(e.model)+'</code>'+usage+'</div>'+
        '<div class="llm-ep-base"><code>'+esc(e.base_url)+'</code></div>'+
        '<div class="llm-ep-actions">'+
          '<button class="btn sm" onclick="testLlmById(\''+e.id+'\')">Test</button>'+
          '<button class="btn sm danger" onclick="delLlm(\''+e.id+'\',\''+escAttr(e.name)+'\')">Delete</button>'+
        '</div>'+
      '</div>';
    }).join('')||'<div class="muted" style="padding:10px 0">No endpoints — add one on the right.</div>';
    $('llmTestResult').innerHTML='';
  }catch(e){toast(e.message,true)}
}
function llmForm(){
  return {name:$('adLlmName').value.trim(),base_url:$('adLlmBase').value.trim(),bearer_token:$('adLlmBearer').value.trim()||null,model:$('adLlmModel').value.trim(),is_active:$('adLlmActive').checked};
}
async function saveLlm(){
  const body=llmForm();
  if(!body.name||!body.base_url||!body.model){toast('Name, base URL and model are required',true);return}
  try{
    await api('/admin/llm',{method:'POST',body:JSON.stringify(body)});
    toast('Endpoint saved');
    $('adLlmName').value='';$('adLlmBearer').value='';$('adLlmModel').value='';$('adLlmActive').checked=false;
    loadLlm();
  }catch(e){toast(e.message,true)}
}
async function toggleLlm(id){
  try{
    await api('/admin/llm/'+id+'/active',{method:'PATCH',body:JSON.stringify({is_active:true})});
    toast('Active gateway switched');
    loadLlm();
  }catch(e){toast(e.message,true);loadLlm()}
}
async function delLlm(id,name){
  if(!confirm('Delete endpoint “'+name+'”?'))return;
  try{
    await api('/admin/llm/'+id,{method:'DELETE'});
    toast('Endpoint deleted');
    loadLlm();
  }catch(e){toast(e.message,true)}
}
function llmResultHtml(d){
  if(d.ok===false)return '<div class="llm-res fail"><div class="llm-res-icon">✕</div><div><strong>Connection failed</strong>'+
    '<div class="llm-res-sub">'+esc(d.error||'unknown error')+'</div></div></div>';
  return '<div class="llm-res ok"><div class="llm-res-icon">✓</div><div><strong>Gateway works</strong>'+
    '<div class="llm-res-sub">'+esc(d.model||'')+' · '+d.latencyMs+'ms</div>'+
    '<div class="llm-res-reply">'+esc(d.reply||'')+'</div></div></div>';
}
async function testLlm(body){
  const el=$('llmTestResult');
  el.className='test-result';
  el.innerHTML='<div class="llm-res"><div class="spin"></div><div><strong>Testing connection…</strong>'+
    '<div class="llm-res-sub">contacting the endpoint</div></div></div>';
  try{
    const d=await api('/admin/llm/test',{method:'POST',body:JSON.stringify(body)});
    el.innerHTML=llmResultHtml(d);
  }catch(e){
    el.innerHTML=llmResultHtml({ok:false,error:e.message});
  }
}
async function testLlmById(id){
  const el=$('llmTestResult');
  el.className='test-result';
  el.innerHTML='<div class="llm-res"><div class="spin"></div><div><strong>Testing connection…</strong>'+
    '<div class="llm-res-sub">contacting the endpoint</div></div></div>';
  try{
    const d=await api('/admin/llm/'+id+'/test',{method:'POST'});
    el.innerHTML=llmResultHtml(d);
  }catch(e){
    el.innerHTML=llmResultHtml({ok:false,error:e.message});
  }
}
function testNewLlm(){
  const f=llmForm();
  testLlm({llm_base_url:f.base_url,llm_bearer:f.bearer_token||'',model:f.model||'antigravity/gemini-2.5-flash'});
}

// ── settings ────────────────────────────────────────────
async function loadSettingsForm(){
  try{const d=await api('/settings');fillSettings(d.settings)}catch{}
}
function fillSettings(s){
  $('sOpenwaBase').value=s.openwa_base_url||'';
  $('sOpenwaKey').value=s.openwa_api_key||'';
  $('sWebhookSecret').value=s.webhook_secret||'';
  $('sModel').value=s.model||'antigravity/gemini-2.5-flash';
  $('sFallback').value=s.fallback_model||'auto';
  $('sMaxTokens').value=s.max_tokens||80;
  $('sHardCap').value=s.reply_hard_cap||120;
  $('sMemory').value=s.memory_limit||40;
  const t=s.typing||{};
  $('sReadMin').value=t.readDelayMs?.[0]||2000;
  $('sReadMax').value=t.readDelayMs?.[1]||5000;
  $('sFalseStart').value=t.falseStartChance??0.35;
  $('sMinTyping').value=t.minTypingMs||2000;
  $('sMaxTyping').value=t.maxTypingMs||8000;
  $('sTypingEnabled').checked=t.enabled!==false;
  $('sAutoRegister').checked=s.webhooks_auto_register!==false;
}

async function saveSettings(){
  const body={
    openwa_base_url:$('sOpenwaBase').value.trim()||null,
    openwa_api_key:$('sOpenwaKey').value.trim()||null,
    webhook_secret:$('sWebhookSecret').value.trim()||null,
    model:$('sModel').value.trim()||'antigravity/gemini-2.5-flash',
    fallback_model:$('sFallback').value.trim()||'auto',
    max_tokens:parseInt($('sMaxTokens').value)||80,
    reply_hard_cap:parseInt($('sHardCap').value)||120,
    memory_limit:parseInt($('sMemory').value)||40,
    typing:{
      enabled:$('sTypingEnabled').checked,
      readDelayMs:[parseInt($('sReadMin').value)||2000,parseInt($('sReadMax').value)||5000],
      falseStartChance:parseFloat($('sFalseStart').value)||0.35,
      minTypingMs:parseInt($('sMinTyping').value)||2000,
      maxTypingMs:parseInt($('sMaxTyping').value)||8000,
    },
    webhooks_auto_register:$('sAutoRegister').checked,
  };
  try{
    await api('/settings',{method:'PUT',body:JSON.stringify(body)});
    toast('Settings saved — refreshing sessions');
    if(body.openwa_base_url&&body.openwa_api_key){setTimeout(()=>loadSessions(),500)}
    refreshAll();
  }catch(e){toast(e.message,true)}
}

// ── init ────────────────────────────────────────────────
document.getElementById('llmPresets')?.addEventListener('click',(e)=>{
  const b=e.target.closest('button');if(!b)return;
  document.querySelectorAll('#llmPresets button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  $('adLlmBase').value=b.dataset.b||'';
  if(b.dataset.m)$('adLlmModel').value=b.dataset.m;
});
if(token){
  api('/auth/me').then(()=>enterApp()).catch(()=>{token='';localStorage.removeItem('ob_token')});
}
setInterval(()=>{if(token&&!$('appView').classList.contains('hidden'))refreshAll()},8000);

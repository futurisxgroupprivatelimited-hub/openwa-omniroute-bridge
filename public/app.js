const API = '/api';
let token = localStorage.getItem('ob_token') || '';
let me = null;
let characters = [];
let currentCharId = null;

// ── helpers ─────────────────────────────────────────────
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function toast(msg,err){const t=$('toast');t.textContent=msg;t.className='toast show'+(err?' err':'');setTimeout(()=>t.className='toast',2500)}
function copyText(t){navigator.clipboard?.writeText(t).then(()=>toast('Copied!')).catch(()=>{const x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();document.execCommand('copy');x.remove();toast('Copied!')})}

async function api(path, opts={}){
  const headers = {'Content-Type':'application/json'};
  if(token) headers['Authorization']='Bearer '+token;
  const res = await fetch(API+path, {...opts, headers});
  const data = await res.json().catch(()=>({}));
  if(res.status===401 && token){logout();throw new Error('unauthorized')}
  if(!res.ok) throw new Error(data.error||res.status);
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
  renderOverview();
  refreshAll();
}

// ── nav ─────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item=>{
  item.onclick=()=>{
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));
    item.classList.add('active');
    ['overview','characters','sessions','webhooks','settings'].forEach(v=>{
      $('view-'+v).classList.toggle('hidden', v!==item.dataset.view);
    });
    if(item.dataset.view==='characters')loadCharacters();
    if(item.dataset.view==='sessions')loadSessions();
    if(item.dataset.view==='webhooks')loadWebhooks();
    if(item.dataset.view==='settings')loadSettingsForm();
  };
});

// ── overview ────────────────────────────────────────────
async function refreshAll(){
  try{
    const d=await api('/dashboard/stats');
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
    else if(l.includes('[webhook]')||l.includes('[handle]')){cls='t-webhook';tag='WH'}
    return '<div class="log-line"><span class="tag '+cls+'">'+(tag?'['+tag+']':'')+'</span>'+esc(l.replace(/^\[.*?\]\s*/,''))+'</div>';
  }).join('');
  el.scrollTop=el.scrollHeight;
}

// ── characters ──────────────────────────────────────────
async function loadCharacters(){
  const d=await api('/characters');
  characters=d.characters;
  const el=$('charList');
  if(!characters.length){el.innerHTML='<div class="empty">No characters yet. Create your first persona.</div>';return}
  el.innerHTML=characters.map(c=>{
    const active=c.active?'<span class="badge green">active</span>':'<span class="badge red">inactive</span>';
    const webhook = me?`${location.origin}/webhook/${me.webhook_token}/${c.slug}`:'';
    return '<div class="char-form" data-id="'+c.id+'">'+
      '<div class="head"><strong>'+esc(c.name)+'</strong> '+active+
      ' <span class="spacer"></span>'+
      '<button class="btn sm" onclick="fillCharacter(\''+c.id+'\')">Edit</button> '+
      '<button class="btn sm danger" onclick="delCharacter(\''+c.id+'\')">Delete</button></div>'+
      '<div style="font-size:11px;color:var(--muted)">slug: '+esc(c.slug)+' · webhook: <code>'+esc(webhook)+'</code></div>'+
      '<div style="font-size:12px;color:var(--muted);margin-top:6px">'+esc(c.tagline||c.personality?.slice(0,90)||'')+'</div>'+
    '</div>';
  }).join('');
}

function newCharacter(){
  currentCharId=null;
  showCharEditor({
    name:'',slug:'',tagline:'',greeting:'',bio:'',personality:'',reply_style:'',extra_rules:'',
    languages:['English'],tags:[],visibility:'private',active:true,
    example_messages:[],typing_profile:{}
  });
}

function fillCharacter(id){
  const c=characters.find(x=>x.id===id);if(!c)return;
  currentCharId=id;
  showCharEditor(c);
}

function showCharEditor(c){
  const el=$('charList');
  el.innerHTML='<div class="char-form">'+
    '<div class="head"><strong>'+(currentCharId?'Edit Character':'New Character')+'</strong>'+
    ' <span class="spacer"></span>'+
    '<button class="btn sm success" onclick="saveCharacter()">Save</button> '+
    '<button class="btn sm" onclick="loadCharacters()">Cancel</button></div>'+
    '<div class="grid2">'+
      '<div><label>Name</label><input id="cName" value="'+esc(c.name)+'"></div>'+
      '<div><label>Slug (webhook url)</label><input id="cSlug" value="'+esc(c.slug)+'" placeholder="auto from name"></div>'+
    '</div>'+
    '<label>Tagline</label><input id="cTagline" value="'+esc(c.tagline)+'">'+
    '<label>Greeting</label><input id="cGreeting" value="'+esc(c.greeting)+'" placeholder="First message for a new chat">'+
    '<label>Bio</label><textarea id="cBio" rows="3">'+esc(c.bio)+'</textarea>'+
    '<label>Personality</label><textarea id="cPersonality" rows="2">'+esc(c.personality)+'</textarea>'+
    '<label>Reply Style</label><textarea id="cReplyStyle" rows="2">'+esc(c.reply_style)+'</textarea>'+
    '<label>Extra Rules</label><textarea id="cExtraRules" rows="2">'+esc(c.extra_rules)+'</textarea>'+
    '<div class="grid2">'+
      '<div><label>Languages (comma)</label><input id="cLanguages" value="'+esc((c.languages||[]).join(', '))+'" placeholder="English, Nepali"></div>'+
      '<div><label>Tags (comma)</label><input id="cTags" value="'+esc((c.tags||[]).join(', '))+'" placeholder="actress, model"></div>'+
    '</div>'+
    '<label>Example messages (user: / assistant: per line)</label><textarea id="cExamples" rows="3">'+esc(renderExamples(c.example_messages))+'</textarea>'+
    '<div class="flex" style="margin-top:12px">'+
      '<label class="flex" style="margin:0"><input id="cActive" type="checkbox" style="width:auto"'+(c.active?' checked':'')+'> Active</label>'+
      '<label class="flex" style="margin:0"><input id="cVisibility" type="checkbox" style="width:auto"'+(c.visibility==='public'?' checked':'')+'> Public</label>'+
    '</div>'+
  '</div>';
}

function renderExamples(ex){
  return (ex||[]).map(m=>(m.role||'user')+': '+m.content).join('\n');
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
    languages:$('cLanguages').value.split(',').map(s=>s.trim()).filter(Boolean),
    tags:$('cTags').value.split(',').map(s=>s.trim()).filter(Boolean),
    visibility:$('cVisibility').checked?'public':'private',
    active:$('cActive').checked,
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

// ── sessions ────────────────────────────────────────────
async function loadSessions(manual){
  const el=$('sessionRows');
  el.innerHTML='<tr><td colspan="5"><div class="empty">'+(manual?'Refreshing...':'Loading...')+'</div></td></tr>';
  let data;
  try{data=await api('/sessions')}catch(e){el.innerHTML='<tr><td colspan="5"><div class="empty">'+esc(e.message)+' — connect your OpenWA in Settings first</div></td></tr>';return}
  const list=data.sessions||[];
  if(!list.length){el.innerHTML='<tr><td colspan="5"><div class="empty">No sessions found in your OpenWA</div></td></tr>';return}
  el.innerHTML=list.map(s=>{
    const ready=s.status==='ready'||s.status==='active';
    const opts='<option value="">(none — use default)</option>'+characters.map(c=>'<option value="'+c.id+'"'+(c.id===s.character_id?' selected':'')+'>'+esc(c.name)+'</option>').join('');
    return '<tr>'+
      '<td><strong>'+esc(s.name)+'</strong><div style="font-size:10px;color:var(--muted)">'+esc(s.openwa_session_id)+'</div></td>'+
      '<td><span class="badge '+(ready?'green':'yellow')+'">'+esc(s.status)+'</span></td>'+
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
    '<tr><td colspan="3"><div class="empty">Create characters to get per-character webhooks</div></td></tr>';
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

// ── settings ────────────────────────────────────────────
async function loadSettingsForm(){
  try{const d=await api('/settings');fillSettings(d.settings)}catch{}
}
function fillSettings(s){
  $('sOpenwaBase').value=s.openwa_base_url||'';
  $('sOpenwaKey').value=s.openwa_api_key||'';
  $('sWebhookSecret').value=s.webhook_secret||'';
  $('sModel').value=s.model||'big-pickle';
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
    model:$('sModel').value.trim()||'big-pickle',
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
if(token){
  api('/auth/me').then(()=>enterApp()).catch(()=>{token='';localStorage.removeItem('ob_token')});
}
setInterval(()=>{if(token&&!$('appView').classList.contains('hidden'))refreshAll()},8000);

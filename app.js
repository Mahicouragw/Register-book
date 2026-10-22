// app.js — RegisterBook Community (localStorage demo + Supabase sync)
const DEMO_USERS = [
  { id:"mahi", name:"Mahi", email:"mahi@registerbook.demo", avatar:"https://i.pravatar.cc/100?img=5", color:"#0f766e" },
  { id:"goldfish", name:"Goldfish", email:"goldfish@registerbook.demo", avatar:"https://i.pravatar.cc/100?img=8", color:"#f59e0b" },
  { id:"silverfish", name:"Silverfish", email:"silverfish@registerbook.demo", avatar:"https://i.pravatar.cc/100?img=9", color:"#64748b" },
  { id:"priya", name:"Priya", email:"priya@registerbook.demo", avatar:"https://i.pravatar.cc/100?img=26", color:"#ec4899" },
  { id:"rahul", name:"Rahul", email:"rahul@registerbook.demo", avatar:"https://i.pravatar.cc/100?img=12", color:"#3b82f6" },
  { id:"anjali", name:"Anjali", email:"anjali@registerbook.demo", avatar:"https://i.pravatar.cc/100?img=23", color:"#8b5cf6" },
];

const STORE_KEY = "rb_data_v3";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

let state = {
  view:"home",
  registerView:{ id:null, page:1, highlightDate:null },
  chatWith:null, // userId for private chat
  groupView:null, // groupId
  searchInside:"", // inside register search
};

// Data shape
let db = {
  registers:[], // {id, ownerId, name, type, createdAt, createdAtFmt}
  entries:[], // {id, registerId, text, note, qty, amount, done, entry_date, entry_date_fmt, seq, weekday, month, year}
  shares:[], // {id, registerId, sharedWithUserId, sharedWithEmail, permission, sharedBy}
  groups:[], // {id, name, createdBy, members:[userId]}
  groupMessages:[], // {id, groupId, senderId, text, createdAt}
  friendRequests:[], // {id, fromUser, toUser, status}
  directMessages:[], // {id, senderId, receiverId, text, createdAt}
};

// Helpers
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function uid(){ return Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }
function todayFmt(){
  const d = new Date();
  const weekday = d.toLocaleDateString('en-US',{weekday:'long'});
  const month = d.toLocaleDateString('en-US',{month:'long'});
  const day = d.getDate();
  const year = d.getFullYear();
  return `${weekday}, ${month} ${day}, ${year}`;
}
function dateParts(dateObj){
  return {
    weekday: dateObj.toLocaleDateString('en-US',{weekday:'long'}),
    month: MONTHS[dateObj.getMonth()],
    monthShort: MONTHS_SHORT[dateObj.getMonth()],
    monthNum: dateObj.getMonth()+1,
    day: dateObj.getDate(),
    year: dateObj.getFullYear(),
    iso: dateObj.toISOString().slice(0,10),
  };
}
function escapeHtml(s){
  if(!s) return "";
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toast(msg, ms=2200){
  const c = $("#toast");
  const el = document.createElement("div");
  el.className="toast-item";
  el.textContent=msg;
  c.appendChild(el);
  setTimeout(()=>el.remove(), ms);
}
function getDemoUser(id){ return DEMO_USERS.find(u=>u.id===id); }
function currentUser(){
  // real Supabase user takes precedence
  const real = typeof getCurrentAuthUser==="function" ? getCurrentAuthUser() : null;
  if(real){
    return { id: real.id, name: real.user_metadata?.full_name || real.user_metadata?.name || real.email.split('@')[0], email: real.email, avatar: real.user_metadata?.avatar_url || real.user_metadata?.picture || `https://i.pravatar.cc/100?u=${encodeURIComponent(real.email)}`, isReal:true, real };
  }
  const demoId = localStorage.getItem("rb_demo_user") || "mahi";
  const u = getDemoUser(demoId) || DEMO_USERS[0];
  return {...u, isReal:false};
}
function isOwner(register){ return register.ownerId===currentUser().id; }
function canView(register){
  const me = currentUser();
  if(register.ownerId===me.id) return true;
  if(db.shares.some(s=>s.registerId===register.id && (s.sharedWithUserId===me.id || (me.email && s.sharedWithEmail===me.email)))) return true;
  // group share: if register shared to a group that I'm in? We model group shares as individual shares to each member for simplicity.
  return false;
}
function canEdit(register){ return isOwner(register); }

// Storage
function loadLocal(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      db = {...db, ...parsed};
      // ensure arrays
      for(let k of Object.keys(db)) if(!Array.isArray(db[k]) && k!=="meta") db[k]=[];
    }
  }catch(e){ console.warn("loadLocal fail",e); }
}
function saveLocal(){
  // only save if demo or even real? Keep local as cache.
  localStorage.setItem(STORE_KEY, JSON.stringify(db));
}
function ensureDemoData(){
  loadLocal();
  if(db.registers.length>0) return; // already seeded
  // Seed: Goldfish medicine checklist with ~25 entries across 3 pages (to simulate 20-30 pages story, we do 3 pages for demo but mention unlimited)
  const now = new Date();
  const goldfishId="goldfish", mahiId="mahi", priyaId="priya";
  const r1id = uid(), r2id=uid(), r3id=uid();
  db.registers.push(
    {id:r1id, ownerId:goldfishId, name:"Medicine Checklist — Ward A", type:"Medical Checklist", createdAt:new Date().toISOString(), createdAtFmt: todayFmt()},
    {id:r2id, ownerId:goldfishId, name:"Daily Bills — Oct 2026", type:"Bill Book", createdAt:new Date().toISOString(), createdAtFmt: todayFmt()},
    {id:r3id, ownerId:mahiId, name:"Staff Attendance Oct", type:"Attendance Register", createdAt:new Date().toISOString(), createdAtFmt: todayFmt()},
  );
  // Generate entries for r1: 25 lines, dates spread over Oct 1..5
  let seq=1;
  for(let i=0;i<25;i++){
    const d = new Date(2026, 9, 1 + Math.floor(i/5)); // Oct = 9 (0-indexed), days 1-5, 5 entries per day
    const dp = dateParts(d);
    db.entries.push({
      id:uid(), registerId:r1id, text: `Paracetamol 500mg — ${10+i} strips checked`, note: i%3===0?"Verified by nurse":"", qty:null, amount:null, done: i<8,
      entry_date: dp.iso, entry_date_fmt: `${dp.weekday}, ${dp.month} ${dp.day}, ${dp.year}`, seq: seq++, weekday:dp.weekday, month:dp.month, monthShort:dp.monthShort, monthNum:dp.monthNum, day:dp.day, year:dp.year
    });
  }
  // Bill book entries with qty/amount
  seq=1;
  for(let i=0;i<12;i++){
    const d = new Date(2026, 9, 10+i);
    const dp=dateParts(d);
    db.entries.push({
      id:uid(), registerId:r2id, text: `Medicine supplier payment #${i+1}`, note:"", qty: 5+i, amount: 150*(i+1), done:false,
      entry_date:dp.iso, entry_date_fmt:`${dp.weekday}, ${dp.month} ${dp.day}, ${dp.year}`, seq:seq++, weekday:dp.weekday, month:dp.month, monthShort:dp.monthShort, monthNum:dp.monthNum, day:dp.day, year:dp.year
    });
  }
  // Attendance
  seq=1;
  for(let i=0;i<8;i++){
    const d=new Date(2026,9,20+i);
    const dp=dateParts(d);
    db.entries.push({id:uid(), registerId:r3id, text:`${["Mahi","Goldfish","Priya","Rahul"][i%4]} — Present`, note:"", qty:null, amount:null, done:false, entry_date:dp.iso, entry_date_fmt:`${dp.weekday}, ${dp.month} ${dp.day}, ${dp.year}`, seq:seq++, weekday:dp.weekday, month:dp.month, monthShort:dp.monthShort, monthNum:dp.monthNum, day:dp.day, year:dp.year});
  }
  // Shares: Goldfish shares r1 with Silverfish (the core story) and with Priya
  db.shares.push(
    {id:uid(), registerId:r1id, sharedWithUserId:"silverfish", sharedWithEmail:"silverfish@registerbook.demo", permission:"view", sharedBy:goldfishId, createdAt:new Date().toISOString()},
    {id:uid(), registerId:r1id, sharedWithUserId:"priya", sharedWithEmail:"priya@registerbook.demo", permission:"view", sharedBy:goldfishId, createdAt:new Date().toISOString()}
  );
  // Groups
  const g1id=uid();
  db.groups.push({id:g1id, name:"Ward Staff", createdBy:goldfishId, members:["goldfish","silverfish","priya"]});
  db.groupMessages.push({id:uid(), groupId:g1id, senderId:"goldfish", text:"Welcome to Ward Staff group! Shared register will appear here.", createdAt:new Date().toISOString()});
  // Friend requests
  db.friendRequests.push({id:uid(), fromUser:"mahi", toUser:"rahul", status:"pending", createdAt:new Date().toISOString()});
  // Direct messages
  db.directMessages.push({id:uid(), senderId:"goldfish", receiverId:"silverfish", text:"Hey Silverfish, check the medicine checklist I shared!", createdAt:new Date().toISOString()});
  saveLocal();
}

// Fuzzy search helpers
function levenshtein(a,b){
  a=a.toLowerCase(); b=b.toLowerCase();
  const m=a.length, n=b.length;
  if(Math.abs(m-n)>3) return 99;
  const dp=Array(n+1).fill(0).map((_,i)=>i);
  for(let i=1;i<=m;i++){
    let prev=dp[0]; dp[0]=i;
    for(let j=1;j<=n;j++){
      const tmp=dp[j];
      dp[j]= a[i-1]===b[j-1] ? prev : 1+Math.min(prev, dp[j], dp[j-1]);
      prev=tmp;
    }
  }
  return dp[n];
}
function normalize(s){ return s.toLowerCase().trim(); }
function monthMatches(query, monthName){
  query=normalize(query); monthName=normalize(monthName);
  if(!query) return false;
  if(monthName.includes(query) || query.includes(monthName)) return true;
  if(MONTHS_SHORT.some(m=>query.includes(m) && monthName.startsWith(m))) return true;
  // numeric month
  const num = parseInt(query,10);
  if(!isNaN(num) && num>=1 && num<=12){
    const idx = MONTHS.findIndex(m=>normalize(m)===monthName);
    if(idx+1===num) return true;
  }
  // fuzzy octobr -> october
  if(levenshtein(query, monthName)<=2) return true;
  if(levenshtein(query, monthName.slice(0,5))<=2) return true;
  // short fuzzy
  const short=monthName.slice(0,3);
  if(levenshtein(query, short)<=1) return true;
  return false;
}
function entryMatchesSearch(entry, q){
  q=normalize(q);
  if(!q) return false;
  const pageNum = Math.ceil(entry.seq/10);
  const lowerFmt = entry.entry_date_fmt ? entry.entry_date_fmt.toLowerCase() : "";
  // page queries first: "page 2", "p2"
  const pageMatch = q.match(/^page\s+(\d+)$/) || q.match(/^p(\d+)$/);
  if(pageMatch) return parseInt(pageMatch[1],10)===pageNum;
  // "23 oct" / "23 october" / "oct 23" — require BOTH day and month
  const dayMonthMatch = q.match(/^(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|[a-z]+)$/) || q.match(/^([a-z]+)\s+(\d{1,2})$/);
  if(dayMonthMatch){
    const parts = dayMonthMatch; let d, m;
    if(/^\d/.test(parts[1])){ d=parseInt(parts[1],10); m=parts[2]; } else { m=parts[1]; d=parseInt(parts[2],10); }
    if(entry.day===d && monthMatches(m, entry.month)) return true;
    return entry.text.toLowerCase().includes(q);
  }
  // bare number: could be page, day, or month — match any
  if(/^\d+$/.test(q)){
    const num = parseInt(q,10);
    if(pageNum===num || entry.day===num || entry.monthNum===num) return true;
    if(lowerFmt.includes(q)) return true;
    return false;
  }
  if(entry.entry_date && entry.entry_date.includes(q)) return true;
  if(lowerFmt.includes(q)) return true;
  if(monthMatches(q, entry.month)) return true;
  if(`${entry.day} ${entry.monthShort}`.includes(q)) return true;
  if(`${entry.monthShort} ${entry.day}`.includes(q)) return true;
  if(entry.text.toLowerCase().includes(q)) return true;
  return false;
}

// Supabase sync (when configured)
async function loadFromSupabase(user){
  const supa = typeof getSupabase==="function" ? getSupabase() : null;
  if(!supa || !user) return;
  try{
    // profiles upsert
    await supa.from("rb_profiles").upsert({id:user.id, name: currentUser().name, email: user.email, avatar_url: currentUser().avatar}, {onConflict:"id"});
    // Load registers owned + shared
    // Owned
    const {data:owned} = await supa.from("rb_registers").select("*").eq("owner_id", user.id);
    const {data:sharedRows} = await supa.from("rb_shares").select("register_id").eq("shared_with_user_id", user.id);
    let sharedRegs=[];
    if(sharedRows && sharedRows.length){
      const ids = sharedRows.map(r=>r.register_id);
      const {data:sharedData} = await supa.from("rb_registers").select("*").in("id", ids);
      sharedRegs = sharedData || [];
    }
    const allRegs = [...(owned||[]), ...sharedRegs];
    // If we got data, merge into db (keep local as fallback, but prefer server)
    if(allRegs.length>0){
      // Map server schema to local
      db.registers = allRegs.map(r=>({id:r.id, ownerId:r.owner_id, name:r.name, type:r.type, createdAt:r.created_at, createdAtFmt: new Date(r.created_at).toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}));
      // entries
      const regIds = allRegs.map(r=>r.id);
      const {data:entries} = await supa.from("rb_entries").select("*").in("register_id", regIds).order("seq",{ascending:true});
      if(entries){
        db.entries = entries.map(e=>({
          id:e.id, registerId:e.register_id, text:e.text||"", note:e.note||"", qty:e.qty, amount:e.amount, done:e.done||false,
          entry_date:e.entry_date, entry_date_fmt:e.entry_date? new Date(e.entry_date).toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}) : "",
          seq:e.seq, weekday:"", month:"", monthShort:"", monthNum:0, day:0, year:0
        }));
        // enrich month fields
        db.entries.forEach(en=>{
          if(en.entry_date){
            const d=new Date(en.entry_date);
            const dp=dateParts(d);
            en.weekday=dp.weekday; en.month=dp.month; en.monthShort=dp.monthShort; en.monthNum=dp.monthNum; en.day=dp.day; en.year=dp.year;
          }
        });
      }
      // groups, shares etc - best effort
      const {data:gm} = await supa.from("rb_group_members").select("*").eq("user_id", user.id);
      if(gm && gm.length){
        const gIds = [...new Set(gm.map(x=>x.group_id))];
        const {data:groups} = await supa.from("rb_groups").select("*").in("id", gIds);
        if(groups) db.groups = groups.map(g=>({id:g.id, name:g.name, createdBy:g.created_by, members:[]}));
        // members per group
        for(let gid of gIds){
          const {data:members} = await supa.from("rb_group_members").select("user_id").eq("group_id", gid);
          const g = db.groups.find(x=>x.id===gid);
          if(g && members) g.members = members.map(m=>m.user_id);
        }
      }
      saveLocal();
      toast("Synced from Supabase ✓");
    }
  }catch(e){
    console.warn("Supabase load failed", e);
  }
}
async function syncRegisterToSupabase(reg){
  const supa = typeof getSupabase==="function" ? getSupabase() : null;
  if(!supa || !currentUser().isReal) return;
  try{
    await supa.from("rb_registers").upsert({id:reg.id, owner_id:reg.ownerId, name:reg.name, type:reg.type, created_at: reg.createdAt});
  }catch(e){ console.warn(e); }
}
async function syncEntryToSupabase(en){
  const supa = typeof getSupabase==="function" ? getSupabase() : null;
  if(!supa || !currentUser().isReal) return;
  try{
    await supa.from("rb_entries").upsert({
      id:en.id, register_id:en.registerId, text:en.text, note:en.note, qty:en.qty, amount:en.amount, done:en.done, entry_date:en.entry_date, seq:en.seq
    });
  }catch(e){ console.warn(e); }
}

// Rendering
function renderAll(){
  loadLocal();
  updateSidebarCounts();
  renderHome();
  renderMyRegisters();
  renderShared();
  renderPeople();
  renderGroups();
  renderChats();
  // render current view
  setView(state.view);
  // also populate demo switcher
  const sel = $("#demoUserSelect");
  if(sel){
    sel.innerHTML = DEMO_USERS.map(u=>`<option value="${u.id}">${u.name} — ${u.email}</option>`).join("");
    sel.value = localStorage.getItem("rb_demo_user") || currentUser().id || "mahi";
    sel.onchange = e=>{ enterDemo(e.target.value); };
  }
  // update account card again (in case auth changed)
  // highlight pending friend count
  updatePendingBadge();
}

function updateSidebarCounts(){
  const me=currentUser();
  const myCount = db.registers.filter(r=>r.ownerId===me.id).length;
  const sharedCount = db.registers.filter(r=> canView(r) && r.ownerId!==me.id).length;
  const groupCount = db.groups.filter(g=>g.members.includes(me.id) || g.createdBy===me.id).length;
  const pending = db.friendRequests.filter(fr=>fr.toUser===me.id && fr.status==="pending").length;
  const chatUnread = db.directMessages.filter(m=>m.receiverId===me.id).length; // simple
  const set = (id,val)=>{ const el=document.getElementById(id); if(el) el.textContent=val; };
  set("countMy", myCount);
  set("countShared", sharedCount);
  set("countGroups", groupCount);
  set("countPeople", pending? pending+" new":"");
  set("countChats", db.directMessages.length? String(db.directMessages.length):"");
}

function updatePendingBadge(){
  const me=currentUser();
  const pend=db.friendRequests.filter(fr=>fr.toUser===me.id && fr.status==="pending").length;
  const el=$("#pendingBadge");
  if(el) el.textContent = pend? `${pend} pending` : "";
}

function setView(name){
  state.view=name;
  $$(".view").forEach(v=>v.style.display="none");
  const target=$("#view-"+name);
  if(target) target.style.display="block";
  // nav active
  $$(".nav-item").forEach(n=>n.classList.toggle("active", n.dataset.view===name));
  // update topbar title
  const titles={
    home:["Community Home","Registers shared with you + your community"],
    myRegisters:["My Registers","All books you created"],
    shared:["Shared With Me","Books others shared with you — view only"],
    people:["People & Friends","Find staff, send requests, share registers"],
    groups:["Groups","Create groups, chat, share to whole group"],
    chats:["Private Chats","1-to-1 messages + demo call"],
    registerDetail:["Register","Paper view • 10 lines per page"]
  };
  const t=titles[name];
  if(t){
    $("#topTitle").textContent=t[0];
    $("#topSub").textContent=t[1];
  }
  // show/hide topbar search depending on view? keep visible for registerDetail
}

function resetDemoView(){ renderAll(); }

// Home
function renderHome(){
  const me=currentUser();
  const myRegs = db.registers.filter(r=>r.ownerId===me.id);
  const sharedRegs = db.registers.filter(r=> canView(r) && r.ownerId!==me.id);
  const groups = db.groups.filter(g=>g.members.includes(me.id) || g.createdBy===me.id);
  const container=$("#view-home");
  if(!container) return;
  container.innerHTML=`
    <div class="grid grid-3">
      <div class="card kpi"><div class="kpi-icon" style="background:#ecfdf5;color:#065f46">📒</div><div class="kpi-num">${myRegs.length}</div><div class="kpi-label">My registers</div><div class="small muted mt8">${myRegs.length?"Tap My Registers to open":"Create your first book"}</div></div>
      <div class="card kpi"><div class="kpi-icon" style="background:#eff6ff;color:#1d4ed8">👁️</div><div class="kpi-num">${sharedRegs.length}</div><div class="kpi-label">Shared with me (view only)</div><div class="small muted mt8">Search works, edit is blocked</div></div>
      <div class="card kpi"><div class="kpi-icon" style="background:#fef3c7;color:#92400e">👥</div><div class="kpi-num">${groups.length}</div><div class="kpi-label">My groups</div><div class="small muted mt8">${groups.map(g=>escapeHtml(g.name)).join(", ")||"Create a group"}</div></div>
    </div>

    <div class="grid grid-2 mt12">
      <div class="card">
        <div class="card-head"><h3>Community — recent shared books</h3><span class="badge badge-green">${sharedRegs.length} shared</span></div>
        <div class="list">
          ${sharedRegs.length? sharedRegs.map(r=>{
            const owner=getDemoUser(r.ownerId) || {name:r.ownerId, avatar:`https://i.pravatar.cc/100?u=${r.ownerId}`};
            return `<div class="list-item" onclick="openRegister('${r.id}')">
              <img class="avatar" src="${owner.avatar}"><div class="flex1"><div class="strong" style="font-size:14px">${escapeHtml(r.name)}</div><div class="small muted">${escapeHtml(r.type)} • by ${escapeHtml(owner.name)} • ${new Date(r.createdAt).toLocaleDateString()}</div></div><span class="badge">View only</span>
            </div>`
          }).join("") : `<div class="empty"><div class="big">No shared books yet</div><div class="small">Goldfish → Silverfish story: Goldfish creates a checklist and shares it. Switch to Silverfish in the sidebar to see it.</div><button class="btn btn-sm mt8" onclick="demoShareStory()">Run Goldfish → Silverfish test</button></div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>My registers</h3><button class="btn btn-sm btn-primary" onclick="openCreateModal()">+ Create register</button></div>
        <div class="list">
          ${myRegs.length? myRegs.map(r=>{
            const entries=db.entries.filter(e=>e.registerId===r.id);
            const pages=Math.max(1, Math.ceil(entries.length/10));
            return `<div class="list-item" onclick="openRegister('${r.id}')"><div style="width:36px;height:36px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;display:grid;place-items:center">📄</div><div class="flex1"><div class="strong" style="font-size:14px">${escapeHtml(r.name)}</div><div class="small muted">${escapeHtml(r.type)} • ${pages} page${pages>1?'s':''} • ${entries.length} lines • ${escapeHtml(r.createdAtFmt)}</div></div><span class="badge badge-green">${pages} pages</span></div>`
          }).join("") : `<div class="empty"><div class="big">You have no registers</div><div class="small">Create one — today's date is filled automatically. You can make unlimited books.</div></div>`}
        </div>
      </div>
    </div>

    <div class="card mt12">
      <div class="card-head"><h3>How sharing works (view-only)</h3></div>
      <div class="card-pad small" style="line-height:1.6">
        <b>Goldfish writes 20–30 pages</b> of a medicine checklist → shares with <b>Silverfish</b> → Silverfish can <b>read every page, search by date/month, see suggestions</b> but <b>cannot add/edit/delete</b> because Goldfish is the owner. Enforced in the database (Row Level Security), not just by hiding buttons. Sharing: search person's name → pick register → share; or share to a whole group; or share from private chat.
      </div>
    </div>
  `;
}
function demoShareStory(){
  // Ensure Goldfish -> Silverfish share exists, toast result
  const r = db.registers.find(x=>x.ownerId==="goldfish" && x.name.includes("Medicine"));
  if(!r){ toast("Seed data missing — reloading"); ensureDemoData(); renderAll(); return; }
  const already = db.shares.some(s=>s.registerId===r.id && s.sharedWithUserId==="silverfish");
  if(!already){
    db.shares.push({id:uid(), registerId:r.id, sharedWithUserId:"silverfish", sharedWithEmail:"silverfish@registerbook.demo", permission:"view", sharedBy:"goldfish", createdAt:new Date().toISOString()});
    saveLocal(); toast("Shared Goldfish medicine checklist with Silverfish ✓");
  } else toast("Already shared ✓ — switch to Silverfish to verify view-only");
  renderAll();
}

// My Registers view
function renderMyRegisters(){
  const me=currentUser();
  const regs=db.registers.filter(r=>r.ownerId===me.id);
  const c=$("#view-myRegisters");
  if(!c) return;
  if(!regs.length){
    c.innerHTML=`<div class="card"><div class="empty"><div class="big">No registers yet</div><div class="small">Create your first register — name + type. Date is automatic.</div><button class="btn btn-primary mt8" onclick="openCreateModal()">+ Create register</button></div></div>`;
    return;
  }
  c.innerHTML=`
    <div class="card">
      <div class="card-head"><h3>My Registers — ${regs.length}</h3><button class="btn btn-sm btn-primary" onclick="openCreateModal()">+ Create register</button></div>
      <div class="list">${regs.map(r=>{
        const ents=db.entries.filter(e=>e.registerId===r.id);
        const pages=Math.max(1, Math.ceil(ents.length/10));
        const total= r.type==="Bill Book" ? ents.reduce((s,e)=>s+(Number(e.amount)||0),0) : null;
        return `<div class="list-item" onclick="openRegister('${r.id}')">
          <div style="width:40px;height:40px;border-radius:10px;background:#ecfdf5;display:grid;place-items:center;border:1px solid #a7f3d0">📒</div>
          <div style="flex:1;min-width:0"><div class="strong">${escapeHtml(r.name)}</div><div class="small muted">${escapeHtml(r.type)} • ${escapeHtml(r.createdAtFmt)} • ${pages} pages • ${ents.length} lines ${total!==null?`• ₹${total} total`:""}</div></div>
          <span class="badge">${pages} pages</span>
        </div>`;
      }).join("")}</div>
    </div>`;
}

// Shared with me
function renderShared(){
  const me=currentUser();
  const regs=db.registers.filter(r=> canView(r) && r.ownerId!==me.id);
  const c=$("#view-shared");
  if(!c) return;
  if(!regs.length){
    c.innerHTML=`<div class="card"><div class="empty"><div class="big">Nothing shared with you yet</div><div class="small">Ask Goldfish to share a register, or accept a friend request first. View-only = you can read & search, but only the creator can edit.</div></div></div>`;
    return;
  }
  c.innerHTML=`<div class="card"><div class="card-head"><h3>Shared with me — ${regs.length} (view only)</h3><span class="badge badge-amber">View only — cannot edit</span></div><div class="list">${regs.map(r=>{
    const owner=getDemoUser(r.ownerId) || {name:r.ownerId, avatar:`https://i.pravatar.cc/100?u=${r.ownerId}`};
    const ents=db.entries.filter(e=>e.registerId===r.id);
    const pages=Math.ceil(ents.length/10)||1;
    return `<div class="list-item" onclick="openRegister('${r.id}')"><img class="avatar" src="${owner.avatar}"><div style="flex:1"><div class="strong">${escapeHtml(r.name)}</div><div class="small muted">${escapeHtml(r.type)} • by ${escapeHtml(owner.name)} • ${pages} pages • ${ents.length} lines</div></div><span class="badge badge-gray">View only</span></div>`;
  }).join("")}</div></div>`;
}

// People & Friends
function renderPeople(){
  const me=currentUser();
  const c=$("#view-people");
  if(!c) return;
  const pendingIncoming=db.friendRequests.filter(fr=>fr.toUser===me.id && fr.status==="pending");
  const pendingOutgoing=db.friendRequests.filter(fr=>fr.fromUser===me.id && fr.status==="pending");
  const friendsSet=new Set();
  db.friendRequests.filter(fr=>fr.status==="accepted" && (fr.fromUser===me.id || fr.toUser===me.id)).forEach(fr=>{
    friendsSet.add(fr.fromUser===me.id? fr.toUser: fr.fromUser);
  });
  // Also consider shares as connections? But friends = accepted
  const friends=[...friendsSet].map(id=>getDemoUser(id)).filter(Boolean);
  c.innerHTML=`
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h3>Search people</h3></div>
        <div class="card-pad">
          <div class="form-row" style="margin:0"><label>Type a name</label>
            <div style="position:relative"><input id="peopleSearch" placeholder="Try Goldfish, Priya, Rahul..." oninput="handlePeopleSearch(this.value)" autocomplete="off"><div id="peopleSuggest" class="suggest-box" style="position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:5"></div></div>
            <div class="small muted">Suggestions appear as you type. Click a person to send request or share.</div>
          </div>
          <div id="peopleSearchResults" class="mt12"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Friend requests <span class="badge">${pendingIncoming.length} pending</span></h3></div>
        <div class="list">
          ${pendingIncoming.length? pendingIncoming.map(fr=>{
            const u=getDemoUser(fr.fromUser);
            return `<div class="list-item"><img class="avatar" src="${u.avatar}"><div style="flex:1"><div class="strong">${escapeHtml(u.name)}</div><div class="small muted">wants to be friends</div></div><button class="btn btn-sm btn-primary" onclick="handleFriend('${fr.id}','accepted')">Accept</button><button class="btn btn-sm" onclick="handleFriend('${fr.id}','declined')">Decline</button></div>`;
          }).join("") : `<div class="empty small">No pending requests</div>`}
          ${pendingOutgoing.length? `<div class="card-pad small muted" style="border-top:1px solid #f3f4f6"><b>Sent:</b> ${pendingOutgoing.map(fr=>getDemoUser(fr.toUser).name).join(", ")}</div>`:""}
        </div>
        <div class="card-pad" style="border-top:1px solid #f3f4f6">
          <div class="strong small">Friends — ${friends.length}</div>
          <div class="inline mt8">
            ${friends.length? friends.map(u=>`<span class="chip"><img src="${u.avatar}">${escapeHtml(u.name)}</span>`).join("") : `<span class="small muted">No friends yet. Add someone to share registers.</span>`}
          </div>
        </div>
      </div>
    </div>
    <div class="card mt12">
      <div class="card-head"><h3>All staff</h3><span class="badge">${DEMO_USERS.length} people</span></div>
      <div class="list">
        ${DEMO_USERS.filter(u=>u.id!==me.id).map(u=>{
          const isFriend=friendsSet.has(u.id);
          const isPending= db.friendRequests.some(fr=> (fr.fromUser===me.id && fr.toUser===u.id && fr.status==="pending") || (fr.fromUser===u.id && fr.toUser===me.id && fr.status==="pending"));
          const btn = isFriend ? `<span class="badge badge-green">Friends</span>` : isPending ? `<span class="badge badge-amber">Pending</span>` : `<button class="btn btn-sm btn-primary" onclick="sendFriendRequest('${u.id}')">Add friend</button>`;
          return `<div class="list-item"><img class="avatar" src="${u.avatar}"><div style="flex:1"><div class="strong">${escapeHtml(u.name)}</div><div class="small muted">${escapeHtml(u.email)}</div></div>${btn}<button class="btn btn-sm" onclick="openShareModalForUser('${u.id}')">Share register →</button></div>`;
        }).join("")}
      </div>
    </div>
  `;
}
function handlePeopleSearch(q){
  const box=$("#peopleSuggest");
  const results=$("#peopleSearchResults");
  if(!q || q.trim().length<1){ box.classList.remove("open"); box.innerHTML=""; if(results) results.innerHTML=""; return; }
  const qn=normalize(q);
  const matches=DEMO_USERS.filter(u=> u.id!==currentUser().id && (normalize(u.name).includes(qn) || levenshtein(normalize(u.name), qn)<=2) );
  if(!matches.length){ box.classList.remove("open"); return; }
  box.innerHTML=matches.map(u=>`<div onclick="selectPerson('${u.id}')"><img src="${u.avatar}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:6px">${escapeHtml(u.name)} — <span class='muted'>${escapeHtml(u.email)}</span></div>`).join("");
  box.classList.add("open");
}
function selectPerson(userId){
  $("#peopleSuggest").classList.remove("open");
  $("#peopleSearch").value=getDemoUser(userId).name;
  const u=getDemoUser(userId);
  const me=currentUser();
  const isFriend = db.friendRequests.some(fr=> fr.status==="accepted" && ((fr.fromUser===me.id && fr.toUser===userId) || (fr.fromUser===userId && fr.toUser===me.id)));
  const r=$("#peopleSearchResults");
  r.innerHTML=`
    <div class="card" style="border:1px solid #a7f3d0;background:#ecfdf5;padding:12px;border-radius:10px">
      <div class="row"><img src="${u.avatar}" class="avatar"><div><div class="strong">${escapeHtml(u.name)}</div><div class="small muted">${escapeHtml(u.email)}</div></div><span class="badge">${isFriend?'Friends':'Staff'}</span></div>
      <div class="row mt8">
        ${isFriend? `<span class="badge badge-green">You can share registers</span>` : `<button class="btn btn-sm btn-primary" onclick="sendFriendRequest('${u.id}')">Send friend request</button>`}
        <button class="btn btn-sm" onclick="openShareModalForUser('${u.id}')">Share a register →</button>
        <button class="btn btn-sm" onclick="openChat('${u.id}')">Message</button>
      </div>
    </div>
  `;
}
function sendFriendRequest(toUser){
  const me=currentUser().id;
  if(me===toUser){ toast("Can't add yourself"); return; }
  if(db.friendRequests.some(fr=> fr.fromUser===me && fr.toUser===toUser && fr.status==="pending")){ toast("Request already sent"); return; }
  if(db.friendRequests.some(fr=> fr.status==="accepted" && ((fr.fromUser===me && fr.toUser===toUser)||(fr.fromUser===toUser && fr.toUser===me)))){ toast("Already friends"); return; }
  db.friendRequests.push({id:uid(), fromUser:me, toUser, status:"pending", createdAt:new Date().toISOString()});
  saveLocal(); renderPeople(); updatePendingBadge(); updateSidebarCounts(); toast("Friend request sent to "+getDemoUser(toUser).name);
  // try supabase
  const supa=typeof getSupabase==="function"?getSupabase():null;
  if(supa && currentUser().isReal){
    supa.from("rb_friend_requests").insert({from_user:me, to_user:toUser, status:"pending"}).then(()=>{},()=>{});
  }
}
function handleFriend(reqId, status){
  const fr=db.friendRequests.find(x=>x.id===reqId);
  if(!fr) return;
  fr.status=status;
  saveLocal(); renderPeople(); updateSidebarCounts(); toast(status==="accepted"?"Accepted ✓":"Declined");
  const supa=typeof getSupabase==="function"?getSupabase():null;
  if(supa && currentUser().isReal){
    supa.from("rb_friend_requests").update({status}).eq("id", reqId).then(()=>{},()=>{});
  }
}

// Groups
function renderGroups(){
  const me=currentUser();
  const c=$("#view-groups");
  if(!c) return;
  const myGroups=db.groups.filter(g=>g.members.includes(me.id) || g.createdBy===me.id);
  c.innerHTML=`
    <div class="row" style="margin-bottom:12px"><button class="btn btn-primary" onclick="openGroupModal()">+ Create group</button><span class="small muted">Add staff, chat, share registers to whole group at once</span></div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h3>My groups — ${myGroups.length}</h3></div>
        <div class="list">
          ${myGroups.length? myGroups.map(g=>{
            const members=g.members.map(id=>getDemoUser(id)).filter(Boolean);
            return `<div class="list-item" onclick="openGroup('${g.id}')"><div style="width:36px;height:36px;border-radius:8px;background:#eff6ff;display:grid;place-items:center">👥</div><div style="flex:1"><div class="strong">${escapeHtml(g.name)}</div><div class="small muted">${members.map(m=>m.name).join(", ")||"No members"}</div></div><span class="badge">${members.length} members</span></div>`;
          }).join(""): `<div class="empty small">No groups yet. Create one.</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Group chat</h3><span class="badge">${state.groupView? "open" : "select a group"}</span></div>
        <div id="groupChatArea">
          ${state.groupView? renderGroupChatInner(state.groupView) : `<div class="empty"><div class="big">Select a group</div><div class="small">Create a group and add staff, then chat and share registers</div></div>`}
        </div>
      </div>
    </div>
  `;
}
function renderGroupChatInner(groupId){
  const g=db.groups.find(x=>x.id===groupId);
  if(!g) return `<div class="empty small">Group not found</div>`;
  const msgs=db.groupMessages.filter(m=>m.groupId===groupId).sort((a,b)=> new Date(a.createdAt)-new Date(b.createdAt));
  return `
    <div class="chat-wrap" style="height:380px">
      <div class="chat-head"><div class="strong">${escapeHtml(g.name)}</div><span class="badge">${g.members.length} members</span><button class="btn btn-sm" style="margin-left:auto" onclick="openShareToGroupModal('${g.id}')">Share register to group</button></div>
      <div class="chat-messages" id="groupMsgs">
        ${msgs.length? msgs.map(m=>{
          const u=getDemoUser(m.senderId) || {name:m.senderId, avatar:"https://i.pravatar.cc/100?u="+m.senderId};
          const me=m.senderId===currentUser().id;
          return `<div class="bubble ${me?'me':'them'}"><div style="font-size:11px;opacity:.8;margin-bottom:2px">${escapeHtml(u.name)}</div>${escapeHtml(m.text)}<div style="font-size:10px;opacity:.7;margin-top:4px">${new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div></div>`;
        }).join("") : `<div class="small muted" style="text-align:center;padding:20px">No messages yet. Say hi!</div>`}
      </div>
      <div class="chat-input"><input id="groupChatInput" placeholder="Message ${escapeHtml(g.name)}..." onkeydown="if(event.key==='Enter') sendGroupMsg('${g.id}')"><button class="btn btn-primary" onclick="sendGroupMsg('${g.id}')">Send</button></div>
    </div>
    <div class="card-pad small muted">Members: ${g.members.map(id=>getDemoUser(id)?.name||id).join(", ")}</div>
  `;
}
function openGroup(gid){
  state.groupView=gid;
  renderGroups();
  setView("groups");
  setTimeout(()=>{ const el=$("#groupMsgs"); if(el) el.scrollTop=el.scrollHeight; },50);
}
function sendGroupMsg(gid){
  const inp=$("#groupChatInput");
  if(!inp || !inp.value.trim()) return;
  db.groupMessages.push({id:uid(), groupId:gid, senderId:currentUser().id, text:inp.value.trim(), createdAt:new Date().toISOString()});
  inp.value=""; saveLocal(); renderGroups(); // re-render keeps same gid
  openGroup(gid);
  const supa=typeof getSupabase==="function"?getSupabase():null;
  if(supa && currentUser().isReal){
    supa.from("rb_group_messages").insert({group_id:gid, sender_id:currentUser().id, text:db.groupMessages[db.groupMessages.length-1].text}).then(()=>{},()=>{});
  }
}

// Private Chats
function renderChats(){
  const me=currentUser();
  const c=$("#view-chats");
  if(!c) return;
  const otherUsers=DEMO_USERS.filter(u=>u.id!==me.id);
  const selected=state.chatWith || otherUsers[0]?.id;
  // Build chat list with last message preview
  const listHtml=otherUsers.map(u=>{
    const conv=db.directMessages.filter(m=> (m.senderId===me.id && m.receiverId===u.id) || (m.senderId===u.id && m.receiverId===me.id)).sort((a,b)=> new Date(a.createdAt)-new Date(b.createdAt));
    const last=conv[conv.length-1];
    const unread=conv.filter(m=>m.receiverId===me.id).length;
    const active = (state.chatWith===u.id) ? "style='background:#ecfdf5;border-color:#a7f3d0'" : "";
    return `<div class="list-item" onclick="openChat('${u.id}')" ${active}><img class="avatar" src="${u.avatar}"><div style="flex:1;min-width:0"><div class="strong" style="font-size:13px">${escapeHtml(u.name)} ${unread?`<span class="badge badge-green">${unread}</span>`:""}</div><div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${last? escapeHtml(last.text) : "No messages yet"}</div></div><button class="btn btn-sm" onclick="event.stopPropagation();startCall('${u.id}')">📞 Call</button></div>`;
  }).join("");
  const chatInner = selected ? renderChatInner(selected) : `<div class="empty">Select a chat</div>`;
  c.innerHTML=`
    <div class="grid grid-2">
      <div class="card"><div class="card-head"><h3>Chats</h3><span class="badge">${otherUsers.length} people</span></div><div class="list">${listHtml}</div></div>
      <div class="card"><div id="chatInner">${chatInner}</div></div>
    </div>
  `;
  setTimeout(()=>{ const el=$("#chatMsgs"); if(el) el.scrollTop=el.scrollHeight; },30);
}
function renderChatInner(userId){
  const u=getDemoUser(userId);
  if(!u) return `<div class="empty">User not found</div>`;
  const me=currentUser();
  const msgs=db.directMessages.filter(m=> (m.senderId===me.id && m.receiverId===userId) || (m.senderId===userId && m.receiverId===me.id)).sort((a,b)=> new Date(a.createdAt)-new Date(b.createdAt));
  return `
    <div class="chat-wrap">
      <div class="chat-head"><img src="${u.avatar}" class="avatar"><div><div class="strong">${escapeHtml(u.name)}</div><div class="small muted">${escapeHtml(u.email)}</div></div><div class="spacer"></div><button class="btn btn-sm btn-primary" onclick="startCall('${u.id}')">📞 Call</button><button class="btn btn-sm" onclick="openShareModalForUser('${u.id}')">Share register</button></div>
      <div class="chat-messages" id="chatMsgs">
        ${msgs.length? msgs.map(m=>{
          const isMe=m.senderId===me.id;
          return `<div class="bubble ${isMe?'me':'them'}">${escapeHtml(m.text)}<div style="font-size:10px;opacity:.75;margin-top:4px">${new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div></div>`;
        }).join("") : `<div class="small muted" style="text-align:center;padding:18px">No messages yet. Say hello to ${escapeHtml(u.name)}!</div>`}
      </div>
      <div class="chat-input"><input id="chatInput" placeholder="Message ${escapeHtml(u.name)}..." onkeydown="if(event.key==='Enter') sendChat('${u.id}')"><button class="btn btn-primary" onclick="sendChat('${u.id}')">Send</button></div>
    </div>
  `;
}
function openChat(userId){
  state.chatWith=userId;
  setView("chats");
  renderChats();
}
function sendChat(userId){
  const inp=$("#chatInput");
  if(!inp || !inp.value.trim()) return;
  const me=currentUser().id;
  db.directMessages.push({id:uid(), senderId:me, receiverId:userId, text:inp.value.trim(), createdAt:new Date().toISOString()});
  inp.value=""; saveLocal(); renderChats();
  const supa=typeof getSupabase==="function"?getSupabase():null;
  if(supa && currentUser().isReal){
    supa.from("rb_direct_messages").insert({sender_id:me, receiver_id:userId, text:db.directMessages[db.directMessages.length-1].text}).then(()=>{},()=>{});
  }
}
let callTimer=null, callSec=0;
function startCall(userId){
  const u=getDemoUser(userId);
  if(!u) return;
  const overlay=$("#callOverlay");
  $("#callAvatar").src=u.avatar;
  $("#callName").textContent=u.name;
  $("#callStatus").textContent="Calling...";
  overlay.style.display="flex";
  callSec=0;
  clearInterval(callTimer);
  callTimer=setInterval(()=>{
    callSec++;
    const m=String(Math.floor(callSec/60)).padStart(2,"0"), s=String(callSec%60).padStart(2,"0");
    $("#callStatus").textContent=`${m}:${s} — Demo call (WebRTC not wired yet)`;
  },1000);
  setTimeout(()=>{ $("#callStatus").textContent="00:02 — Demo call • Real calling is next step"; },1200);
}
function endCall(){
  clearInterval(callTimer);
  $("#callOverlay").style.display="none";
  toast("Call ended — demo screen. Real WebRTC is listed as next step.");
}

// Create register modal
function openCreateModal(){
  $("#createModal").classList.add("open");
  $("#newRegName").value="";
  $("#newRegType").value="General Register";
  $("#newRegDatePreview").textContent=todayFmt() + " — auto-selected";
}
function closeCreateModal(){ $("#createModal").classList.remove("open"); }
function createRegister(){
  const name=$("#newRegName").value.trim();
  const type=$("#newRegType").value;
  if(!name){ toast("Enter a register name"); return; }
  const me=currentUser();
  const reg={id:uid(), ownerId:me.id, name, type, createdAt:new Date().toISOString(), createdAtFmt: todayFmt()};
  db.registers.push(reg);
  saveLocal(); closeCreateModal(); renderAll(); openRegister(reg.id);
  toast("Register created ✓ — start typing");
  syncRegisterToSupabase(reg);
}

// Open register detail (paper view)
function openRegister(regId){
  const reg=db.registers.find(r=>r.id===regId);
  if(!reg){ toast("Register not found"); return; }
  if(!canView(reg)){ toast("You don't have access to this register"); return; }
  state.registerView.id=regId;
  state.registerView.page=1;
  state.registerView.highlightDate=null;
  setView("registerDetail");
  renderRegisterDetail();
}

function renderRegisterDetail(){
  const regId=state.registerView.id;
  const reg=db.registers.find(r=>r.id===regId);
  const container=$("#view-registerDetail");
  if(!reg || !container){ return; }
  const me=currentUser();
  const owner=getDemoUser(reg.ownerId) || {name:reg.ownerId, avatar:`https://i.pravatar.cc/100?u=${reg.ownerId}`};
  const editable=canEdit(reg);
  const entries=db.entries.filter(e=>e.registerId===regId).sort((a,b)=>a.seq-b.seq);
  const totalLines=entries.length;
  const totalPages=Math.max(1, Math.ceil(totalLines/10));
  let page=state.registerView.page;
  if(page<1) page=1; if(page>totalPages) page=totalPages;
  state.registerView.page=page;
  const startIdx=(page-1)*10, endIdx=startIdx+10;
  const pageEntries=entries.slice(startIdx, endIdx);
  const pageTotal = reg.type==="Bill Book" ? pageEntries.reduce((s,e)=>s+(Number(e.amount)||0),0) : null;

  // Build paper head
  container.innerHTML=`
    <div class="paper">
      <div class="paper-head">
        <div>
          <div class="paper-title">${escapeHtml(reg.name)}</div>
          <div class="paper-meta">${escapeHtml(reg.type)} • Created ${escapeHtml(reg.createdAtFmt)} • by ${escapeHtml(owner.name)} ${editable? `<span class="badge badge-green">Owner — can edit</span>` : `<span class="badge badge-amber">View only</span>`} • ${totalLines} lines • ${totalPages} pages (unlimited)</div>
        </div>
        <div class="paper-tabs">
          <button class="btn btn-sm" onclick="setView('home')">← Back</button>
          <button class="btn btn-sm" onclick="openShareModal('${reg.id}')">Share</button>
          ${editable? `<button class="btn btn-sm btn-ghost" onclick="deleteRegister('${reg.id}')" style="color:#dc2626">Delete book</button>`:""}
        </div>
      </div>
      ${!editable? `<div class="view-only-banner">👁️ View only — ${escapeHtml(owner.name)} created this. You can read every page and search, but cannot add/edit/delete. Only the creator can change it. (Enforced by Row Level Security in Supabase)</div>`:""}
      <div style="padding:10px 16px 10px 58px;background:#fffef5;border-bottom:1px solid #e5d8a8;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <div class="search-wrap" style="max-width:360px;flex:1">
          <span class="search-ico">🔍</span>
          <input id="insideSearch" class="search-input" placeholder="Search inside: page 2, October, octobr, 23 Oct, 10..." value="${escapeHtml(state.searchInside||"")}" oninput="handleInsideSearch(this.value, '${reg.id}')">
          <div id="insideSuggest" class="search-suggest"></div>
        </div>
        <span class="small muted">Smart search — accepts misspellings like "octobr"</span>
      </div>
      <div class="paper-body ruled" id="paperBody">
        ${pageEntries.length? pageEntries.map(e=>{
          const isHighlight = state.registerView.highlightDate && e.entry_date===state.registerView.highlightDate;
          return `<div class="line ${e.done?'done':''} ${isHighlight?'highlight':''}" data-id="${e.id}">
            <div class="line-num">${e.seq}.</div>
            <div class="line-text">
              <div style="font-weight:600">${escapeHtml(e.text)}</div>
              ${e.note? `<div class="small muted">${escapeHtml(e.note)}</div>`:""}
              <div class="small muted" style="margin-top:2px">${escapeHtml(e.entry_date_fmt)} ${e.qty!=null? `• Qty: <b>${e.qty}</b>`:""} ${e.amount!=null? `• ₹<b>${e.amount}</b>`:""}</div>
            </div>
            ${editable? `<div class="line-actions">
              <button class="btn btn-sm" style="padding:4px 7px" onclick="toggleDone('${e.id}')">${e.done?'↩ Undo':'✓ Done'}</button>
              <button class="btn btn-sm" style="padding:4px 7px" onclick="editEntry('${e.id}')">Edit</button>
              <button class="btn btn-sm" style="padding:4px 7px;color:#dc2626" onclick="deleteEntry('${e.id}')">×</button>
            </div>` : `<div class="line-actions" style="opacity:.6;font-size:11px">View only</div>`}
          </div>`;
        }).join("") : `<div class="line"><div class="line-num">—</div><div class="line-text muted">No lines on this page yet. ${editable?'Start typing below.':''}</div></div>`}
      </div>
      <div class="page-bar">
        <button class="btn btn-sm" onclick="changePage(-1)" ${page<=1?'disabled':''}>← Previous</button>
        <span class="page-info">Page ${page} of ${totalPages}</span>
        <div class="inline" style="gap:6px">
          <input id="gotoPage" type="number" min="1" max="${totalPages}" placeholder="Go to" style="width:80px;padding:7px 8px;border:1px solid var(--border);border-radius:8px">
          <button class="btn btn-sm" onclick="gotoPage(${totalPages})">Go</button>
        </div>
        <button class="btn btn-sm" onclick="changePage(1)" ${page>=totalPages?'disabled':''}>Next →</button>
        ${pageTotal!==null? `<span class="page-total">Page total: ₹${pageTotal}</span>`:""}
        <span class="small muted" style="margin-left:8px">${totalLines? `Line ${(page-1)*10+1}–${Math.min(page*10, totalLines)} of ${totalLines}`:""}</span>
      </div>
      ${editable? `
      <div class="add-line">
        <textarea id="newLineText" rows="1" placeholder="Write a line then press Add — today's date (${todayFmt()}) is auto-filled"></textarea>
        ${reg.type==="Bill Book"? `<input id="newLineQty" type="number" placeholder="Qty" style="max-width:90px"><input id="newLineAmt" type="number" placeholder="₹ Amount" style="max-width:110px">`:""}
        <button class="btn btn-primary" onclick="addLine('${reg.id}')">Add</button>
      </div>
      <div class="small muted" style="padding:0 16px 12px 58px">When a page fills (10 lines), the next line automatically shifts to a new page — we’ll tell you.</div>
      ` : `<div class="small muted" style="padding:12px 16px 12px 58px;background:#fef2f2;border-top:1px solid #fecaca">Editing is disabled — you have view-only access. Switch to ${escapeHtml(owner.name)} in the demo switcher to edit.</div>`}
    </div>
    <div class="card mt12">
      <div class="card-head"><h3>Sharing</h3><button class="btn btn-sm" onclick="openShareModal('${reg.id}')">Share this register</button></div>
      <div class="card-pad small">
        ${(()=>{
          const sh=db.shares.filter(s=>s.registerId===reg.id);
          if(!sh.length) return `<span class="muted">Not shared yet. Share to a person or group.</span>`;
          return sh.map(s=>{
            const u=getDemoUser(s.sharedWithUserId) || {name:s.sharedWithEmail||s.sharedWithUserId, avatar:`https://i.pravatar.cc/100?u=${s.sharedWithUserId}`};
            return `<span class="chip"><img src="${u.avatar}">${escapeHtml(u.name)} • view only</span>`;
          }).join(" ");
        })()}
      </div>
    </div>
  `;
  // focus inside search suggest logic needs rebind? Already inline
}

function changePage(dir){
  state.registerView.page+=dir;
  state.registerView.highlightDate=null;
  renderRegisterDetail();
}
function gotoPage(max){
  const inp=$("#gotoPage");
  let v=parseInt(inp.value,10);
  if(isNaN(v) || v<1) v=1;
  if(v>max) v=max;
  state.registerView.page=v;
  state.registerView.highlightDate=null;
  renderRegisterDetail();
}
function addLine(regId){
  const reg=db.registers.find(r=>r.id===regId);
  if(!reg || !canEdit(reg)){ toast("View only — cannot add"); return; }
  const txt=$("#newLineText").value.trim();
  if(!txt){ toast("Type something first"); return; }
  let qty=null, amount=null;
  if(reg.type==="Bill Book"){
    qty = $("#newLineQty")?.value ? parseInt($("#newLineQty").value,10) : null;
    amount = $("#newLineAmt")?.value ? parseFloat($("#newLineAmt").value) : null;
  }
  const existing=db.entries.filter(e=>e.registerId===regId);
  const seq=existing.length+1;
  const prevPages=Math.ceil(existing.length/10)||1;
  const newPages=Math.ceil(seq/10);
  const now=new Date();
  const dp=dateParts(now);
  const en={
    id:uid(), registerId:regId, text:txt, note:"", qty, amount, done:false,
    entry_date:dp.iso, entry_date_fmt: todayFmt(), seq, weekday:dp.weekday, month:dp.month, monthShort:dp.monthShort, monthNum:dp.monthNum, day:dp.day, year:dp.year
  };
  db.entries.push(en);
  saveLocal(); syncEntryToSupabase(en);
  $("#newLineText").value=""; if($("#newLineQty")) $("#newLineQty").value=""; if($("#newLineAmt")) $("#newLineAmt").value="";
  // auto shift check
  if(newPages>prevPages){
    toast(`Page ${prevPages} full — shifted to Page ${newPages} ✓`);
    state.registerView.page=newPages;
  }
  renderRegisterDetail(); renderHome(); renderMyRegisters();
}
function toggleDone(entryId){
  const en=db.entries.find(e=>e.id===entryId);
  if(!en) return;
  const reg=db.registers.find(r=>r.id===en.registerId);
  if(!reg || !canEdit(reg)){ toast("View only — cannot change"); return; }
  en.done=!en.done; saveLocal(); renderRegisterDetail();
  syncEntryToSupabase(en);
}
function editEntry(entryId){
  const en=db.entries.find(e=>e.id===entryId);
  if(!en) return;
  const reg=db.registers.find(r=>r.id===en.registerId);
  if(!reg || !canEdit(reg)){ toast("View only — cannot edit"); return; }
  const newText=prompt("Edit line:", en.text);
  if(newText===null) return;
  const t=newText.trim();
  if(!t) return;
  en.text=t; saveLocal(); renderRegisterDetail();
  syncEntryToSupabase(en);
}
function deleteEntry(entryId){
  const en=db.entries.find(e=>e.id===entryId);
  if(!en) return;
  const reg=db.registers.find(r=>r.id===en.registerId);
  if(!reg || !canEdit(reg)){ toast("View only — cannot delete"); return; }
  if(!confirm("Delete this line?")) return;
  db.entries=db.entries.filter(e=>e.id!==entryId);
  // re-seq remaining entries for this register to keep pages consistent
  const remaining=db.entries.filter(e=>e.registerId===en.registerId).sort((a,b)=>a.seq-b.seq);
  remaining.forEach((e,i)=>e.seq=i+1);
  saveLocal(); renderRegisterDetail(); renderMyRegisters(); renderHome();
  // supabase delete
  const supa=typeof getSupabase==="function"?getSupabase():null;
  if(supa && currentUser().isReal) supa.from("rb_entries").delete().eq("id", entryId).then(()=>{},()=>{});
}
function deleteRegister(regId){
  if(!confirm("Delete this whole register book and all its pages?")) return;
  const reg=db.registers.find(r=>r.id===regId);
  if(!reg || !canEdit(reg)){ toast("Only owner can delete"); return; }
  db.registers=db.registers.filter(r=>r.id!==regId);
  db.entries=db.entries.filter(e=>e.registerId!==regId);
  db.shares=db.shares.filter(s=>s.registerId!==regId);
  saveLocal(); setView("myRegisters"); renderAll();
  toast("Register deleted");
  const supa=typeof getSupabase==="function"?getSupabase():null;
  if(supa && currentUser().isReal) supa.from("rb_registers").delete().eq("id", regId).then(()=>{},()=>{});
}

// Inside search (smart)
function handleInsideSearch(q, regId){
  state.searchInside=q;
  const box=$("#insideSuggest");
  if(!box) return;
  const reg=db.registers.find(r=>r.id===regId);
  const entries=db.entries.filter(e=>e.registerId===regId).sort((a,b)=>a.seq-b.seq);
  if(!q || !q.trim()){ box.classList.remove("open"); box.innerHTML=""; return; }
  const qn=normalize(q);
  // Build suggestions: for each matching entry, group by date/day
  const matched=entries.filter(e=> entryMatchesSearch(e, q));
  if(!matched.length){ box.innerHTML=`<div class="sug-item muted">No matches for "${escapeHtml(q)}" — try October, oct, 10, 23 Oct, or page 2</div>`; box.classList.add("open"); return; }
  // Group by date or page? For search that matches date/month, group by date; else by page?
  // Build unique suggestions: each unique date + page combo
  const uniq=new Map();
  matched.forEach(e=>{
    const page=Math.ceil(e.seq/10);
    const key=e.entry_date || `p${page}`;
    if(!uniq.has(key)){
      const count = entries.filter(x=> x.entry_date===e.entry_date).length;
      // e.g., "October 1 — Page 1 • 2 lines" or if page search, "Page 2 • 10 lines"
      let label="";
      if(e.entry_date) label=`${e.month} ${e.day} — Page ${page} • ${count} line${count>1?'s':''}`;
      else label=`Page ${page} • 10 lines`;
      uniq.set(key, {entry:e, label, page, count});
    }
  });
  const suggestions=[...uniq.values()].slice(0,8);
  box.innerHTML=suggestions.map(s=>`
    <div class="sug-item" onclick="jumpToSuggestion('${s.entry.entry_date}', ${s.page})">
      <span>📄 ${escapeHtml(s.label)}</span><span class="sug-meta">${escapeHtml(s.entry.text.slice(0,28))}</span>
    </div>
  `).join("") + `<div class="sug-item muted" style="font-size:11px">Found ${matched.length} lines matching "${escapeHtml(q)}"</div>`;
  box.classList.add("open");
}
function jumpToSuggestion(dateIso, page){
  state.registerView.page=page;
  state.registerView.highlightDate=dateIso;
  state.searchInside="";
  const box=$("#insideSuggest");
  if(box) box.classList.remove("open");
  renderRegisterDetail();
  toast(`Jumped to Page ${page} ${dateIso? "• "+dateIso:""}`);
  // highlight scroll
  setTimeout(()=>{
    const hl=document.querySelector(".line.highlight");
    if(hl) hl.scrollIntoView({behavior:"smooth", block:"center"});
  },100);
}

// Sharing modals
let shareTargetUser=null;
function openShareModal(regId){
  const reg=db.registers.find(r=>r.id===regId);
  if(!reg){ toast("Register not found"); return; }
  $("#shareRegId").value=regId;
  $("#shareRegName").textContent=reg.name;
  $("#shareUserInput").value="";
  $("#shareGroupSelect").innerHTML=`<option value="">— Pick a group —</option>` + db.groups.map(g=>`<option value="${g.id}">${escapeHtml(g.name)} (${g.members.length})</option>`).join("");
  $("#shareSuggest").innerHTML=""; $("#shareSuggest").classList.remove("open");
  $("#shareModal").classList.add("open");
}
function openShareModalForUser(userId){
  shareTargetUser=userId;
  const u=getDemoUser(userId);
  // show share modal with user preselected: need to pick register
  // If current view is registerDetail, use that register, else show picker
  if(state.registerView.id){
    openShareModal(state.registerView.id);
    setTimeout(()=>{ $("#shareUserInput").value=u.name; handleShareUserInput(u.name); },50);
  } else {
    // show generic share modal where user picks register
    const myRegs=db.registers.filter(r=>r.ownerId===currentUser().id);
    if(!myRegs.length){ toast("Create a register first, then share"); return; }
    // repurpose modal: show register picker
    $("#shareRegId").value=myRegs[0].id;
    $("#shareRegName").textContent=myRegs[0].name + " (auto-picked — you can change)";
    $("#shareModal").classList.add("open");
    // populate register picker dropdown? We'll create dynamically
    let picker=$("#shareRegPicker");
    if(!picker){
      const row=document.createElement("div");
      row.className="form-row"; row.id="shareRegPickerWrap";
      row.innerHTML=`<label>My registers</label><select id="shareRegPicker"></select>`;
      $("#shareModal .modal-body").prepend(row);
      picker=$("#shareRegPicker");
    }
    picker.innerHTML=myRegs.map(r=>`<option value="${r.id}">${escapeHtml(r.name)} — ${escapeHtml(r.type)}</option>`).join("");
    picker.onchange=e=>{
      const r=db.registers.find(x=>x.id===e.target.value);
      if(r){ $("#shareRegId").value=r.id; $("#shareRegName").textContent=r.name; }
    };
    $("#shareUserInput").value=u.name;
    handleShareUserInput(u.name);
  }
}
function closeShareModal(){
  $("#shareModal").classList.remove("open");
  const wrap=$("#shareRegPickerWrap");
  if(wrap) wrap.remove();
}
function handleShareUserInput(q){
  const box=$("#shareSuggest");
  if(!q || q.trim().length<1){ box.classList.remove("open"); box.innerHTML=""; return; }
  const qn=normalize(q);
  const matches=DEMO_USERS.filter(u=> normalize(u.name).includes(qn) || levenshtein(normalize(u.name), qn)<=2 );
  if(!matches.length){ box.classList.remove("open"); return; }
  box.innerHTML=matches.map(u=>`<div onclick="pickShareUser('${u.id}')"><img src="${u.avatar}" style="width:18px;height:18px;border-radius:50%;vertical-align:middle;margin-right:6px">${escapeHtml(u.name)} — ${escapeHtml(u.email)}</div>`).join("");
  box.classList.add("open");
}
function pickShareUser(userId){
  const u=getDemoUser(userId);
  $("#shareUserInput").value=u.name;
  $("#shareUserInput").dataset.userId=userId;
  $("#shareSuggest").classList.remove("open");
}
function doShare(){
  const regId=$("#shareRegId").value;
  const reg=db.registers.find(r=>r.id===regId);
  if(!reg){ toast("Pick a register"); return; }
  if(!canEdit(reg)){ toast("Only owner can share"); return; }
  const input=$("#shareUserInput");
  const pickedId=input.dataset.userId;
  const groupId=$("#shareGroupSelect").value;
  if(groupId){
    // share to whole group: create shares for each member
    const g=db.groups.find(x=>x.id===groupId);
    if(!g){ toast("Group not found"); return; }
    let added=0;
    g.members.forEach(memberId=>{
      if(memberId===currentUser().id) return;
      if(db.shares.some(s=>s.registerId===regId && s.sharedWithUserId===memberId)) return;
      const member=getDemoUser(memberId);
      db.shares.push({id:uid(), registerId:regId, sharedWithUserId:memberId, sharedWithEmail:member?.email||"", permission:"view", sharedBy:currentUser().id, createdAt:new Date().toISOString()});
      added++;
    });
    saveLocal(); closeShareModal(); renderHome(); renderShared(); renderRegisterDetail(); toast(`Shared "${reg.name}" to group ${g.name} (${added} people) ✓`);
    // supabase group shares
    const supa=typeof getSupabase==="function"?getSupabase():null;
    if(supa && currentUser().isReal){
      const rows=g.members.filter(id=>id!==currentUser().id).map(id=>({register_id:regId, shared_with_user_id:id, permission:"view", shared_by:currentUser().id}));
      if(rows.length) supa.from("rb_shares").insert(rows).then(()=>{},()=>{});
    }
    return;
  }
  // individual share
  let targetId=pickedId;
  if(!targetId){
    // try match by name
    const nameNorm=normalize(input.value);
    const found=DEMO_USERS.find(u=>normalize(u.name)===nameNorm || normalize(u.name).includes(nameNorm));
    if(found) targetId=found.id;
  }
  if(!targetId){ toast("Select a person from suggestions"); return; }
  if(db.shares.some(s=>s.registerId===regId && s.sharedWithUserId===targetId)){ toast("Already shared with "+getDemoUser(targetId).name); return; }
  const target=getDemoUser(targetId);
  db.shares.push({id:uid(), registerId:regId, sharedWithUserId:targetId, sharedWithEmail:target.email, permission:"view", sharedBy:currentUser().id, createdAt:new Date().toISOString()});
  saveLocal(); closeShareModal(); renderHome(); renderShared(); renderRegisterDetail(); toast(`Shared "${reg.name}" with ${target.name} (view only) ✓`);
  const supa=typeof getSupabase==="function"?getSupabase():null;
  if(supa && currentUser().isReal){
    supa.from("rb_shares").insert({register_id:regId, shared_with_user_id:targetId, shared_with_email:target.email, permission:"view", shared_by:currentUser().id}).then(()=>{},()=>{});
  }
}
function openShareToGroupModal(groupId){
  const g=db.groups.find(x=>x.id===groupId);
  if(!g) return;
  const myRegs=db.registers.filter(r=>r.ownerId===currentUser().id);
  if(!myRegs.length){ toast("Create a register first"); return; }
  // reuse share modal but pre-select group
  openShareModal(myRegs[0].id);
  $("#shareGroupSelect").value=groupId;
}

// Group create
function openGroupModal(){ $("#groupModal").classList.add("open"); $("#newGroupName").value=""; $("#newGroupMembers").innerHTML=DEMO_USERS.filter(u=>u.id!==currentUser().id).map(u=>`<label style="display:flex;gap:8px;align-items:center;font-size:13px;padding:6px 0"><input type="checkbox" value="${u.id}"> <img src="${u.avatar}" style="width:22px;height:22px;border-radius:50%">${escapeHtml(u.name)}</label>`).join(""); }
function closeGroupModal(){ $("#groupModal").classList.remove("open"); }
function createGroup(){
  const name=$("#newGroupName").value.trim();
  if(!name){ toast("Enter group name"); return; }
  const checks=[...document.querySelectorAll("#newGroupMembers input:checked")].map(c=>c.value);
  const me=currentUser().id;
  const members=[...new Set([me, ...checks])];
  const g={id:uid(), name, createdBy:me, members};
  db.groups.push(g);
  saveLocal(); closeGroupModal(); renderGroups(); updateSidebarCounts(); toast(`Group "${name}" created with ${members.length} members ✓`);
  const supa=typeof getSupabase==="function"?getSupabase():null;
  if(supa && currentUser().isReal){
    supa.from("rb_groups").insert({id:g.id, name:g.name, created_by:me}).then(()=>{
      const rows=members.map(uid=>({group_id:g.id, user_id:uid}));
      supa.from("rb_group_members").insert(rows).then(()=>{},()=>{});
    },()=>{});
  }
}

// Navigation helpers exposed globally
window.setView=setView;
window.openRegister=openRegister;
window.openCreateModal=openCreateModal;
window.closeCreateModal=closeCreateModal;
window.createRegister=createRegister;
window.changePage=changePage;
window.gotoPage=gotoPage;
window.addLine=addLine;
window.toggleDone=toggleDone;
window.editEntry=editEntry;
window.deleteEntry=deleteEntry;
window.deleteRegister=deleteRegister;
window.handleInsideSearch=handleInsideSearch;
window.jumpToSuggestion=jumpToSuggestion;
window.openShareModal=openShareModal;
window.openShareModalForUser=openShareModalForUser;
window.closeShareModal=closeShareModal;
window.handleShareUserInput=handleShareUserInput;
window.pickShareUser=pickShareUser;
window.doShare=doShare;
window.openShareToGroupModal=openShareToGroupModal;
window.openGroup=openGroup;
window.sendGroupMsg=sendGroupMsg;
window.openChat=openChat;
window.sendChat=sendChat;
window.startCall=startCall;
window.endCall=endCall;
window.openGroupModal=openGroupModal;
window.closeGroupModal=closeGroupModal;
window.createGroup=createGroup;
window.handlePeopleSearch=handlePeopleSearch;
window.selectPerson=selectPerson;
window.sendFriendRequest=sendFriendRequest;
window.handleFriend=handleFriend;
window.demoShareStory=demoShareStory;

// Init
document.addEventListener("DOMContentLoaded", ()=>{
  ensureDemoData();
  loadLocal();
  renderAll();
  // Expose helpers for auth.js
  window.ensureDemoData=ensureDemoData;
  window.renderAll=renderAll;
  window.getDemoUser=getDemoUser;
  window.resetDemoView=resetDemoView;
  window.loadFromSupabase=loadFromSupabase;
  // close modals on outside click
  document.addEventListener("click", e=>{
    if(e.target.classList.contains("modal")) e.target.classList.remove("open");
  });
});

// For test harness
window.__RB = { get db(){return db}, DEMO_USERS, currentUser, canEdit };

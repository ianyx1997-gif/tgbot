/* ============================================================
   ZEBRATUR – TELEGRAM SEARCH BOT + CRM + ADMIN PANEL

   Features:
   - Interactive tour search via Telegram buttons
   - Subscriber CRM with auto-preferences
   - Web admin panel with chat, broadcast, composer
   - GitHub backup for persistent storage

   ENV variables:
   TELEGRAM_BOT_TOKEN  — (required) Bot token from BotFather
   ADMIN_CHAT_ID       — (required) Your Telegram chat ID
   ADMIN_PASSWORD      — (required) Password for web panel
   DATABASE_URL        — (required) PostgreSQL connection string
   GITHUB_TOKEN        — (optional) For secondary backup to GitHub
   GITHUB_REPO         — (optional) "user/repo" for backup
   PORT                — (optional, default 3000)
   ============================================================ */

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { Pool } = require('pg');

// ===== CONFIG =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://zebratur.md/offers';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID) : null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'zebratur2026';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PORT = process.env.PORT || 3000;

// ===== POSTGRESQL =====
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: false, max: 5 });
  console.log('🐘 PostgreSQL configurat');
} else {
  console.log('⚠️ DATABASE_URL lipsește — se folosește doar memorie locală');
}

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN lipsește!'); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json({ limit: '10mb' }));

// ===== TOUR DATA =====
const COUNTRIES = [
  { id: 115, name: 'Turcia', flag: '🇹🇷', transport: 'air' },
  { id: 43,  name: 'Egipt', flag: '🇪🇬', transport: 'air' },
  { id: 34,  name: 'Grecia', flag: '🇬🇷', transport: 'air' },
  { id: 49,  name: 'Spania', flag: '🇪🇸', transport: 'air' },
  { id: 135, name: 'Muntenegru', flag: '🇲🇪', transport: 'air' },
  { id: 114, name: 'Tunisia', flag: '🇹🇳', transport: 'air' },
  { id: 10,  name: 'Albania', flag: '🇦🇱', transport: 'air' },
  { id: 54,  name: 'Cipru', flag: '🇨🇾', transport: 'air' },
  { id: 13,  name: 'Bulgaria', flag: '🇧🇬', transport: 'bus' },
  { id: 29,  name: 'Vietnam', flag: '🇻🇳', transport: 'air' },
];

const DEPARTURE_CITIES = [
  { id: 1831, name: 'Chișinău', flag: '🇲🇩' },
  { id: 1373, name: 'București', flag: '🇷🇴' },
  { id: 4091, name: 'Iași', flag: '🇷🇴' },
  { id: 4083, name: 'Cluj-Napoca', flag: '🇷🇴' },
  { id: 3396, name: 'Timișoara', flag: '🇷🇴' },
  { id: 2858, name: 'Bacău', flag: '🇷🇴' },
  { id: 1727, name: 'Suceava', flag: '🇷🇴' },
];

const DURATIONS = [
  { nights: 5, label: '5 nopți' }, { nights: 7, label: '7 nopți' },
  { nights: 10, label: '10 nopți' }, { nights: 12, label: '12 nopți' },
  { nights: 14, label: '14 nopți' },
];

const FOOD_OPTIONS = [
  { code: 'ob', label: 'Orice masă', icon: '🍽️' },
  { code: 'bb', label: 'Mic dejun+', icon: '🥐' },
  { code: 'hb', label: 'Demipensiune+', icon: '🍲' },
  { code: 'fb', label: 'Pensiune completă+', icon: '🍱' },
  { code: 'ai', label: 'All Inclusive+', icon: '🏖️' },
  { code: 'uai', label: 'Ultra AI', icon: '👑' },
];
const FOOD_HIERARCHY = ['ob', 'bb', 'hb', 'fb', 'ai', 'uai'];

const STARS_OPTIONS = [
  { stars: '', label: 'Orice stele' }, { stars: '3', label: '3★+' },
  { stars: '4', label: '4★+' }, { stars: '5', label: '5★' },
];
const ADULTS_OPTIONS = [1, 2, 3, 4];
const MONTH_NAMES = ['Ianuarie','Februarie','Martie','Aprilie','Mai','Iunie','Iulie','August','Septembrie','Octombrie','Noiembrie','Decembrie'];

// ================================================================
//  DATABASE (PostgreSQL primary, GitHub secondary backup)
// ================================================================
let db = {
  subscribers: {},
  meta: { createdAt: new Date().toISOString(), totalSearches: 0 }
};

// --- PostgreSQL functions ---
async function initPostgres() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_data (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('🐘 PostgreSQL tabel inițializat');
  } catch (e) { console.error('⚠️ PostgreSQL init error:', e.message); }
}

async function loadDB() {
  if (!pool) return;
  try {
    const res = await pool.query("SELECT value FROM bot_data WHERE key = 'subscribers'");
    if (res.rows.length > 0) {
      db = res.rows[0].value;
      if (!db.subscribers) db.subscribers = {};
      if (!db.meta) db.meta = { createdAt: new Date().toISOString(), totalSearches: 0 };
      console.log(`🐘 DB din PostgreSQL: ${Object.keys(db.subscribers).length} abonați, ${db.meta.totalSearches||0} căutări`);
    } else {
      console.log('🐘 PostgreSQL gol — DB nouă');
    }
  } catch (e) { console.error('⚠️ PostgreSQL load error:', e.message); }
}

async function saveDB() {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO bot_data (key, value, updated_at) VALUES ('subscribers', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(db)]
    );
  } catch (e) { console.error('⚠️ PostgreSQL save error:', e.message); }
}

// --- HTTP helper for GitHub ---
function httpReq(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- GitHub secondary backup (optional) ---
async function backupToGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  try {
    const content = Buffer.from(JSON.stringify(db, null, 2)).toString('base64');
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/subscribers.json`;
    const hdr = { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'ZebraTurBot', 'Content-Type': 'application/json' };
    let sha = '';
    try { const r = await httpReq('GET', apiUrl, hdr); if (r?.sha) sha = r.sha; } catch {}
    await httpReq('PUT', apiUrl, hdr, JSON.stringify({ message: `backup ${new Date().toISOString()}`, content, ...(sha && { sha }) }));
    console.log('☁️ GitHub backup OK');
  } catch (e) { console.error('⚠️ GitHub backup error:', e.message); }
}

// --- Migrate from GitHub if PostgreSQL is empty ---
async function migrateFromGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (Object.keys(db.subscribers).length > 0) { console.log('🐘 PostgreSQL are date — skip migrare'); return; }
  try {
    console.log('☁️ PostgreSQL gol — încerc migrarea din GitHub...');
    const r = await httpReq('GET', `https://api.github.com/repos/${GITHUB_REPO}/contents/subscribers.json`,
      { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'ZebraTurBot' });
    if (r?.content) {
      const restored = JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
      if (restored.subscribers && Object.keys(restored.subscribers).length > 0) {
        db = restored;
        await saveDB();
        console.log(`✅ Migrat din GitHub → PostgreSQL: ${Object.keys(db.subscribers).length} abonați, ${db.meta.totalSearches||0} căutări`);
      }
    }
  } catch (e) { console.error('⚠️ Migrare GitHub error:', e.message); }
}

// ================================================================
//  SUBSCRIBER CRM
// ================================================================
function getSub(chatId) {
  const id = String(chatId);
  if (!db.subscribers[id]) {
    db.subscribers[id] = {
      chatId, firstName: '', lastName: '', username: '',
      joinedAt: new Date().toISOString(), lastActive: new Date().toISOString(),
      searches: [], messages: [],
      preferences: { topCountries: [], typicalAdults: 2, hasChildren: false, avgChildAges: [],
                     preferredFood: null, preferredStars: null, preferredNights: null },
      tags: [], blocked: false, totalSearches: 0,
    };
  }
  return db.subscribers[id];
}

function updateSubInfo(chatId, from) {
  const sub = getSub(chatId);
  if (from) { sub.firstName = from.first_name || ''; sub.lastName = from.last_name || ''; sub.username = from.username || ''; }
  sub.lastActive = new Date().toISOString();
}

function storeMessage(chatId, direction, text, extra) {
  const sub = getSub(chatId);
  sub.messages.push({
    direction, // 'in' = from user, 'out' = from admin/bot
    text: text || '',
    extra: extra || null, // { photo, buttons, caption }
    timestamp: new Date().toISOString(),
  });
  // Keep last 200 messages per user
  if (sub.messages.length > 200) sub.messages = sub.messages.slice(-200);
}

function recordSearch(chatId, session) {
  const sub = getSub(chatId);
  sub.searches.push({
    country: session.country.name, countryId: session.country.id,
    dateFrom: session.dateFrom, nights: session.nights,
    adults: session.adults, children: [...session.children],
    food: session.food, stars: session.stars, timestamp: new Date().toISOString(),
  });
  sub.totalSearches++;
  db.meta.totalSearches++;
  updatePreferences(sub);
  updateTags(sub);
  saveDB();
  // Backup to GitHub after each search (non-blocking)
  backupToGitHub().catch(() => {});
  // Notify admin
  if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
    const name = sub.firstName + (sub.lastName ? ' ' + sub.lastName : '');
    bot.sendMessage(ADMIN_CHAT_ID,
      `🔔 <b>Căutare nouă</b>\n${name}${sub.username ? ' @' + sub.username : ''}\n${session.country.flag} ${session.country.name} | ${session.nights}n | ${session.adults}ad${session.children.length ? ' +' + session.children.length + ' copii' : ''}`,
      { parse_mode: 'HTML' }).catch(() => {});
  }
}

function updatePreferences(sub) {
  const s = sub.searches; if (!s.length) return;
  const cc = {}; s.forEach(x => cc[x.country] = (cc[x.country]||0)+1);
  sub.preferences.topCountries = Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,3).map(e=>e[0]);
  sub.preferences.typicalAdults = mode(s.map(x=>x.adults));
  sub.preferences.hasChildren = s.some(x=>x.children.length>0);
  const lk = [...s].reverse().find(x=>x.children.length>0);
  sub.preferences.avgChildAges = lk ? lk.children : [];
  const fa = s.map(x=>x.food).filter(f=>f!=='ob');
  sub.preferences.preferredFood = fa.length ? mode(fa) : null;
  const sa = s.map(x=>x.stars).filter(Boolean);
  sub.preferences.preferredStars = sa.length ? mode(sa) : null;
  sub.preferences.preferredNights = mode(s.map(x=>x.nights));
}

function updateTags(sub) {
  const tags = new Set(), p = sub.preferences;
  if (p.hasChildren) tags.add('family');
  if (!p.hasChildren && p.typicalAdults===2) tags.add('couple');
  if (p.typicalAdults===1 && !p.hasChildren) tags.add('solo');
  if (p.preferredFood==='ai'||p.preferredFood==='uai') tags.add('all-inclusive');
  if (p.preferredStars==='5') tags.add('luxury');
  if (p.preferredStars==='3') tags.add('budget');
  p.topCountries.forEach(c => tags.add('dest:'+c.toLowerCase()));
  if (sub.totalSearches>=5) tags.add('active');
  if (sub.totalSearches===1) tags.add('new');
  sub.tags = [...tags];
}

function mode(a) { const f={}; a.forEach(v=>f[v]=(f[v]||0)+1); return Object.entries(f).sort((a,b)=>b[1]-a[1])[0]?.[0]; }

// ================================================================
//  SEARCH HELPERS
// ================================================================
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      step:null, country:null, departCity:{id:1831,name:'Chișinău'},
      dateFrom:null, dateTo:null, nights:7, adults:2, children:[],
      food:'ob', stars:'', transport:'air',
    });
  }
  return sessions.get(chatId);
}
function resetSession(chatId) { sessions.delete(chatId); }

function expandFood(c) { if(!c||c==='ob') return ''; const i=FOOD_HIERARCHY.indexOf(c); return i<0?c:FOOD_HIERARCHY.slice(i).join(','); }
function addDays(d,n) { const x=new Date(d); x.setDate(x.getDate()+n); return x.toISOString().split('T')[0]; }
function fmtDate(d) { const x=new Date(d); const m=['ian','feb','mar','apr','mai','iun','iul','aug','sep','oct','nov','dec']; return `${x.getDate()} ${m[x.getMonth()]}`; }
function getAvailableMonths() {
  const ms=[],now=new Date();
  for(let m=0;m<8;m++){const d=new Date(now.getFullYear(),now.getMonth()+m,1);ms.push({month:d.getMonth(),year:d.getFullYear(),label:`${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`});}
  return ms;
}
function getDaysForMonth(month,year) {
  const now=new Date(),dim=new Date(year,month+1,0).getDate(),days=[];
  const start=(year===now.getFullYear()&&month===now.getMonth())?now.getDate()+2:1;
  for(let d=start;d<=dim;d++) days.push({date:`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`,label:`${d}`});
  return days;
}
function buildPeople(a,c) { let p=String(a); c.forEach(age=>p+=String(age).padStart(2,'0')); return p; }
function expandStars(s) { if(!s)return''; const n=parseInt(s),a=[]; for(let i=n;i<=5;i++)a.push(i); return a.join(','); }
function buildSearchUrl(s) {
  let u=`${SITE_URL}#!i=${s.country.id}&c=${s.dateFrom}&v=${s.dateTo||addDays(s.dateFrom,14)}&l=${s.nights}&p=${buildPeople(s.adults,s.children)}&tc=${s.children.join(',')}&g=1&d=${s.departCity.id}&o=${expandFood(s.food)}&st=${expandStars(s.stars)}&pf=100&pt=20000&rt=0,10&th=&e=&r=${s.transport}&ex=1&cu=eur&page=tour`;
  return u;
}
function buildSummary(s) {
  const fl=FOOD_OPTIONS.find(f=>f.code===s.food)?.label||'Orice';
  const sl=s.stars?`${s.stars}★+`:'Orice';
  const ct=s.children.length?`\n👶 Copii: ${s.children.length} (${s.children.map(a=>a+' ani').join(', ')})`:'';
  return `${s.country.flag} <b>${s.country.name}</b>\n✈️ Din: ${s.departCity.name}\n📅 De la: ${fmtDate(s.dateFrom)}\n🌙 ${s.nights} nopți\n👥 ${s.adults} adulți${ct}\n🍽️ ${fl}\n⭐ ${sl}`;
}

// ================================================================
//  SEARCH FLOW STEPS
// ================================================================
async function stepCountry(chatId, mid) {
  const s=getSession(chatId); s.step='country';
  const kb=[]; for(let i=0;i<COUNTRIES.length;i+=2) kb.push(COUNTRIES.slice(i,i+2).map(c=>({text:`${c.flag} ${c.name}`,callback_data:`country_${c.id}`})));
  const t='🌍 <b>Alege destinația:</b>';
  if(mid) await bot.editMessageText(t,{chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
  else await bot.sendMessage(chatId,t,{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
}
async function stepMonth(chatId,mid) {
  const s=getSession(chatId); s.step='month';
  const ms=getAvailableMonths(),kb=[];
  for(let i=0;i<ms.length;i+=2) kb.push(ms.slice(i,i+2).map(m=>({text:`📅 ${m.label}`,callback_data:`month_${m.month}_${m.year}`})));
  await bot.editMessageText(`${s.country.flag} <b>${s.country.name}</b>\n\n📅 <b>În ce lună vrei să pleci?</b>`,{chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
}
async function stepDay(chatId,mid) {
  const s=getSession(chatId); s.step='day';
  const days=getDaysForMonth(s._selMonth,s._selYear),kb=[];
  for(let i=0;i<days.length;i+=7) kb.push(days.slice(i,i+7).map(d=>({text:d.label,callback_data:`day_${d.date}`})));
  await bot.editMessageText(`${s.country.flag} <b>${s.country.name}</b>\n\n📅 <b>${MONTH_NAMES[s._selMonth]} ${s._selYear}</b> — alege ziua:`,{chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
}
async function stepDuration(chatId,mid) {
  const s=getSession(chatId); s.step='duration';
  const kb=[DURATIONS.slice(0,3).map(d=>({text:`🌙 ${d.label}`,callback_data:`dur_${d.nights}`})),DURATIONS.slice(3).map(d=>({text:`🌙 ${d.label}`,callback_data:`dur_${d.nights}`}))];
  await bot.editMessageText(`${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)}\n\n🌙 <b>Câte nopți?</b>`,{chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
}
async function stepAdults(chatId,mid) {
  const s=getSession(chatId); s.step='adults';
  const kb=[ADULTS_OPTIONS.map(n=>({text:n===s.adults?`✅ ${n}`:`${n}`,callback_data:`adults_${n}`}))];
  await bot.editMessageText(`${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n\n\n👥 <b>Câți adulți?</b>`,{chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
}
async function stepHasChildren(chatId,mid) {
  const s=getSession(chatId); s.step='has_children';
  await bot.editMessageText(`${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n | 👥 ${s.adults}ad\n\n👶 <b>Călătoriți cu copii?</b>`,
    {chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'👶 Da',callback_data:'has_children_yes'},{text:'❌ Nu',callback_data:'has_children_no'}]]}});
}
async function stepChildrenCount(chatId,mid) {
  const s=getSession(chatId); s.step='children_count';
  await bot.editMessageText(`${s.country.flag} <b>${s.country.name}</b> | 👥 ${s.adults}ad\n\n👶 <b>Câți copii?</b>`,
    {chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:[[1,2,3].map(n=>({text:`${n}`,callback_data:`childcount_${n}`}))]}});
}
async function stepChildAge(chatId,mid) {
  const s=getSession(chatId); s.step='child_age';
  const cn=s.children.length+1,tot=s._childrenTotal||1,kb=[];
  for(let i=0;i<18;i+=6){const r=[];for(let a=i;a<Math.min(i+6,18);a++)r.push({text:`${a}`,callback_data:`childage_${a}`});kb.push(r);}
  await bot.editMessageText(`👶 <b>Vârsta copilului ${cn} din ${tot}:</b>`,{chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
}
async function stepFood(chatId,mid) {
  const s=getSession(chatId); s.step='food'; const kb=[];
  for(let i=0;i<FOOD_OPTIONS.length;i+=2) kb.push(FOOD_OPTIONS.slice(i,i+2).map(f=>({text:`${f.icon} ${f.label}`,callback_data:`food_${f.code}`})));
  const ct=s.children.length?` + ${s.children.length} copii`:'';
  await bot.editMessageText(`${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n | 👥 ${s.adults}ad${ct}\n\n🍽️ <b>Ce masă preferi?</b>\n<i>"+" înseamnă acest tip și mai bun</i>`,
    {chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
}
async function stepStars(chatId,mid) {
  const s=getSession(chatId); s.step='stars';
  const fi=FOOD_OPTIONS.find(f=>f.code===s.food)?.icon||'';
  await bot.editMessageText(`${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n | ${fi}\n\n⭐ <b>Câte stele?</b>`,
    {chat_id:chatId,message_id:mid,parse_mode:'HTML',reply_markup:{inline_keyboard:[STARS_OPTIONS.map(st=>({text:st.label,callback_data:`stars_${st.stars||'any'}`}))]}});
}
async function stepConfirm(chatId,mid) {
  const s=getSession(chatId); s.step='confirm';
  recordSearch(chatId,s);
  const url=buildSearchUrl(s),sum=buildSummary(s);
  await bot.editMessageText(`✅ <b>Căutarea ta:</b>\n\n${sum}\n\n👇 Apasă pentru a vedea rezultatele:`,
    {chat_id:chatId,message_id:mid,parse_mode:'HTML',disable_web_page_preview:true,
     reply_markup:{inline_keyboard:[[{text:'🔍 CAUTĂ TURURI!',url}],[{text:'✏️ Modifică',callback_data:'edit_search'},{text:'🔄 Căutare nouă',callback_data:'new_search'}],[{text:'👨‍💼 Solicită ajutorul unui expert real',url:'https://t.me/zebraturbot'}]]}});
}
async function stepEdit(chatId,mid) {
  const s=getSession(chatId); s.step='edit';
  const url=buildSearchUrl(s),sum=buildSummary(s);
  await bot.editMessageText(`✏️ <b>Modifică căutarea:</b>\n\n${sum}\n\n<i>Alege ce vrei să schimbi:</i>`,
    {chat_id:chatId,message_id:mid,parse_mode:'HTML',disable_web_page_preview:true,
     reply_markup:{inline_keyboard:[
      [{text:'🌍 Destinație',callback_data:'edit_country'},{text:'📅 Data',callback_data:'edit_date'}],
      [{text:'🌙 Durata',callback_data:'edit_duration'},{text:'👥 Turiști',callback_data:'edit_adults'}],
      [{text:'🍽️ Masă',callback_data:'edit_food'},{text:'⭐ Stele',callback_data:'edit_stars'}],
      [{text:'🔍 CAUTĂ TURURI!',url}],
      [{text:'👨‍💼 Solicită ajutorul unui expert real',url:'https://t.me/zebraturbot'}]]}});
}

// ================================================================
//  BOT COMMAND & CALLBACK HANDLERS
// ================================================================
bot.onText(/\/start/, async (msg) => {
  const chatId=msg.chat.id; resetSession(chatId); updateSubInfo(chatId,msg.from); saveDB(); backupToGitHub().catch(()=>{});
  await bot.sendMessage(chatId,'👋 <b>Bun venit la ZebraTur!</b>\n\n🔍 Caută tururi în câteva secunde — alege destinația, datele și parametrii, iar eu îți generez link-ul direct.\n\nApasă butonul de mai jos! 👇',
    {parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🔍 Caută un tur',callback_data:'start_search'}],[{text:'👨‍💼 Solicită ajutorul unui expert real',url:'https://t.me/zebraturbot'}]]}});
  await bot.sendMessage(chatId,'💡 Poți folosi /cauta oricând.',{reply_markup:{keyboard:[[{text:'🔍 Caută un tur'}]],resize_keyboard:true,one_time_keyboard:false}});
});

bot.onText(/\/cauta/, async (msg) => { const c=msg.chat.id; resetSession(c); updateSubInfo(c,msg.from); await stepCountry(c,null); });
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,'📖 <b>Cum funcționează:</b>\n\n1️⃣ Apasă /cauta sau butonul 🔍\n2️⃣ Alege destinația, datele, durata\n3️⃣ Selectează masa și stelele\n4️⃣ Primești link-ul gata!\n\n/cauta — Căutare nouă\n/start — Resetează',{parse_mode:'HTML'});
});

// Store incoming user messages (non-command)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text === '🔍 Caută un tur') {
    resetSession(chatId); updateSubInfo(chatId, msg.from); await stepCountry(chatId, null); return;
  }
  // Store non-command messages for chat history
  if (msg.text && !msg.text.startsWith('/')) {
    updateSubInfo(chatId, msg.from);
    storeMessage(chatId, 'in', msg.text);
    saveDB();
    backupToGitHub().catch(() => {});
    // Forward to admin if not admin themselves
    if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
      const sub = getSub(chatId);
      const name = sub.firstName + (sub.lastName ? ' ' + sub.lastName : '');
      bot.sendMessage(ADMIN_CHAT_ID,
        `💬 <b>${name}</b>${sub.username?' @'+sub.username:''}:\n${msg.text}`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
  }
  // Store photos
  if (msg.photo) {
    updateSubInfo(chatId, msg.from);
    storeMessage(chatId, 'in', msg.caption || '[foto]', { photo: true });
    saveDB();
  }
});

bot.on('callback_query', async (query) => {
  const chatId=query.message.chat.id, mid=query.message.message_id, data=query.data, s=getSession(chatId);
  await bot.answerCallbackQuery(query.id);
  try {
    if(data==='start_search'||data==='new_search'){resetSession(chatId);updateSubInfo(chatId,query.from);await stepCountry(chatId,mid);return;}
    if(data.startsWith('country_')){const c=COUNTRIES.find(x=>x.id===parseInt(data.split('_')[1]));if(c){s.country=c;s.transport=c.transport;await stepMonth(chatId,mid);}return;}
    if(data.startsWith('depart_')){const c=DEPARTURE_CITIES.find(x=>x.id===parseInt(data.split('_')[1]));if(c){s.departCity=c;await stepMonth(chatId,mid);}return;}
    if(data.startsWith('month_')){const p=data.split('_');s._selMonth=parseInt(p[1]);s._selYear=parseInt(p[2]);await stepDay(chatId,mid);return;}
    if(data.startsWith('day_')){s.dateFrom=data.substring(4);s.dateTo=addDays(s.dateFrom,14);await stepDuration(chatId,mid);return;}
    if(data.startsWith('dur_')){s.nights=parseInt(data.split('_')[1]);await stepAdults(chatId,mid);return;}
    if(data.startsWith('adults_')){s.adults=parseInt(data.split('_')[1]);await stepHasChildren(chatId,mid);return;}
    if(data==='has_children_no'){s.children=[];await stepFood(chatId,mid);return;}
    if(data==='has_children_yes'){s.children=[];await stepChildrenCount(chatId,mid);return;}
    if(data.startsWith('childcount_')){s._childrenTotal=parseInt(data.split('_')[1]);s.children=[];await stepChildAge(chatId,mid);return;}
    if(data.startsWith('childage_')){s.children.push(parseInt(data.split('_')[1]));if(s.children.length<(s._childrenTotal||1))await stepChildAge(chatId,mid);else await stepFood(chatId,mid);return;}
    if(data.startsWith('food_')){s.food=data.split('_')[1];await stepStars(chatId,mid);return;}
    if(data.startsWith('stars_')){const v=data.split('_')[1];s.stars=v==='any'?'':v;await stepConfirm(chatId,mid);return;}
    if(data==='edit_search'){await stepEdit(chatId,mid);return;}
    if(data==='edit_country'){await stepCountry(chatId,mid);return;}
    if(data==='edit_date'){await stepMonth(chatId,mid);return;}
    if(data==='edit_duration'){await stepDuration(chatId,mid);return;}
    if(data==='edit_adults'){s.children=[];s._childrenTotal=0;await stepAdults(chatId,mid);return;}
    if(data==='edit_food'){await stepFood(chatId,mid);return;}
    if(data==='edit_stars'){await stepStars(chatId,mid);return;}
  } catch(err) {
    console.error('[Bot Error]',err.message);
    if(err.message.includes('not modified')||err.message.includes('not found')){resetSession(chatId);await stepCountry(chatId,null);}
  }
});

// ================================================================
//  API ENDPOINTS (for Admin Panel)
// ================================================================

// Auth middleware
function authCheck(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Dashboard stats
app.get('/api/stats', authCheck, (req, res) => {
  const subs = Object.values(db.subscribers);
  const now = Date.now();
  const active7d = subs.filter(s => (now - new Date(s.lastActive)) < 7*24*60*60*1000).length;
  const active30d = subs.filter(s => (now - new Date(s.lastActive)) < 30*24*60*60*1000).length;
  const searches30d = subs.reduce((sum, s) => sum + s.searches.filter(sr => (now - new Date(sr.timestamp)) < 30*24*60*60*1000).length, 0);

  // Country stats
  const cc = {};
  subs.forEach(s => s.searches.forEach(sr => cc[sr.country] = (cc[sr.country]||0)+1));
  const topCountries = Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,10);

  // Tag stats
  const tc = {};
  subs.forEach(s => s.tags.forEach(t => { if(!t.startsWith('dest:')) tc[t]=(tc[t]||0)+1; }));

  // New subs per day (last 30 days)
  const newPerDay = {};
  subs.forEach(s => { const d = s.joinedAt.split('T')[0]; newPerDay[d] = (newPerDay[d]||0)+1; });

  res.json({
    total: subs.length, active7d, active30d, totalSearches: db.meta.totalSearches||0,
    searches30d, topCountries, tags: tc, newPerDay,
    blocked: subs.filter(s=>s.blocked).length,
    withMessages: subs.filter(s=>s.messages.some(m=>m.direction==='in')).length,
  });
});

// Subscribers list (with filters)
app.get('/api/subscribers', authCheck, (req, res) => {
  let subs = Object.values(db.subscribers);
  const { tag, search, country, sort, hasMessages } = req.query;

  if (tag) subs = subs.filter(s => s.tags.includes(tag));
  if (country) subs = subs.filter(s => s.preferences.topCountries.some(c => c.toLowerCase().includes(country.toLowerCase())));
  if (hasMessages === 'true') subs = subs.filter(s => s.messages.some(m => m.direction === 'in'));
  if (search) {
    const q = search.toLowerCase();
    subs = subs.filter(s => (s.firstName+' '+s.lastName).toLowerCase().includes(q) || (s.username||'').toLowerCase().includes(q));
  }

  // Sort
  if (sort === 'searches') subs.sort((a,b) => b.totalSearches - a.totalSearches);
  else if (sort === 'name') subs.sort((a,b) => a.firstName.localeCompare(b.firstName));
  else subs.sort((a,b) => new Date(b.lastActive) - new Date(a.lastActive)); // default: lastActive

  // Return summary (not full messages/searches to save bandwidth)
  res.json(subs.map(s => ({
    chatId: s.chatId, firstName: s.firstName, lastName: s.lastName, username: s.username,
    joinedAt: s.joinedAt, lastActive: s.lastActive,
    totalSearches: s.totalSearches, tags: s.tags, blocked: s.blocked,
    preferences: s.preferences,
    lastSearch: s.searches[s.searches.length-1] || null,
    unreadMessages: s.messages.filter(m => m.direction === 'in').length,
  })));
});

// Single subscriber detail
app.get('/api/subscriber/:chatId', authCheck, (req, res) => {
  const sub = db.subscribers[req.params.chatId];
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub);
});

// Chat messages for a subscriber
app.get('/api/messages/:chatId', authCheck, (req, res) => {
  const sub = db.subscribers[req.params.chatId];
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub.messages);
});

// Send message to subscriber
app.post('/api/send', authCheck, async (req, res) => {
  const { chatId, text, parseMode, buttons, photoUrl } = req.body;
  if (!chatId || (!text && !photoUrl)) return res.status(400).json({ error: 'chatId and text/photoUrl required' });

  try {
    const opts = { parse_mode: parseMode || 'HTML', disable_web_page_preview: true };

    // Build inline keyboard if buttons provided
    if (buttons && buttons.length > 0) {
      opts.reply_markup = { inline_keyboard: buttons };
    }

    let sent;
    if (photoUrl) {
      opts.caption = text || '';
      sent = await bot.sendPhoto(chatId, photoUrl, opts);
      storeMessage(chatId, 'out', text || '', { photo: photoUrl, buttons });
    } else {
      sent = await bot.sendMessage(chatId, text, opts);
      storeMessage(chatId, 'out', text, { buttons });
    }
    saveDB();
    res.json({ ok: true, messageId: sent.message_id });
  } catch (e) {
    // Mark as blocked if user blocked the bot
    if (e.message.includes('blocked') || e.message.includes('deactivated')) {
      const sub = getSub(chatId);
      sub.blocked = true;
      saveDB();
    }
    res.status(500).json({ error: e.message });
  }
});

// Broadcast to segment
app.post('/api/broadcast', authCheck, async (req, res) => {
  const { text, parseMode, buttons, photoUrl, tag, countryFilter } = req.body;
  if (!text && !photoUrl) return res.status(400).json({ error: 'text or photoUrl required' });

  let targets = Object.values(db.subscribers).filter(s => !s.blocked);
  if (tag) targets = targets.filter(s => s.tags.includes(tag));
  if (countryFilter) targets = targets.filter(s => s.preferences.topCountries.some(c => c.toLowerCase().includes(countryFilter.toLowerCase())));

  res.json({ ok: true, targets: targets.length, status: 'sending' });

  // Send async
  let sent = 0, failed = 0;
  for (const sub of targets) {
    try {
      const opts = { parse_mode: parseMode || 'HTML', disable_web_page_preview: true };
      if (buttons && buttons.length > 0) opts.reply_markup = { inline_keyboard: buttons };

      if (photoUrl) { opts.caption = text || ''; await bot.sendPhoto(sub.chatId, photoUrl, opts); }
      else { await bot.sendMessage(sub.chatId, text, opts); }

      storeMessage(sub.chatId, 'out', text || '', { photo: photoUrl, buttons, broadcast: true });
      sent++;
      if (sent % 25 === 0) await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      failed++;
      if (e.message.includes('blocked') || e.message.includes('deactivated')) sub.blocked = true;
    }
  }
  saveDB();
  // Notify admin via Telegram
  if (ADMIN_CHAT_ID) {
    bot.sendMessage(ADMIN_CHAT_ID, `✅ Broadcast: ${sent} trimise, ${failed} erori`).catch(()=>{});
  }
});

// Backup
app.post('/api/backup', authCheck, async (req, res) => {
  saveDB();
  await backupToGitHub();
  res.json({ ok: true });
});

// Export
app.get('/api/export', authCheck, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=zebratur_subscribers.json');
  res.send(JSON.stringify(db, null, 2));
});

// Serve admin panel — try file first, fallback to inline
let ADMIN_HTML = '';
try { ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'); } catch(e) {
  console.log('⚠️ admin.html nu a fost găsit, se folosește versiunea inline');
}
function serveAdmin(req, res) {
  // Try reading file fresh (in case it was added later)
  if (!ADMIN_HTML) { try { ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'); } catch(e) {} }
  if (ADMIN_HTML) { res.setHeader('Content-Type', 'text/html'); res.send(ADMIN_HTML); }
  else { res.setHeader('Content-Type', 'text/html'); res.send('<!DOCTYPE html><html><body><h1>Admin panel HTML missing</h1><p>Upload admin.html to the repo</p></body></html>'); }
}
app.get('/', serveAdmin);
app.get('/admin', serveAdmin);

// ================================================================
//  STARTUP
// ================================================================
(async () => {
  console.log('=== ZebraTur Bot Startup ===');
  console.log(`PostgreSQL: ${DATABASE_URL ? '✅ configurat' : '❌ NU e configurat!'}`);
  console.log(`GitHub Backup: ${GITHUB_TOKEN && GITHUB_REPO ? '✅ configurat (' + GITHUB_REPO + ')' : '⚠️ opțional, nu e setat'}`);
  console.log(`Admin Password: ${ADMIN_PASSWORD === 'zebratur2026' ? '⚠️ default (zebratur2026)' : '✅ custom'}`);

  // 1. Initialize PostgreSQL table
  await initPostgres();

  // 2. Load data from PostgreSQL
  await loadDB();

  // 3. If PostgreSQL is empty, migrate from GitHub (one-time)
  await migrateFromGitHub();

  // Auto-save to PostgreSQL every 2 minutes + GitHub backup every 10 minutes
  setInterval(() => { saveDB(); }, 2 * 60 * 1000);
  setInterval(() => { backupToGitHub(); }, 10 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`🌐 Admin panel: http://localhost:${PORT}`);
    console.log(`📊 DB: ${Object.keys(db.subscribers).length} abonați | ${db.meta.totalSearches||0} căutări`);
    console.log('🤖 ZebraTur Bot + CRM + PostgreSQL — ready!');
  });
})();

process.on('SIGINT', async () => { await saveDB(); bot.stopPolling(); process.exit(0); });
process.on('SIGTERM', async () => { await saveDB(); await backupToGitHub(); bot.stopPolling(); process.exit(0); });

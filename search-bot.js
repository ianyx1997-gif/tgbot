/* ============================================================
   ZEBRATUR – TELEGRAM BOT v3: ZEBRA AI + CRM + ADMIN PANEL

   v3 (2026-06): wizard-ul cu butoane a fost înlocuit cu agentul
   conversațional Zebra AI (Claude + otpusk, serviciul zebra-chat).
   - turistul scrie liber (RO/RU) sau apasă o destinație
   - ofertele apar drept CARDURI cu poză + navigare ◀ ▶ (editMessageMedia)
   - „Detalii" = album foto + fișa reală a hotelului, „Rezervă" = lead
     telefonic cu buton nativ „Trimite numărul meu"
   PĂSTRATE 100%: baza de abonați (Postgres bot_data), CRM-ul
   (preferințe/taguri/mesaje), panoul admin (admin.html + /api/*),
   broadcast, backup GitHub.

   ENV: TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, ADMIN_PASSWORD, DATABASE_URL,
        ZEBRA_CHAT_API (creierul AI), INTERNAL_KEY (bypass rate-limit),
        GITHUB_TOKEN/GITHUB_REPO (opțional), PORT
   ============================================================ */

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { Pool } = require('pg');
const { runTurn, hotelDetail } = require('./agent-bridge');

// ===== CONFIG =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID) : null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'zebratur2026';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PORT = process.env.PORT || 3000;
const PHONE = '078 326 222';

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

// ================================================================
//  DATABASE (PostgreSQL primary, GitHub secondary backup) — NESCHIMBAT
// ================================================================
let db = {
  subscribers: {},
  meta: { createdAt: new Date().toISOString(), totalSearches: 0 }
};

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

// debounce: DB-ul e UN rând JSONB — nu-l rescrie de 3 ori pe tură; flush la 10s + la shutdown
let dbDirty = false;
function markDirty() { dbDirty = true; }
setInterval(() => { if (dbDirty) { dbDirty = false; saveDB(); } }, 10000).unref?.();

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
        console.log(`✅ Migrat din GitHub → PostgreSQL: ${Object.keys(db.subscribers).length} abonați`);
      }
    }
  } catch (e) { console.error('⚠️ Migrare GitHub error:', e.message); }
}

// ================================================================
//  SUBSCRIBER CRM — NESCHIMBAT (aceeași schemă ca v2)
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
  if (from) {
    sub.firstName = from.first_name || ''; sub.lastName = from.last_name || ''; sub.username = from.username || '';
    if (from.language_code) sub.lang = /^ru/i.test(from.language_code) ? 'ru' : (sub.lang === 'ru' ? 'ru' : 'ro');
  }
  sub.lastActive = new Date().toISOString();
}
function isRu(chatId) { const s = db.subscribers[String(chatId)]; return !!(s && s.lang === 'ru'); }

function storeMessage(chatId, direction, text, extra) {
  const sub = getSub(chatId);
  sub.messages.push({
    direction, text: text || '', extra: extra || null,
    timestamp: new Date().toISOString(),
  });
  if (sub.messages.length > 200) sub.messages = sub.messages.slice(-200);
}

// v3: căutările vin din agentul AI (query-ul real căutat) — aceeași schemă de înregistrare
function recordSearch(chatId, q) {
  const sub = getSub(chatId);
  sub.searches.push({
    country: q.destination || '?', countryId: null,
    dateFrom: q.checkIn || null, nights: q.nights || 7,
    adults: q.adults || 2, children: [...(q.childrenAges || [])],
    food: 'ai', stars: '', timestamp: new Date().toISOString(),
  });
  if (sub.searches.length > 50) sub.searches = sub.searches.slice(-50); // simetric cu messages
  sub.totalSearches++;
  db.meta.totalSearches++;
  updatePreferences(sub);
  updateTags(sub);
  markDirty();
  backupToGitHub().catch(() => {});
  if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
    const name = sub.firstName + (sub.lastName ? ' ' + sub.lastName : '');
    bot.sendMessage(ADMIN_CHAT_ID,
      `🔔 <b>Căutare nouă (AI)</b>\n${esc(name)}${sub.username ? ' @' + esc(sub.username) : ''}\n🌍 ${esc(q.destination || '?')} | ${q.nights || 7}n | ${q.adults || 2}ad${(q.childrenAges||[]).length ? ' +' + q.childrenAges.length + ' copii' : ''}`,
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
//  ZEBRA AI — strat de conversație Telegram (v3.1: flux ghidat)
//  Destinația + parametrii se strâng prin BUTOANE (zero tokeni),
//  apoi se face O singură căutare AI precisă. Text liber = direct la agent.
// ================================================================
const DESTS = [
  '🇹🇷 Turcia', '🇬🇷 Grecia', '🇪🇬 Egipt', '🇧🇬 Bulgaria', '🇲🇪 Muntenegru',
  '🇪🇸 Spania', '🇹🇳 Tunisia', '🇦🇱 Albania', '🇨🇾 Cipru',
];
const MONTH_FULL = ['ianuarie','februarie','martie','aprilie','mai','iunie','iulie','august','septembrie','octombrie','noiembrie','decembrie'];
const NIGHTS_OPTS = [5, 6, 7, 10, 14];
// DIAPAZOANE de buget (nu plafoane!) — turistul cu 5000€ vrea oferte de ~5000€, nu de la 1000€
const BUDGET_OPTS = [
  { t: 'sub 1000€', lo: 0, hi: 1000 },
  { t: '1000–1500€', lo: 1000, hi: 1500 }, { t: '1500–2000€', lo: 1500, hi: 2000 },
  { t: '2000–2500€', lo: 2000, hi: 2500 }, { t: '2500–3500€', lo: 2500, hi: 3500 },
  { t: '3500–4500€', lo: 3500, hi: 4500 }, { t: '4500–6000€', lo: 4500, hi: 6000 },
  { t: '💎 6000€+', v: 'plus' }, { t: '🤷 Orice buget', v: 'any' },
];

const agentSessions = new Map();   // chatId -> sessionId zebra-chat
const busyChats = new Set();       // chat-uri cu o tură în lucru
const OFFERS = new Map();          // `${chatId}:${msgId}` -> { offer, lang } (card individual)
const MORE = new Map();            // chatId -> { rest, lang, query } (restul ofertelor, la cerere)
const CHIPS = new Map();           // `${chatId}:${msgId}` -> [chips]
const pendingRemoveKb = new Set(); // chat-uri cărora le scoatem reply-keyboard-ul la următorul mesaj
const QFLOW = new Map();           // chatId -> starea fluxului ghidat (wizard fără tokeni)
const FINISHED = new Set();        // chat-uri cu wizard abia încheiat (tap-urile întârziate nu repornesc wizardul)
const inFlight = new Set();        // anti dublu-tap pe Detalii/Rezervă (`${chatId}:${msgId}:${act}`)

function capMap(m, max) { if (m.size > max) m.delete(m.keys().next().value); }

// i18n minimal pentru etichetele cardurilor
const TL = {
  ro: { nights: 'nopți', det: '📋 Detalii', book: '📞 Rezervă', from: 'de la', conf: '✓ confirmat',
        adults: 'ad.', kids: 'copii', pick: '🏆 Alegerea Zebrei', rev: 'recenzii',
        noFly: '🏨 Doar cazare (fără zbor)', bus: '🚌 Transport cu autocar',
        bookTpl: (n, p, d) => `Vreau să rezerv ${n} — ${p}€, plecare ${d}. Cum procedăm?`,
        share: 'Poți trimite numărul de telefon cu un singur tap 👇 (sau scrie-l în chat)',
        shareBtn: '📞 Trimite numărul meu', cancel: 'Anulează',
        moreMsg: (n) => `👆 Acestea sunt primele oferte. Mai am <b>încă ${n}</b> la fel de bune.`,
        moreBtn: (n) => `➕ Arată-le pe celelalte ${n}`,
        newSearch: '🔍 Caută altă ofertă',
        months: ['ian','feb','mar','apr','mai','iun','iul','aug','sep','oct','noi','dec'] },
  ru: { nights: 'ноч.', det: '📋 Детали', book: '📞 Бронировать', from: 'от', conf: '✓ цена ок',
        adults: 'взр.', kids: 'дет.', pick: '🏆 Выбор Зебры', rev: 'отзывов',
        noFly: '🏨 Только отель (без перелёта)', bus: '🚌 Автобусный тур',
        bookTpl: (n, p, d) => `Хочу забронировать ${n} — ${p}€, вылет ${d}. Как оформить?`,
        share: 'Можно отправить номер одним нажатием 👇 (или напишите его в чат)',
        shareBtn: '📞 Отправить мой номер', cancel: 'Отмена',
        moreMsg: (n) => `👆 Это первые варианты. Есть <b>ещё ${n}</b> не хуже.`,
        moreBtn: (n) => `➕ Показать остальные ${n}`,
        newSearch: '🔍 Искать другое',
        months: ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'] },
  en: { nights: 'nights', det: '📋 Details', book: '📞 Book', from: 'from', conf: '✓ confirmed',
        adults: 'ad.', kids: 'kids', pick: '🏆 Zebra’s pick', rev: 'reviews',
        noFly: '🏨 Hotel only (no flight)', bus: '🚌 Bus transfer',
        bookTpl: (n, p, d) => `I want to book ${n} — ${p}€, departure ${d}. How do we proceed?`,
        share: 'Share your phone number with one tap 👇 (or type it)',
        shareBtn: '📞 Share my number', cancel: 'Cancel',
        moreMsg: (n) => `👆 These are the first picks. I have <b>${n} more</b> just as good.`,
        moreBtn: (n) => `➕ Show the other ${n}`,
        newSearch: '🔍 New search',
        months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] },
};
const lang3 = (l) => TL[l] ? l : 'ro';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const mdHtml = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const fmtP = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function fmtD(iso, L) { if (!iso) return ''; const p = String(iso).split('-'); return p.length === 3 ? (+p[2]) + ' ' + L.months[+p[1] - 1] : iso; }
function revCount(o) {
  const sum = (o.reviewSites || []).reduce((s, r) => s + (r.count || 0), 0);
  const n = Math.max(sum, o.votes || 0);
  return n ? (n > 999 ? (Math.round(n / 100) / 10) + 'k' : String(n)) : '';
}

function offerCaption(o, idx, total, query, L) {
  const occ = `${query.adults || 2} ${L.adults}` + ((query.childrenAges || []).length ? ` + ${query.childrenAges.length} ${L.kids}` : '');
  const lines = [];
  lines.push(`${o.rank === 1 ? '🏆 ' : ''}<b>${idx + 1}/${total} · ${esc(cut(o.name, 60))}</b>`);
  const stars = o.stars ? '★'.repeat(Math.min(o.stars, 5)) : '';
  const rate = o.rating ? ` · ⭐ ${o.rating}${revCount(o) ? ` (${revCount(o)})` : ''}` : '';
  lines.push(`${stars}${rate} · 📍 ${esc([o.city, o.country].filter(Boolean).join(', '))}`);
  // PREȚUL pe rând propriu, încadrat de rânduri goale — primul lucru pe care-l vezi
  lines.push('');
  lines.push(`💰 <b>${fmtP(o.price)} €</b>  ${o.confirmed ? L.conf : L.from} · ${esc(o.board || '')}`);
  lines.push('');
  lines.push(`📅 ${fmtD(o.departDate, L)} · ${o.nights} ${L.nights} · 👥 ${occ}`);
  if (o.transport === 'no') lines.push(L.noFly);
  else if (o.transport === 'bus') lines.push(L.bus);
  else {
    const f = o.flightOut, b = o.flightBack;
    if (f) lines.push(`✈️ ${esc(f.from || 'RMO')} ${esc(f.departTime || '')} → ${esc(f.to || '')} ${esc(f.arriveTime || '')}${f.airline ? ' · ' + esc(f.airline) : ''}`);
    if (b) lines.push(`↩️ ${esc(b.from || '')} ${esc(b.departTime || '')} → ${esc(b.to || 'RMO')} ${esc(b.arriveTime || '')}`);
  }
  return lines.join('\n');
}

// prețul ȘI în butonul de rezervare + ieșire clară spre o căutare nouă
const cardKb = (L, o) => ({ inline_keyboard: [
  [{ text: L.det, callback_data: 'cdet' }, { text: `${L.book} · ${fmtP(o.price)} €`, callback_data: 'cbook' }],
  [{ text: L.newSearch, callback_data: 'qnew' }],
] });

// fiecare ofertă = MESAJ SEPARAT cu poză + butoane (clar că-s mai multe; fără carusel ascuns)
const FIRST_BATCH = 5;
async function sendOfferCards(chatId, payload) {
  const lang = lang3(payload.lang);
  const L = TL[lang];
  const offers = payload.offers || [];
  if (!offers.length) return;
  const query = payload.query || {};
  const first = offers.slice(0, FIRST_BATCH);
  const rest = offers.slice(FIRST_BATCH);
  await sendCardBatch(chatId, first, 0, offers.length, query, lang);
  if (rest.length) {
    const sentM = await bot.sendMessage(chatId, L.moreMsg(rest.length), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: L.moreBtn(rest.length), callback_data: 'more' }]] },
    }).catch(() => null);
    if (sentM) { MORE.set(`${chatId}:${sentM.message_id}`, { rest, lang, query, total: offers.length }); capMap(MORE, 2000); }
  }
  storeMessage(chatId, 'out', `[${offers.length} oferte: ${query.destination || ''}]`, { cards: true });
  recordSearch(chatId, { ...query });
}

async function sendCardBatch(chatId, batch, startIdx, total, query, lang) {
  const L = TL[lang];
  for (let i = 0; i < batch.length; i++) {
    const o = batch[i];
    const caption = offerCaption(o, startIdx + i, total, query, L);
    let sent = null;
    try {
      sent = await bot.sendPhoto(chatId, o.photoLarge || o.photo, { caption, parse_mode: 'HTML', reply_markup: cardKb(L, o) });
    } catch (e) {
      try { sent = await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: cardKb(L, o) }); } catch {}
    }
    if (sent) { OFFERS.set(`${chatId}:${sent.message_id}`, { offer: o, lang }); capMap(OFFERS, 2000); }
    await new Promise((r) => setTimeout(r, 350)); // ordinea mesajelor + rate-limit Telegram
  }
}

const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

async function showDetails(chatId, st) {
  const o = st.offer;
  const L = TL[st.lang];
  await bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
  let d = null;
  try { d = await hotelDetail(o.hotelId, st.lang); } catch {}
  // album cu poze (slideshow nativ Telegram cu zoom)
  const photos = (d && d.ok && d.photos && d.photos.length ? d.photos : [o.photoLarge || o.photo]).filter(Boolean).slice(0, 6);
  if (photos.length > 1) {
    try { await bot.sendMediaGroup(chatId, photos.map((p) => ({ type: 'photo', media: p }))); } catch (e) { console.error('[album]', e.message); }
  }
  const secs = { ro: { general: 'Despre hotel', beach: '🏖 Plaja', children: '👶 Pentru copii', food: '🍽 Masa' },
                 ru: { general: 'Об отеле', beach: '🏖 Пляж', children: '👶 Для детей', food: '🍽 Питание' },
                 en: { general: 'About', beach: '🏖 Beach', children: '👶 For kids', food: '🍽 Dining' } }[st.lang];
  const parts = [`<b>${esc(d && d.name || o.name)}</b>`];
  const stars = (d && d.stars) || o.stars;
  const rate = (d && d.rating) || o.rating;
  parts.push(`${stars ? '★'.repeat(Math.min(stars, 5)) + ' · ' : ''}${rate ? `⭐ ${rate}/10 · ` : ''}📍 ${esc([o.city, o.country].filter(Boolean).join(', '))}`);
  if (d && d.ok && d.description) {
    for (const [k, label] of Object.entries(secs)) {
      const v = d.description[k];
      if (v) parts.push(`\n<b>${label}</b>\n${esc(cut(v, 550))}`);
    }
    if (d.amenities && d.amenities.length) parts.push(`\n✨ ${esc(d.amenities.slice(0, 10).join(' · '))}`);
  }
  parts.push(`\n💶 <b>${fmtP(o.price)} €</b> ${o.confirmed ? L.conf : L.from} · ${esc(o.board || '')} · ${fmtD(o.departDate, L)} · ${o.nights} ${L.nights}`);
  await bot.sendMessage(chatId, cut(parts.join('\n'), 4000), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: `${L.book} · ${fmtP(o.price)} €`, callback_data: 'book_' + o.hotelId }],
      [{ text: L.newSearch, callback_data: 'qnew' }],
    ] },
  });
}

async function startBooking(chatId, o, lang) {
  const L = TL[lang3(lang)];
  // tastatura cu partajare de contact — un singur tap pt. numărul de telefon
  await bot.sendMessage(chatId, L.share, {
    reply_markup: { keyboard: [[{ text: L.shareBtn, request_contact: true }], [{ text: '✖️ ' + L.cancel }]], resize_keyboard: true, one_time_keyboard: true },
  }).catch(() => {});
  await handleUserText(chatId, L.bookTpl(o.name, fmtP(o.price), fmtD(o.departDate, L)), null, { auto: true });
}

// ---------- tura de conversație cu agentul ----------
const pendingTexts = new Map(); // chatId -> [{text, from}] mesaje sosite în timpul unei ture (NU se pierd)

// mesaje lungi (>4096) → bucăți pe linii; fallback fără HTML dacă parse-ul pică
async function sendLong(chatId, rawText, opts = {}) {
  const html = mdHtml(rawText);
  const chunks = [];
  if (html.length <= 3800) chunks.push(html);
  else {
    let cur = '';
    for (const line of html.split('\n')) {
      if (cur.length + line.length + 1 > 3800) { chunks.push(cur); cur = line; }
      else cur += (cur ? '\n' : '') + line;
    }
    if (cur) chunks.push(cur);
  }
  let last = null;
  for (const c of chunks) {
    let m = await bot.sendMessage(chatId, c, { parse_mode: 'HTML', ...opts }).catch(() => null);
    if (!m) m = await bot.sendMessage(chatId, c.replace(/<[^>]+>/g, ''), opts).catch(() => null); // HTML stricat → text simplu
    if (m) last = m;
  }
  return last;
}

async function handleUserText(chatId, text, from, opts = {}) {
  // 1) PERSISTĂ ÎNTÂI — orice s-ar întâmpla (busy, crash), mesajul rămâne în CRM
  if (!opts.requeued) {
    updateSubInfo(chatId, from);
    storeMessage(chatId, 'in', text);
    markDirty();
    // adminul vede DOAR ce tastează omul (nu și cererile compuse de butoane — recordSearch acoperă căutările)
    if (!opts.auto && ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
      const sub = getSub(chatId);
      const name = sub.firstName + (sub.lastName ? ' ' + sub.lastName : '');
      bot.sendMessage(ADMIN_CHAT_ID, `💬 <b>${esc(name)}</b>${sub.username ? ' @' + esc(sub.username) : ''}:\n${esc(text)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  }
  // 2) tura ocupată → COADĂ, nu drop (un număr de telefon pierdut = lead pierdut)
  if (busyChats.has(chatId)) {
    const qd = pendingTexts.get(chatId) || [];
    if (qd.length < 3) { qd.push({ text, from }); pendingTexts.set(chatId, qd); }
    bot.sendMessage(chatId, isRu(chatId) ? '⏳ Секунду — закончу текущий поиск и сразу отвечу.' : '⏳ O clipă — termin căutarea curentă și îți răspund imediat.').catch(() => {});
    return;
  }
  busyChats.add(chatId);

  // mesaj de status (search theater) — îl edităm pe parcurs și îl ștergem la final
  let statusId = null;
  const removeKb = pendingRemoveKb.delete(chatId);
  try {
    const m = await bot.sendMessage(chatId, '💭 Zebra AI…', removeKb ? { reply_markup: { remove_keyboard: true } } : {});
    statusId = m.message_id;
  } catch {}

  let lastTextMsgId = null;
  let gotAnything = false;

  const hooks = {
    onStatus: async (t) => {
      if (!statusId) return;
      await bot.editMessageText(t, { chat_id: chatId, message_id: statusId }).catch(() => {});
      bot.sendChatAction(chatId, 'typing').catch(() => {});
    },
    onText: async (t) => {
      const m = await sendLong(chatId, t);
      if (m) { gotAnything = true; lastTextMsgId = m.message_id; }
      storeMessage(chatId, 'out', t);
      markDirty();
    },
    onOffers: async (payload) => {
      gotAnything = true;
      await sendOfferCards(chatId, payload);
    },
    onChips: async (chips) => {
      if (!chips.length || !lastTextMsgId) return;
      const rows = [];
      for (let i = 0; i < chips.length; i += 2) rows.push(chips.slice(i, i + 2).map((c, j) => ({ text: c, callback_data: 'chip_' + (i + j) })));
      CHIPS.set(`${chatId}:${lastTextMsgId}`, chips); capMap(CHIPS, 400);
      await bot.editMessageReplyMarkup({ inline_keyboard: rows }, { chat_id: chatId, message_id: lastTextMsgId }).catch(() => {});
    },
  };

  try {
    const { sessionId } = await runTurn({ message: text, sessionId: agentSessions.get(chatId) || null, hooks });
    if (sessionId) { agentSessions.delete(chatId); agentSessions.set(chatId, sessionId); capMap(agentSessions, 5000); } // delete+set = LRU real
  } catch (e) {
    console.error('[agent]', e.message);
    if (!gotAnything) {
      bot.sendMessage(chatId, isRu(chatId)
        ? `😕 Техническая заминка. Попробуйте ещё раз или позвоните: ${PHONE}`
        : `😕 A apărut o problemă tehnică. Mai încearcă o dată sau sună-ne direct: ${PHONE}`).catch(() => {});
    }
  } finally {
    busyChats.delete(chatId);
    markDirty();
    if (statusId) bot.deleteMessage(chatId, statusId).catch(() => {});
    // procesează mesajele sosite în timpul turei (ex. numărul de telefon)
    const qd = pendingTexts.get(chatId);
    if (qd && qd.length) {
      const next = qd.shift();
      if (!qd.length) pendingTexts.delete(chatId);
      setTimeout(() => handleUserText(chatId, next.text, next.from, { requeued: true }).catch(() => {}), 400);
    }
  }
}

// ================================================================
//  FLUX GHIDAT (wizard cu butoane — ZERO tokeni până la căutare)
//  destinație → luna → perioada din lună → nopți → adulți → copii
//  (+vârste) → buget → compune cererea și o dă agentului AI
// ================================================================
const FOOD_LBL = { any: '🍽 oricare', bb: '🥐 mic dejun+', hb: '🍲 demipensiune+', fb: '🍱 pensiune completă+', ai: '🏖 All Inclusive+', uai: '👑 Ultra AI' };
const EXTRA_OPTS = [
  { k: 'one_line_beach', t: '🏖 Prima linie' }, { k: 'sandy', t: '🏝 Plajă cu nisip' },
  { k: 'aquapark', t: '🎢 Aquapark' }, { k: 'spa', t: '💆 SPA' }, { k: 'family', t: '👨‍👩‍👧 Pt. familii' },
];

function qSummary(q) {
  const bits = [];
  if (q.dest) bits.push(q.dest);
  if (q.day != null && q.month != null) {
    const mm = MONTH_FULL[q.month].slice(0, 3);
    bits.push(q.dayEnd != null ? `📆 ${q.day}–${q.dayEnd} ${mm}` : `📆 ${q.day} ${mm}${q.strict ? ' (fix)' : ' ±4z'}`);
  } else if (q.month != null) {
    bits.push(MONTH_FULL[q.month] + (q.part && q.part !== 'whole' ? ` (${{ start: 'început', mid: 'mijloc', end: 'sfârșit' }[q.part]})` : ''));
  }
  if (q.nights) bits.push(`🌙 ${q.nights}n`);
  if (q.adults) bits.push(`👥 ${q.adults}${q.kids && q.kids.length ? '+' + q.kids.length : ''}`);
  if (q.food) bits.push(FOOD_LBL[q.food] || q.food);
  if (q.extras && q.extras.length) bits.push(q.extras.map((k) => (EXTRA_OPTS.find((e) => e.k === k) || {}).t).filter(Boolean).join(' '));
  if (q.budget) bits.push('💶 ' + q.budget.t.replace('🤷 ', '').replace('💎 ', ''));
  return bits.join(' | ');
}

async function qRender(chatId, title, kbRows) {
  const q = QFLOW.get(chatId);
  const text = (qSummary(q) ? `<i>${esc(qSummary(q))}</i>\n\n` : '') + title;
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: kbRows } };
  try {
    if (q && q.msgId) await bot.editMessageText(text, { chat_id: chatId, message_id: q.msgId, ...opts });
    else { const m = await bot.sendMessage(chatId, text, opts); q.msgId = m.message_id; }
  } catch (e) {
    if (!/not modified/i.test(e.message)) { try { const m = await bot.sendMessage(chatId, text, opts); q.msgId = m.message_id; } catch {} }
  }
}

function qStart(chatId) {
  QFLOW.set(chatId, { step: 'dest', dest: null, month: null, part: null, day: null, dayEnd: null, dateMode: null, strict: false, nights: 7, adults: 2, kids: [], kidsLeft: 0, food: null, extras: [], budget: null, msgId: null });
  capMap(QFLOW, 3000);
  const kb = [];
  for (let i = 0; i < DESTS.length; i += 3) kb.push(DESTS.slice(i, i + 3).map((d, j) => ({ text: d, callback_data: 'qd_' + (i + j) })));
  kb.push([{ text: '🏨 Caut un hotel anume', callback_data: 'qhotel' }, { text: '🔥 Oferte fierbinți', callback_data: 'hot' }]);
  kb.push([{ text: '✍️ Prefer să scriu liber', callback_data: 'qfree' }]);
  return qRender(chatId, '🌍 <b>Unde zburăm în vacanță?</b>', kb);
}

function qMonths(chatId) {
  const now = new Date(), kb = [];
  // include și LUNA CURENTĂ (last-minute, piață fierbinte la moldoveni)
  kb.push([{ text: `🔜 Cât mai curând (${MONTH_FULL[now.getMonth()].slice(0, 3)}–${MONTH_FULL[(now.getMonth() + 1) % 12].slice(0, 3)})`, callback_data: 'qm_now' }]);
  const ms = [];
  for (let i = 0; i < 9; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + 1 + i, 1);
    ms.push({ y: d.getFullYear(), m: d.getMonth(), t: MONTH_FULL[d.getMonth()].slice(0, 3) + (d.getFullYear() !== now.getFullYear() ? ` '${String(d.getFullYear()).slice(2)}` : '') });
  }
  for (let i = 0; i < ms.length; i += 3) kb.push(ms.slice(i, i + 3).map((x) => ({ text: `📅 ${x.t}`, callback_data: `qm_${x.y}_${x.m}` })));
  kb.push([{ text: '↩️ De la început', callback_data: 'qnew' }]);
  return qRender(chatId, '📅 <b>În ce lună plecați?</b>', kb);
}

const qBack = [{ text: '↩️ De la început', callback_data: 'qnew' }];

const qParts = (chatId) => qRender(chatId, '📆 <b>Când în lună?</b>', [
  [{ text: '🗓 Oricând în lună (cele mai bune prețuri)', callback_data: 'qp_whole' }],
  [{ text: 'Început', callback_data: 'qp_start' }, { text: 'Mijloc', callback_data: 'qp_mid' }, { text: 'Sfârșit', callback_data: 'qp_end' }],
  [{ text: '📍 Aleg ziua exactă', callback_data: 'qdx' }, { text: '↔️ Interval de zile', callback_data: 'qdr' }],
  qBack,
]);

// grilă de zile pentru luna aleasă (rows de 7); fromDay = pt. capătul intervalului
function qDays(chatId, title, fromDay) {
  const q = QFLOW.get(chatId);
  if (!q || q.month == null) return;
  const dim = new Date(q.year, q.month + 1, 0).getDate();
  const start = fromDay || 1;
  const kb = [];
  let row = [];
  for (let d = start; d <= dim; d++) {
    row.push({ text: String(d), callback_data: 'qz_' + d });
    if (row.length === 7) { kb.push(row); row = []; }
  }
  if (row.length) kb.push(row);
  kb.push(qBack);
  return qRender(chatId, title, kb);
}

const qStrict = (chatId) => qRender(chatId, '🎯 <b>Cât de fixă e data?</b>', [
  [{ text: '± câteva zile e OK (prețuri mai bune)', callback_data: 'qfx_0' }],
  [{ text: '🎯 Fix pe această zi', callback_data: 'qfx_1' }],
  qBack,
]);

const qFood = (chatId) => qRender(chatId, '🍽 <b>Ce masă vrei?</b>\n<i>Nivelul ales include și tot ce e mai bun decât el.</i>', [
  [{ text: '🏖 All Inclusive+ ⭐', callback_data: 'qf_ai' }, { text: '👑 Doar Ultra AI', callback_data: 'qf_uai' }],
  [{ text: '🍲 Demipensiune+', callback_data: 'qf_hb' }, { text: '🍱 Pensiune completă+', callback_data: 'qf_fb' }],
  [{ text: '🥐 Mic dejun+', callback_data: 'qf_bb' }, { text: '🍽 Oricare', callback_data: 'qf_any' }],
  qBack,
]);

function qExtras(chatId) {
  const q = QFLOW.get(chatId);
  const kb = [];
  for (let i = 0; i < EXTRA_OPTS.length; i += 2) {
    kb.push(EXTRA_OPTS.slice(i, i + 2).map((e) => ({
      text: (q.extras.includes(e.k) ? '✅ ' : '') + e.t,
      callback_data: 'qe_' + e.k,
    })));
  }
  kb.push([{ text: q.extras.length ? '➡️ Gata, mai departe' : '➡️ Fără preferințe, mai departe', callback_data: 'qe_done' }]);
  kb.push(qBack);
  return qRender(chatId, '✨ <b>Preferințe speciale?</b> <i>(poți bifa mai multe)</i>', kb);
}

const qNights = (chatId) => qRender(chatId, '🌙 <b>Câte nopți?</b>', [
  NIGHTS_OPTS.map((n) => ({ text: n === 7 ? '⭐ 7' : String(n), callback_data: 'qn_' + n })),
  qBack,
]);

const qAdults = (chatId) => qRender(chatId, '👤 <b>Câți adulți?</b>', [
  [1, 2, 3, 4].map((n) => ({ text: n === 2 ? '⭐ 2' : String(n), callback_data: 'qa_' + n })),
  qBack,
]);

const qKids = (chatId) => qRender(chatId, '👶 <b>Copii?</b>', [
  [{ text: '❌ Fără copii', callback_data: 'qk_0' }],
  [1, 2, 3].map((n) => ({ text: `${n} ${n === 1 ? 'copil' : 'copii'}`, callback_data: 'qk_' + n })),
  qBack,
]);

function qKidAge(chatId) {
  const q = QFLOW.get(chatId);
  const nr = q.kids.length + 1, tot = q.kids.length + q.kidsLeft;
  const kb = [];
  for (let a = 1; a <= 15; a += 5) kb.push(Array.from({ length: Math.min(5, 16 - a) }, (_, j) => ({ text: String(a + j), callback_data: 'qg_' + (a + j) })));
  return qRender(chatId, `👶 <b>Vârsta copilului ${nr} din ${tot}:</b>`, kb);
}

const qBudget = (chatId) => qRender(chatId, '💶 <b>Ce buget aveți (total, pe toți)?</b>\n<i>Caut oferte exact în diapazonul ales.</i>', [
  [BUDGET_OPTS[0], BUDGET_OPTS[1]].map((b, i) => ({ text: b.t, callback_data: 'qb_' + BUDGET_OPTS.indexOf(b) })),
  BUDGET_OPTS.slice(2, 5).map((b) => ({ text: b.t, callback_data: 'qb_' + BUDGET_OPTS.indexOf(b) })),
  BUDGET_OPTS.slice(5, 7).map((b) => ({ text: b.t, callback_data: 'qb_' + BUDGET_OPTS.indexOf(b) })),
  BUDGET_OPTS.slice(7).map((b) => ({ text: b.t, callback_data: 'qb_' + BUDGET_OPTS.indexOf(b) })),
]);

const MONTH_RU_PREP = ['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];
const MONTH_RU_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const DEST_RU = { Turcia: 'Турция', Grecia: 'Греция', Egipt: 'Египет', Bulgaria: 'Болгария', Muntenegru: 'Черногория', Spania: 'Испания', Tunisia: 'Тунис', Albania: 'Албания', Cipru: 'Кипр' };

async function qFinish(chatId, from) {
  const q = QFLOW.get(chatId);
  QFLOW.delete(chatId);
  FINISHED.add(chatId); setTimeout(() => FINISHED.delete(chatId), 90000);
  if (!q || !q.dest) return;
  const ru = isRu(chatId); // rusofonii primesc cererea compusă în rusă → agentul + cardurile răspund în rusă
  const yr = q.year || new Date().getFullYear();
  const FOOD_RO = { any: 'orice masă', bb: 'masă mic dejun sau mai bună', hb: 'masă demipensiune sau mai bună', fb: 'masă pensiune completă sau mai bună', ai: 'All Inclusive', uai: 'doar Ultra All Inclusive' };
  const FOOD_RU = { any: 'любое питание', bb: 'питание завтраки или лучше', hb: 'полупансион или лучше', fb: 'полный пансион или лучше', ai: 'всё включено', uai: 'только ультра всё включено' };
  const EXTRA_RO = { one_line_beach: 'pe prima linie la mare', sandy: 'cu plajă cu nisip', aquapark: 'cu aquapark', spa: 'cu SPA', family: 'potrivit pentru familii' };
  const EXTRA_RU = { one_line_beach: 'на первой линии у моря', sandy: 'с песчаным пляжем', aquapark: 'с аквапарком', spa: 'со SPA', family: 'подходит для семей' };
  let period, parts;
  if (ru) {
    period = q.month == null ? 'как можно скорее'
      : q.dayEnd != null ? `вылет между ${q.day} и ${q.dayEnd} ${MONTH_RU_GEN[q.month]} ${yr}`
      : q.day != null ? (q.strict ? `вылет СТРОГО ${q.day} ${MONTH_RU_GEN[q.month]} ${yr} (фиксированная дата)` : `вылет ${q.day} ${MONTH_RU_GEN[q.month]} ${yr} (±4 дня)`)
      : q.part === 'start' ? `в начале ${MONTH_RU_GEN[q.month]} ${yr}`
      : q.part === 'mid' ? `в середине ${MONTH_RU_GEN[q.month]} ${yr}`
      : q.part === 'end' ? `в конце ${MONTH_RU_GEN[q.month]} ${yr}`
      : `в ${MONTH_RU_PREP[q.month]} ${yr}`;
    parts = [DEST_RU[q.dest] || q.dest, period, `${q.nights} ночей`, `${q.adults} взросл${q.adults === 1 ? 'ый' : 'ых'}`];
    if (q.kids.length) parts.push(q.kids.length === 1 ? `1 ребёнок (${q.kids[0]} лет)` : `${q.kids.length} детей (${q.kids.join(', ')} лет)`);
    if (q.food && q.food !== 'ai') parts.push(FOOD_RU[q.food]);
    if (q.extras.length) parts.push(q.extras.map((k) => EXTRA_RU[k]).filter(Boolean).join(', '));
    const b = q.budget;
    if (b && b.v !== 'any') {
      if (b.v === 'plus') parts.push('бюджет свыше 6000€ (премиум)');
      else if (b.lo === 0) parts.push(`бюджет до ${b.hi}€`);
      else parts.push(`бюджет от ${b.lo} до ${b.hi}€`);
    }
  } else {
    period = q.month == null ? 'cât mai curând'
      : q.dayEnd != null ? `plecare între ${q.day} și ${q.dayEnd} ${MONTH_FULL[q.month]} ${yr}`
      : q.day != null ? (q.strict ? `plecare STRICT pe ${q.day} ${MONTH_FULL[q.month]} ${yr} (dată fixă)` : `plecare pe ${q.day} ${MONTH_FULL[q.month]} ${yr} (±4 zile)`)
      : q.part === 'start' ? `la începutul lui ${MONTH_FULL[q.month]} ${yr}`
      : q.part === 'mid' ? `la mijlocul lui ${MONTH_FULL[q.month]} ${yr}`
      : q.part === 'end' ? `la sfârșitul lui ${MONTH_FULL[q.month]} ${yr}`
      : `în ${MONTH_FULL[q.month]} ${yr}`;
    parts = [q.dest, period, `${q.nights} nopți`, `${q.adults} ${q.adults === 1 ? 'adult' : 'adulți'}`];
    if (q.kids.length) parts.push(`${q.kids.length} ${q.kids.length === 1 ? 'copil' : 'copii'} (${q.kids.join(', ')} ani)`);
    if (q.food && q.food !== 'ai') parts.push(FOOD_RO[q.food]);
    if (q.extras.length) parts.push(q.extras.map((k) => EXTRA_RO[k]).filter(Boolean).join(', '));
    const b = q.budget;
    if (b && b.v !== 'any') {
      if (b.v === 'plus') parts.push('buget peste 6000€ (premium)');
      else if (b.lo === 0) parts.push(`buget până la ${b.hi}€`);
      else parts.push(`buget între ${b.lo} și ${b.hi}€`);
    }
  }
  const text = parts.join(', ');
  if (q.msgId) bot.editMessageText(`✅ <i>${esc(qSummary(q))}</i>`, { chat_id: chatId, message_id: q.msgId, parse_mode: 'HTML' }).catch(() => {});
  await handleUserText(chatId, text, from, { auto: true });
}

// ================================================================
//  COMENZI & HANDLERE
// ================================================================
const WELCOME = '👋 <b>Bun venit la Zebra Tur!</b>\n\n' +
  'Sunt <b>Zebra AI</b> — consultantul tău de vacanțe: alegi destinația și răspunzi la câteva întrebări rapide, ' +
  'iar eu îți găsesc cele mai bune oferte REALE cu zbor din Chișinău — cu poze, prețuri confirmate și rezervare prin telefon.\n\n' +
  '<i>Poți și să-mi scrii liber, ca unui consultant: „Turcia în august, 2 adulți, buget 2000". Можно и на русском.</i> 🦓';

// /id — merge ORIUNDE (privat/grup/temă): afișează chat_id + message_thread_id pt. configurarea lead-urilor
bot.onText(/^\/id(@\w+)?$/, async (msg) => {
  const lines = [`🆔 chat_id: <code>${msg.chat.id}</code>`];
  if (msg.message_thread_id) lines.push(`🧵 topic_id: <code>${msg.message_thread_id}</code>`);
  lines.push(`tip: ${msg.chat.type}${msg.chat.title ? ' · ' + esc(msg.chat.title) : ''}`);
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML', ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}) }).catch(() => {});
});

bot.onText(/\/start/, async (msg) => {
  if (msg.chat.type !== 'private') return; // agentul lucrează doar în privat
  const chatId = msg.chat.id;
  updateSubInfo(chatId, msg.from); markDirty(); backupToGitHub().catch(() => {});
  await bot.sendMessage(chatId, WELCOME, { parse_mode: 'HTML' }).catch(() => {});
  await qStart(chatId);
  await bot.sendMessage(chatId, '💡 Butonul de mai jos pornește oricând o căutare nouă.', {
    reply_markup: { keyboard: [[{ text: '🔍 Caută o vacanță' }]], resize_keyboard: true, one_time_keyboard: false },
  }).catch(() => {});
});

bot.onText(/\/cauta/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  updateSubInfo(msg.chat.id, msg.from);
  await qStart(msg.chat.id);
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    '📖 <b>Cum funcționează:</b>\n\n1️⃣ /cauta → alegi destinația și răspunzi la câteva întrebări rapide (butoane)\n' +
    '2️⃣ Primești cele mai bune oferte REALE ca mesaje cu poză și preț confirmat\n' +
    '3️⃣ 📋 Detalii = album foto + descrierea hotelului · 📞 Rezervă = un consultant te sună\n\n' +
    '💬 Poți și scrie liber (RO/RU): <i>„Turcia în august, 2 adulți, buget 2000"</i> sau numele unui hotel anume.\n\n' +
    `/cauta — căutare nouă\n/start — de la început\n\n☎️ ${PHONE} · str. Ismail 86 / Shopping MallDova`,
    { parse_mode: 'HTML' }).catch(() => {});
});

bot.on('message', async (msg) => {
  // în GRUPURI botul tace complet (doar /id răspunde) — altfel ar conversa cu toată echipa și ar arde tokeni
  if (msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  if (msg.contact && msg.contact.phone_number) {
    // turistul a partajat numărul cu un tap → îl dăm agentului (care salvează lead-ul)
    pendingRemoveKb.add(chatId);
    const nm = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ');
    await handleUserText(chatId, `Numărul meu de telefon: ${msg.contact.phone_number}${nm ? ' — ' + nm : ''}`, msg.from);
    return;
  }
  if (!msg.text) {
    if (msg.photo) { updateSubInfo(chatId, msg.from); storeMessage(chatId, 'in', msg.caption || '[foto]', { photo: true }); markDirty(); }
    return;
  }
  if (msg.text.startsWith('/')) return; // comenzile au handlerele lor
  if (msg.text === '🔍 Caută o vacanță' || msg.text === '🔍 Caută un tur') {
    updateSubInfo(chatId, msg.from);
    await qStart(chatId);
    return;
  }
  if (/^✖️/.test(msg.text)) { // anulează partajarea numărului
    pendingRemoveKb.delete(chatId);
    await bot.sendMessage(chatId, 'OK 👍', { reply_markup: { remove_keyboard: true } }).catch(() => {});
    return;
  }
  // numărul tastat manual (nu prin buton) → scoatem și tastatura de contact rămasă
  if (/\+?\d[\d\s().-]{6,}\d/.test(msg.text)) pendingRemoveKb.add(chatId);
  await handleUserText(chatId, msg.text, msg.from);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id, msgId = query.message.message_id, data = query.data;
  // un singur answer per query: ramurile pot răspunde cu toast; la final dăm ack generic dacă nimeni n-a răspuns
  let answered = false;
  const ack = (opts) => { answered = true; return bot.answerCallbackQuery(query.id, opts).catch(() => {}); };
  const expiredToast = () => ack({ text: isRu(chatId) ? 'Предложение устарело — сделайте новый поиск 🙂' : 'Oferta a expirat — fă o căutare nouă 🙂', show_alert: false });
  const q = QFLOW.get(chatId);
  try {
    if (data === 'noop') return;

    // ---- fluxul ghidat (zero tokeni) ----
    if (data === 'qnew') { await qStart(chatId); return; }
    if (data.startsWith('qd_')) {
      if (!q) return qStart(chatId);
      q.dest = (DESTS[+data.slice(3)] || '').replace(/^\S+\s/, ''); // fără steag
      if (!q.dest) return;
      await qMonths(chatId); return;
    }
    if (data === 'qm_now') { // last-minute: fără lună fixă → „cât mai curând"
      if (!q || !q.dest) return qStart(chatId);
      q.month = null; q.part = null;
      await qNights(chatId); return;
    }
    if (data.startsWith('qm_')) {
      if (!q || !q.dest) return qStart(chatId);
      const [, y, m] = data.split('_');
      q.year = +y; q.month = +m;
      await qParts(chatId); return;
    }
    if (data.startsWith('qp_')) { if (!q) return qStart(chatId); q.part = data.slice(3); q.day = null; q.dayEnd = null; q.dateMode = null; await qNights(chatId); return; }
    if (data === 'qdx') { if (!q || q.month == null) return; q.dateMode = 'day'; q.part = null; await qDays(chatId, '📍 <b>Alege ziua plecării:</b>'); return; }
    if (data === 'qdr') { if (!q || q.month == null) return; q.dateMode = 'range-start'; q.part = null; await qDays(chatId, '↔️ <b>De la ce zi?</b>'); return; }
    if (data.startsWith('qz_')) {
      if (!q || q.month == null) return;
      const zd = +data.slice(3);
      if (q.dateMode === 'day') { q.day = zd; await qStrict(chatId); return; }
      if (q.dateMode === 'range-start') { q.day = zd; q.dateMode = 'range-end'; await qDays(chatId, `↔️ <b>Până la ce zi?</b> (plecare ${zd}–…)`, zd + 1); return; }
      if (q.dateMode === 'range-end') { q.dayEnd = zd; await qNights(chatId); return; }
      return;
    }
    if (data.startsWith('qfx_')) { if (!q) return; q.strict = data.slice(4) === '1'; await qNights(chatId); return; }
    if (data.startsWith('qf_')) { if (!q) { if (!FINISHED.has(chatId)) await qStart(chatId); return; } q.food = data.slice(3); await qExtras(chatId); return; }
    if (data === 'qe_done') { if (!q) { if (!FINISHED.has(chatId)) await qStart(chatId); return; } await qBudget(chatId); return; }
    if (data.startsWith('qe_')) {
      if (!q) return;
      const k = data.slice(3);
      const ix = q.extras.indexOf(k);
      if (ix >= 0) q.extras.splice(ix, 1); else q.extras.push(k);
      await qExtras(chatId); return;
    }
    if (data.startsWith('qn_')) { if (!q) return qStart(chatId); q.nights = +data.slice(3); await qAdults(chatId); return; }
    if (data.startsWith('qa_')) { if (!q) return qStart(chatId); q.adults = +data.slice(3); await qKids(chatId); return; }
    if (data.startsWith('qk_')) {
      if (!q) return qStart(chatId);
      q.kidsLeft = +data.slice(3); q.kids = [];
      if (q.kidsLeft === 0) await qFood(chatId); else await qKidAge(chatId);
      return;
    }
    if (data.startsWith('qg_')) {
      if (!q) { if (!FINISHED.has(chatId)) await qStart(chatId); return; }
      if (q.kidsLeft <= 0) return; // dublu-tap pe vârstă: nu corupe lista de copii
      q.kids.push(+data.slice(3)); q.kidsLeft--;
      if (q.kidsLeft > 0) await qKidAge(chatId); else await qFood(chatId);
      return;
    }
    if (data.startsWith('qb_')) {
      if (!q) { if (!FINISHED.has(chatId)) await qStart(chatId); return; } // tap întârziat după finish ≠ wizard nou
      if (busyChats.has(chatId)) { // nu pierde cererea compusă dacă o tură e încă în lucru
        bot.sendMessage(chatId, '⏳ Termin căutarea anterioară — apasă bugetul din nou în câteva secunde.').catch(() => {});
        return;
      }
      const opt = BUDGET_OPTS[+data.slice(3)];
      if (!opt) return;
      q.budget = opt;
      await qFinish(chatId, query.from);
      return;
    }
    if (data === 'qhotel') {
      if (q && q.msgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.msgId }).catch(() => {});
      QFLOW.delete(chatId);
      await bot.sendMessage(chatId,
        '🏨 <b>Scrie numele hotelului</b> + perioada și persoanele, iar eu îl caut exact.\n<i>Ex: „Rixos Premium Belek, august, 2 adulți" sau „Albatros Palace Hurghada în octombrie"</i>',
        { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    if (data === 'qfree') {
      if (q && q.msgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.msgId }).catch(() => {});
      QFLOW.delete(chatId);
      await bot.sendMessage(chatId,
        '✍️ Scrie-mi liber, ca unui consultant: destinația, perioada, câte persoane și bugetul.\n<i>Ex: „Unde plec cu 1500€ în septembrie, 2 adulți?"</i>',
        { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    if (data === 'hot') {
      if (q && q.msgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.msgId }).catch(() => {});
      QFLOW.delete(chatId);
      await handleUserText(chatId, isRu(chatId) ? 'Какие горящие туры есть сейчас? Посоветуй что-то хорошее.' : 'Ce oferte fierbinți ai acum? Recomandă-mi ceva bun.', query.from, { auto: true });
      return;
    }

    // ---- restul ofertelor (lotul 2) — legat de MESAJUL lui (nu se amestecă între căutări) ----
    if (data === 'more') {
      const m = MORE.get(`${chatId}:${msgId}`);
      if (!m) { await expiredToast(); return; }
      MORE.delete(`${chatId}:${msgId}`);
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      await sendCardBatch(chatId, m.rest, m.total - m.rest.length, m.total, m.query, m.lang);
      return;
    }

    // ---- carduri individuale (anti dublu-tap + toast pe stare expirată după redeploy) ----
    if (data === 'cdet') {
      const st = OFFERS.get(`${chatId}:${msgId}`);
      if (!st) { await expiredToast(); return; }
      const fk = `${chatId}:${msgId}:det`;
      if (inFlight.has(fk)) { await ack({ text: '⏳ Se încarcă…' }); return; }
      inFlight.add(fk);
      try { await showDetails(chatId, st); } finally { setTimeout(() => inFlight.delete(fk), 5000); }
      return;
    }
    if (data === 'cbook') {
      const st = OFFERS.get(`${chatId}:${msgId}`);
      if (!st) { await expiredToast(); return; }
      const fk = `${chatId}:${msgId}:book`;
      if (inFlight.has(fk)) { await ack({ text: '⏳ …' }); return; }
      inFlight.add(fk);
      try { await startBooking(chatId, st.offer, st.lang); } finally { setTimeout(() => inFlight.delete(fk), 5000); }
      return;
    }
    if (data.startsWith('book_')) {
      const hid = +data.slice(5);
      let found = null;
      for (const [k, v] of OFFERS) {
        if (k.startsWith(chatId + ':') && v.offer.hotelId === hid) found = v;
      }
      if (!found) { await expiredToast(); return; }
      await startBooking(chatId, found.offer, found.lang);
      return;
    }
    if (data.startsWith('chip_')) {
      const chips = CHIPS.get(`${chatId}:${msgId}`);
      const c = chips && chips[+data.slice(5)];
      if (!c) { await expiredToast(); return; }
      await handleUserText(chatId, c, query.from, { auto: true });
      return;
    }
  } catch (err) {
    console.error('[Bot Error]', err.message);
  } finally {
    if (!answered) bot.answerCallbackQuery(query.id).catch(() => {});
  }
});

// ================================================================
//  API ENDPOINTS (Admin Panel) — NESCHIMBATE
// ================================================================
function authCheck(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/stats', authCheck, (req, res) => {
  const subs = Object.values(db.subscribers);
  const now = Date.now();
  const active7d = subs.filter(s => (now - new Date(s.lastActive)) < 7*24*60*60*1000).length;
  const active30d = subs.filter(s => (now - new Date(s.lastActive)) < 30*24*60*60*1000).length;
  const searches30d = subs.reduce((sum, s) => sum + s.searches.filter(sr => (now - new Date(sr.timestamp)) < 30*24*60*60*1000).length, 0);

  const cc = {};
  subs.forEach(s => s.searches.forEach(sr => cc[sr.country] = (cc[sr.country]||0)+1));
  const topCountries = Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,10);

  const tc = {};
  subs.forEach(s => s.tags.forEach(t => { if(!t.startsWith('dest:')) tc[t]=(tc[t]||0)+1; }));

  const newPerDay = {};
  subs.forEach(s => { const d = s.joinedAt.split('T')[0]; newPerDay[d] = (newPerDay[d]||0)+1; });

  res.json({
    total: subs.length, active7d, active30d, totalSearches: db.meta.totalSearches||0,
    searches30d, topCountries, tags: tc, newPerDay,
    blocked: subs.filter(s=>s.blocked).length,
    withMessages: subs.filter(s=>s.messages.some(m=>m.direction==='in')).length,
  });
});

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

  if (sort === 'searches') subs.sort((a,b) => b.totalSearches - a.totalSearches);
  else if (sort === 'name') subs.sort((a,b) => a.firstName.localeCompare(b.firstName));
  else subs.sort((a,b) => new Date(b.lastActive) - new Date(a.lastActive));

  res.json(subs.map(s => ({
    chatId: s.chatId, firstName: s.firstName, lastName: s.lastName, username: s.username,
    joinedAt: s.joinedAt, lastActive: s.lastActive,
    totalSearches: s.totalSearches, tags: s.tags, blocked: s.blocked,
    preferences: s.preferences,
    lastSearch: s.searches[s.searches.length-1] || null,
    unreadMessages: s.messages.filter(m => m.direction === 'in').length,
  })));
});

app.get('/api/subscriber/:chatId', authCheck, (req, res) => {
  const sub = db.subscribers[req.params.chatId];
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub);
});

app.get('/api/messages/:chatId', authCheck, (req, res) => {
  const sub = db.subscribers[req.params.chatId];
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub.messages);
});

app.post('/api/send', authCheck, async (req, res) => {
  const { chatId, text, parseMode, buttons, photoUrl } = req.body;
  if (!chatId || (!text && !photoUrl)) return res.status(400).json({ error: 'chatId and text/photoUrl required' });

  try {
    const opts = { parse_mode: parseMode || 'HTML', disable_web_page_preview: true };
    if (buttons && buttons.length > 0) opts.reply_markup = { inline_keyboard: buttons };

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
    if (e.message.includes('blocked') || e.message.includes('deactivated')) {
      const sub = getSub(chatId);
      sub.blocked = true;
      saveDB();
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/broadcast', authCheck, async (req, res) => {
  const { text, parseMode, buttons, photoUrl, tag, countryFilter } = req.body;
  if (!text && !photoUrl) return res.status(400).json({ error: 'text or photoUrl required' });

  let targets = Object.values(db.subscribers).filter(s => !s.blocked);
  if (tag) targets = targets.filter(s => s.tags.includes(tag));
  if (countryFilter) targets = targets.filter(s => s.preferences.topCountries.some(c => c.toLowerCase().includes(countryFilter.toLowerCase())));

  res.json({ ok: true, targets: targets.length, status: 'sending' });

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
  if (ADMIN_CHAT_ID) {
    bot.sendMessage(ADMIN_CHAT_ID, `✅ Broadcast: ${sent} trimise, ${failed} erori`).catch(()=>{});
  }
});

app.post('/api/backup', authCheck, async (req, res) => {
  saveDB();
  await backupToGitHub();
  res.json({ ok: true });
});

app.get('/api/export', authCheck, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=zebratur_subscribers.json');
  res.send(JSON.stringify(db, null, 2));
});

let ADMIN_HTML = '';
try { ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'); } catch(e) {
  console.log('⚠️ admin.html nu a fost găsit, se folosește versiunea inline');
}
function serveAdmin(req, res) {
  if (!ADMIN_HTML) { try { ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'); } catch(e) {} }
  if (ADMIN_HTML) { res.setHeader('Content-Type', 'text/html'); res.send(ADMIN_HTML); }
  else { res.setHeader('Content-Type', 'text/html'); res.send('<!DOCTYPE html><html><body><h1>Admin panel HTML missing</h1></body></html>'); }
}
app.get('/', serveAdmin);
app.get('/admin', serveAdmin);
app.get('/health', (req, res) => res.json({ ok: true, service: 'zebratur-bot-v3', subs: Object.keys(db.subscribers).length }));

// ================================================================
//  STARTUP
// ================================================================
(async () => {
  console.log('=== ZebraTur Bot v3 (Zebra AI) Startup ===');
  console.log(`PostgreSQL: ${DATABASE_URL ? '✅ configurat' : '❌ NU e configurat!'}`);
  console.log(`Zebra AI API: ${process.env.ZEBRA_CHAT_API || '(default Railway)'} ${process.env.INTERNAL_KEY ? '· cheie internă ✅' : '· ⚠️ fără INTERNAL_KEY (rate-limit partajat!)'}`);
  console.log(`GitHub Backup: ${GITHUB_TOKEN && GITHUB_REPO ? '✅ ' + GITHUB_REPO : '⚠️ opțional, nu e setat'}`);

  await initPostgres();
  await loadDB();
  await migrateFromGitHub();

  setInterval(() => { saveDB(); }, 2 * 60 * 1000);
  setInterval(() => { backupToGitHub(); }, 10 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`🌐 Admin panel: http://localhost:${PORT}`);
    console.log(`📊 DB: ${Object.keys(db.subscribers).length} abonați | ${db.meta.totalSearches||0} căutări`);
    console.log('🤖 ZebraTur Bot v3 — Zebra AI + CRM — ready!');
  });
})();

process.on('SIGINT', async () => { await saveDB(); bot.stopPolling(); process.exit(0); });
process.on('SIGTERM', async () => { await saveDB(); await backupToGitHub(); bot.stopPolling(); process.exit(0); });

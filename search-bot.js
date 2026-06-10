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
  if (from) { sub.firstName = from.first_name || ''; sub.lastName = from.last_name || ''; sub.username = from.username || ''; }
  sub.lastActive = new Date().toISOString();
}

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
  sub.totalSearches++;
  db.meta.totalSearches++;
  updatePreferences(sub);
  updateTags(sub);
  saveDB();
  backupToGitHub().catch(() => {});
  if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
    const name = sub.firstName + (sub.lastName ? ' ' + sub.lastName : '');
    bot.sendMessage(ADMIN_CHAT_ID,
      `🔔 <b>Căutare nouă (AI)</b>\n${name}${sub.username ? ' @' + sub.username : ''}\n🌍 ${q.destination} | ${q.nights || 7}n | ${q.adults || 2}ad${(q.childrenAges||[]).length ? ' +' + q.childrenAges.length + ' copii' : ''}`,
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
//  ZEBRA AI — strat de conversație Telegram (v3)
// ================================================================
const DESTS = [
  '🇹🇷 Turcia', '🇬🇷 Grecia', '🇪🇬 Egipt', '🇧🇬 Bulgaria', '🇲🇪 Muntenegru',
  '🇪🇸 Spania', '🇹🇳 Tunisia', '🇦🇱 Albania', '🇨🇾 Cipru',
];

const agentSessions = new Map();   // chatId -> sessionId zebra-chat
const busyChats = new Set();       // chat-uri cu o tură în lucru
const CARDS = new Map();           // `${chatId}:${msgId}` -> { offers, lang, idx, query }
const CHIPS = new Map();           // `${chatId}:${msgId}` -> [chips]
const lastCardsByChat = new Map(); // chatId -> ultima stare carusel (pt. book_ de pe alte mesaje)
const pendingRemoveKb = new Set(); // chat-uri cărora le scoatem reply-keyboard-ul la următorul mesaj

function capMap(m, max) { if (m.size > max) m.delete(m.keys().next().value); }

// i18n minimal pentru etichetele cardurilor
const TL = {
  ro: { nights: 'nopți', det: '📋 Detalii', book: '📞 Rezervă', from: 'de la', conf: '✓ confirmat',
        adults: 'ad.', kids: 'copii', pick: '🏆 Alegerea Zebrei', rev: 'recenzii',
        noFly: '🏨 Doar cazare (fără zbor)', bus: '🚌 Transport cu autocar',
        bookTpl: (n, p, d) => `Vreau să rezerv ${n} — ${p}€, plecare ${d}. Cum procedăm?`,
        share: 'Poți trimite numărul de telefon cu un singur tap 👇 (sau scrie-l în chat)',
        shareBtn: '📞 Trimite numărul meu', cancel: 'Anulează',
        months: ['ian','feb','mar','apr','mai','iun','iul','aug','sep','oct','noi','dec'] },
  ru: { nights: 'ноч.', det: '📋 Детали', book: '📞 Бронировать', from: 'от', conf: '✓ цена ок',
        adults: 'взр.', kids: 'дет.', pick: '🏆 Выбор Зебры', rev: 'отзывов',
        noFly: '🏨 Только отель (без перелёта)', bus: '🚌 Автобусный тур',
        bookTpl: (n, p, d) => `Хочу забронировать ${n} — ${p}€, вылет ${d}. Как оформить?`,
        share: 'Можно отправить номер одним нажатием 👇 (или напишите его в чат)',
        shareBtn: '📞 Отправить мой номер', cancel: 'Отмена',
        months: ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'] },
  en: { nights: 'nights', det: '📋 Details', book: '📞 Book', from: 'from', conf: '✓ confirmed',
        adults: 'ad.', kids: 'kids', pick: '🏆 Zebra’s pick', rev: 'reviews',
        noFly: '🏨 Hotel only (no flight)', bus: '🚌 Bus transfer',
        bookTpl: (n, p, d) => `I want to book ${n} — ${p}€, departure ${d}. How do we proceed?`,
        share: 'Share your phone number with one tap 👇 (or type it)',
        shareBtn: '📞 Share my number', cancel: 'Cancel',
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
  if (o.rank === 1) lines.push(`${L.pick}`);
  lines.push(`<b>${esc(o.name)}</b>`);
  const stars = o.stars ? '★'.repeat(Math.min(o.stars, 5)) : '';
  lines.push(`${stars}${stars ? ' · ' : ''}📍 ${esc([o.city, o.country].filter(Boolean).join(', '))}`);
  if (o.rating) lines.push(`⭐ ${o.rating}/10${revCount(o) ? ` · ${revCount(o)} ${L.rev}` : ''}`);
  lines.push(`💶 <b>${fmtP(o.price)} €</b> ${o.confirmed ? L.conf : L.from} · ${esc(o.board || '')}`);
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

function offerKb(idx, total, L) {
  return { inline_keyboard: [
    [{ text: '◀️', callback_data: 'cprev' }, { text: `${idx + 1}/${total}`, callback_data: 'noop' }, { text: '▶️', callback_data: 'cnext' }],
    [{ text: L.det, callback_data: 'cdet' }, { text: L.book, callback_data: 'cbook' }],
  ] };
}

async function sendCarousel(chatId, payload) {
  const lang = lang3(payload.lang);
  const L = TL[lang];
  const offers = payload.offers || [];
  if (!offers.length) return;
  const query = payload.query || {};
  const o = offers[0];
  const caption = offerCaption(o, 0, offers.length, query, L);
  const kb = offerKb(0, offers.length, L);
  let sent = null;
  try {
    sent = await bot.sendPhoto(chatId, o.photoLarge || o.photo, { caption, parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    // poză indisponibilă → card text
    sent = await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: kb });
  }
  const st = { offers, lang, idx: 0, query };
  CARDS.set(`${chatId}:${sent.message_id}`, st); capMap(CARDS, 400);
  lastCardsByChat.set(chatId, st); capMap(lastCardsByChat, 2000);
  storeMessage(chatId, 'out', `[${offers.length} oferte: ${query.destination || ''}]`, { carousel: true });
  recordSearch(chatId, { ...query });
}

async function navCarousel(chatId, msgId, delta) {
  const st = CARDS.get(`${chatId}:${msgId}`);
  if (!st) return false;
  const total = st.offers.length;
  st.idx = Math.max(0, Math.min(total - 1, st.idx + delta));
  const o = st.offers[st.idx];
  const L = TL[st.lang];
  const caption = offerCaption(o, st.idx, total, st.query, L);
  try {
    await bot.editMessageMedia(
      { type: 'photo', media: o.photoLarge || o.photo, caption, parse_mode: 'HTML' },
      { chat_id: chatId, message_id: msgId, reply_markup: offerKb(st.idx, total, L) }
    );
  } catch (e) {
    if (!/not modified/i.test(e.message)) console.error('[nav]', e.message);
  }
  return true;
}

const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

async function showDetails(chatId, st) {
  const o = st.offers[st.idx];
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
    reply_markup: { inline_keyboard: [[{ text: `${L.book} · ${fmtP(o.price)} €`, callback_data: 'book_' + o.hotelId }]] },
  });
}

async function startBooking(chatId, o, lang) {
  const L = TL[lang3(lang)];
  // tastatura cu partajare de contact — un singur tap pt. numărul de telefon
  await bot.sendMessage(chatId, L.share, {
    reply_markup: { keyboard: [[{ text: L.shareBtn, request_contact: true }], [{ text: '✖️ ' + L.cancel }]], resize_keyboard: true, one_time_keyboard: true },
  }).catch(() => {});
  await handleUserText(chatId, L.bookTpl(o.name, fmtP(o.price), fmtD(o.departDate, L)), null);
}

// ---------- tura de conversație cu agentul ----------
async function handleUserText(chatId, text, from) {
  if (busyChats.has(chatId)) {
    bot.sendMessage(chatId, '⏳ O clipă — încă lucrez la cererea anterioară…').catch(() => {});
    return;
  }
  busyChats.add(chatId);
  updateSubInfo(chatId, from);
  storeMessage(chatId, 'in', text);
  saveDB();
  if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
    const sub = getSub(chatId);
    const name = sub.firstName + (sub.lastName ? ' ' + sub.lastName : '');
    bot.sendMessage(ADMIN_CHAT_ID, `💬 <b>${esc(name)}</b>${sub.username ? ' @' + sub.username : ''}:\n${esc(text)}`, { parse_mode: 'HTML' }).catch(() => {});
  }

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
      gotAnything = true;
      const m = await bot.sendMessage(chatId, mdHtml(t), { parse_mode: 'HTML' }).catch(() => null);
      if (m) lastTextMsgId = m.message_id;
      storeMessage(chatId, 'out', t);
    },
    onOffers: async (payload) => {
      gotAnything = true;
      await sendCarousel(chatId, payload);
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
    if (sessionId) { agentSessions.set(chatId, sessionId); capMap(agentSessions, 5000); }
  } catch (e) {
    console.error('[agent]', e.message);
    if (!gotAnything) {
      bot.sendMessage(chatId, `😕 A apărut o problemă tehnică. Mai încearcă o dată sau sună-ne direct: ${PHONE}`).catch(() => {});
    }
  } finally {
    busyChats.delete(chatId);
    saveDB();
    if (statusId) bot.deleteMessage(chatId, statusId).catch(() => {});
  }
}

// ================================================================
//  COMENZI & HANDLERE
// ================================================================
function destKeyboard() {
  const kb = [];
  for (let i = 0; i < DESTS.length; i += 3) kb.push(DESTS.slice(i, i + 3).map((d, j) => ({ text: d, callback_data: 'dest_' + (i + j) })));
  kb.push([{ text: '🔥 Oferte fierbinți', callback_data: 'hot' }]);
  return { inline_keyboard: kb };
}

const WELCOME = '👋 <b>Bun venit la Zebra Tur!</b>\n\n' +
  'Sunt <b>Zebra AI</b> — consultantul tău de vacanțe. Scrie-mi liber unde, când și cu ce buget vrei să pleci ' +
  '(ex: <i>„Turcia în august, 2 adulți și un copil de 6 ani, buget 2000€"</i>) sau alege o destinație:\n\n' +
  '<i>Можно писать и на русском.</i> 🦓';

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  updateSubInfo(chatId, msg.from); saveDB(); backupToGitHub().catch(() => {});
  await bot.sendMessage(chatId, WELCOME, { parse_mode: 'HTML', reply_markup: destKeyboard() }).catch(() => {});
  await bot.sendMessage(chatId, '💡 Scrie oricând în chat sau folosește butonul de mai jos.', {
    reply_markup: { keyboard: [[{ text: '🔍 Caută o vacanță' }]], resize_keyboard: true, one_time_keyboard: false },
  }).catch(() => {});
});

bot.onText(/\/cauta/, async (msg) => {
  updateSubInfo(msg.chat.id, msg.from);
  await bot.sendMessage(msg.chat.id, '🌍 <b>Unde zburăm în vacanță?</b>\nAlege sau scrie liber:', { parse_mode: 'HTML', reply_markup: destKeyboard() }).catch(() => {});
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    '📖 <b>Cum funcționează:</b>\n\n💬 Scrie liber: destinația, perioada, persoanele, bugetul — îți găsesc cele mai bune oferte reale cu zbor din Chișinău.\n' +
    '🃏 Răsfoiește cardurile cu ◀️ ▶️, vezi 📋 Detalii cu poze, apasă 📞 Rezervă și un consultant te sună.\n\n' +
    `/cauta — destinații rapide\n/start — de la început\n\n☎️ ${PHONE} · str. Ismail 86 / Shopping MallDova`,
    { parse_mode: 'HTML' }).catch(() => {});
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.contact && msg.contact.phone_number) {
    // turistul a partajat numărul cu un tap → îl dăm agentului (care salvează lead-ul)
    pendingRemoveKb.add(chatId);
    const nm = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ');
    await handleUserText(chatId, `Numărul meu de telefon: ${msg.contact.phone_number}${nm ? ' — ' + nm : ''}`, msg.from);
    return;
  }
  if (!msg.text) {
    if (msg.photo) { updateSubInfo(chatId, msg.from); storeMessage(chatId, 'in', msg.caption || '[foto]', { photo: true }); saveDB(); }
    return;
  }
  if (msg.text.startsWith('/')) return; // comenzile au handlerele lor
  if (msg.text === '🔍 Caută o vacanță' || msg.text === '🔍 Caută un tur') {
    updateSubInfo(chatId, msg.from);
    await bot.sendMessage(chatId, '🌍 <b>Unde zburăm în vacanță?</b>\nAlege sau scrie liber:', { parse_mode: 'HTML', reply_markup: destKeyboard() }).catch(() => {});
    return;
  }
  if (/^✖️/.test(msg.text)) { // anulează partajarea numărului
    pendingRemoveKb.delete(chatId);
    await bot.sendMessage(chatId, 'OK 👍', { reply_markup: { remove_keyboard: true } }).catch(() => {});
    return;
  }
  await handleUserText(chatId, msg.text, msg.from);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id, msgId = query.message.message_id, data = query.data;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  try {
    if (data === 'noop') return;
    if (data.startsWith('dest_')) {
      const d = DESTS[+data.slice(5)];
      if (d) await handleUserText(chatId, d.replace(/^\S+\s/, ''), query.from); // fără emoji-ul de steag
      return;
    }
    if (data === 'hot') { await handleUserText(chatId, 'Ce oferte fierbinți ai acum? Recomandă-mi ceva bun.', query.from); return; }
    if (data === 'cprev' || data === 'cnext') {
      const ok = await navCarousel(chatId, msgId, data === 'cnext' ? 1 : -1);
      if (!ok) bot.answerCallbackQuery(query.id, { text: 'Caruselul a expirat — fă o căutare nouă 🙂' }).catch(() => {});
      return;
    }
    if (data === 'cdet') {
      const st = CARDS.get(`${chatId}:${msgId}`);
      if (st) await showDetails(chatId, st);
      return;
    }
    if (data === 'cbook') {
      const st = CARDS.get(`${chatId}:${msgId}`);
      if (st) await startBooking(chatId, st.offers[st.idx], st.lang);
      return;
    }
    if (data.startsWith('book_')) {
      const hid = +data.slice(5);
      const st = lastCardsByChat.get(chatId);
      const o = st && st.offers.find((x) => x.hotelId === hid);
      if (o) await startBooking(chatId, o, st.lang);
      return;
    }
    if (data.startsWith('chip_')) {
      const chips = CHIPS.get(`${chatId}:${msgId}`);
      const c = chips && chips[+data.slice(5)];
      if (c) await handleUserText(chatId, c, query.from);
      return;
    }
  } catch (err) {
    console.error('[Bot Error]', err.message);
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

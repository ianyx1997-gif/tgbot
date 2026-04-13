/* ============================================================
   ZEBRATUR – TELEGRAM SEARCH BOT + CRM
   Generează link de căutare turskanner, interactiv cu butoane
   + Memorie abonați, preferințe automate, panou admin, broadcast

   Comenzi utilizator:
   /start    — Mesaj de bun venit + buton CAUTĂ
   /cauta    — Începe căutare nouă (flow interactiv)
   /help     — Instrucțiuni

   Comenzi admin:
   /admin    — Panou de comandă
   /users    — Listă abonați cu filtre
   /stats    — Statistici
   /broadcast — Trimite mesaj pe categorii
   /export   — Exportă baza de date
   /recommend — Trimite recomandări personalizate

   Dependențe:  npm install node-telegram-bot-api
   Start:       TELEGRAM_BOT_TOKEN=xxx ADMIN_CHAT_ID=xxx node search-bot.js

   Opțional:    GITHUB_TOKEN + GITHUB_REPO pentru backup persistent
   ============================================================ */

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const https = require('https');

// ===== CONFIG =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://zebratur.md/offers';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID) : null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // format: "user/repo"
const DB_FILE = process.env.DB_FILE || './subscribers.json';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN nu e setat!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('✅ ZebraTur Search Bot pornit!');

// ===== DATA =====
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
  { id: 1831, name: 'Chișinău', flag: '🇲🇩', popular: true },
  { id: 1373, name: 'București', flag: '🇷🇴', popular: true },
  { id: 4091, name: 'Iași', flag: '🇷🇴', popular: false },
  { id: 4083, name: 'Cluj-Napoca', flag: '🇷🇴', popular: false },
  { id: 3396, name: 'Timișoara', flag: '🇷🇴', popular: false },
  { id: 2858, name: 'Bacău', flag: '🇷🇴', popular: false },
  { id: 1727, name: 'Suceava', flag: '🇷🇴', popular: false },
];

const DURATIONS = [
  { nights: 5, label: '5 nopți' },
  { nights: 7, label: '7 nopți' },
  { nights: 10, label: '10 nopți' },
  { nights: 12, label: '12 nopți' },
  { nights: 14, label: '14 nopți' },
];

const FOOD_OPTIONS = [
  { code: 'ob',  label: 'Orice masă', icon: '🍽️' },
  { code: 'bb',  label: 'Mic dejun+', icon: '🥐' },
  { code: 'hb',  label: 'Demipensiune+', icon: '🍲' },
  { code: 'fb',  label: 'Pensiune completă+', icon: '🍱' },
  { code: 'ai',  label: 'All Inclusive+', icon: '🏖️' },
  { code: 'uai', label: 'Ultra AI', icon: '👑' },
];

const FOOD_HIERARCHY = ['ob', 'bb', 'hb', 'fb', 'ai', 'uai'];

const STARS_OPTIONS = [
  { stars: '',    label: 'Orice stele', icon: '⭐' },
  { stars: '3',   label: '3★+', icon: '⭐⭐⭐' },
  { stars: '4',   label: '4★+', icon: '⭐⭐⭐⭐' },
  { stars: '5',   label: '5★', icon: '⭐⭐⭐⭐⭐' },
];

const ADULTS_OPTIONS = [1, 2, 3, 4];

// ================================================================
//  SUBSCRIBER DATABASE (CRM)
// ================================================================

let db = { subscribers: {}, meta: { createdAt: new Date().toISOString(), totalSearches: 0 } };

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(raw);
      console.log(`📂 DB încărcată: ${Object.keys(db.subscribers).length} abonați`);
    }
  } catch (e) {
    console.error('⚠️ Eroare la încărcarea DB:', e.message);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('⚠️ Eroare la salvarea DB:', e.message);
  }
}

// GitHub backup
async function backupToGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const content = Buffer.from(JSON.stringify(db, null, 2)).toString('base64');
  const path = 'subscribers.json';
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;

  try {
    // Get current file SHA (if exists)
    let sha = '';
    const getRes = await httpRequest('GET', apiUrl, { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'ZebraTurBot' });
    if (getRes && getRes.sha) sha = getRes.sha;

    // Put file
    const body = { message: `backup ${new Date().toISOString()}`, content, ...(sha && { sha }) };
    await httpRequest('PUT', apiUrl, { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'ZebraTurBot', 'Content-Type': 'application/json' }, JSON.stringify(body));
    console.log('☁️ Backup GitHub OK');
  } catch (e) {
    console.error('⚠️ GitHub backup eroare:', e.message);
  }
}

function httpRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method, headers: { ...headers } };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Auto-backup every 30 minutes
let backupTimer = null;
function startAutoBackup() {
  backupTimer = setInterval(() => {
    saveDB();
    backupToGitHub();
  }, 30 * 60 * 1000);
}

// Load from GitHub on start (if local DB missing)
async function loadFromGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (fs.existsSync(DB_FILE)) return; // local DB exists, use it
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/subscribers.json`;
    const res = await httpRequest('GET', apiUrl, { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'ZebraTurBot' });
    if (res && res.content) {
      const decoded = Buffer.from(res.content, 'base64').toString('utf8');
      db = JSON.parse(decoded);
      saveDB(); // Save locally
      console.log(`☁️ DB restaurată din GitHub: ${Object.keys(db.subscribers).length} abonați`);
    }
  } catch (e) {
    console.error('⚠️ GitHub restore eroare:', e.message);
  }
}

// ===== SUBSCRIBER MANAGEMENT =====

function getSubscriber(chatId) {
  const id = String(chatId);
  if (!db.subscribers[id]) {
    db.subscribers[id] = {
      chatId: chatId,
      firstName: '',
      lastName: '',
      username: '',
      joinedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      searches: [],
      preferences: {
        topCountries: [],
        typicalAdults: 2,
        hasChildren: false,
        avgChildAges: [],
        preferredFood: null,
        preferredStars: null,
        preferredNights: null,
      },
      tags: [],
      blocked: false,
      totalSearches: 0,
    };
  }
  return db.subscribers[id];
}

function updateSubscriberInfo(chatId, msg) {
  const sub = getSubscriber(chatId);
  if (msg.from) {
    sub.firstName = msg.from.first_name || '';
    sub.lastName = msg.from.last_name || '';
    sub.username = msg.from.username || '';
  }
  sub.lastActive = new Date().toISOString();
}

function recordSearch(chatId, session) {
  const sub = getSubscriber(chatId);
  const search = {
    country: session.country.name,
    countryId: session.country.id,
    dateFrom: session.dateFrom,
    nights: session.nights,
    adults: session.adults,
    children: [...session.children],
    food: session.food,
    stars: session.stars,
    timestamp: new Date().toISOString(),
  };
  sub.searches.push(search);
  sub.totalSearches++;
  db.meta.totalSearches++;

  // Update preferences automatically
  updatePreferences(sub);

  // Update tags
  updateTags(sub);

  // Save
  saveDB();

  // Notify admin of new search
  if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
    const name = sub.firstName + (sub.lastName ? ' ' + sub.lastName : '');
    const uname = sub.username ? ` (@${sub.username})` : '';
    bot.sendMessage(ADMIN_CHAT_ID,
      `🔔 <b>Căutare nouă</b>\n${name}${uname}\n${session.country.flag} ${session.country.name} | ${session.nights}n | ${session.adults}ad${session.children.length ? ' +' + session.children.length + ' copii' : ''} | ${session.food} | ${session.stars || 'any'}★`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
}

function updatePreferences(sub) {
  const searches = sub.searches;
  if (searches.length === 0) return;

  // Top countries (by frequency)
  const countryCount = {};
  searches.forEach(s => { countryCount[s.country] = (countryCount[s.country] || 0) + 1; });
  sub.preferences.topCountries = Object.entries(countryCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(e => e[0]);

  // Typical adults
  const adultsArr = searches.map(s => s.adults);
  sub.preferences.typicalAdults = mode(adultsArr);

  // Has children
  sub.preferences.hasChildren = searches.some(s => s.children.length > 0);

  // Average child ages (from last search with children)
  const lastWithKids = [...searches].reverse().find(s => s.children.length > 0);
  sub.preferences.avgChildAges = lastWithKids ? lastWithKids.children : [];

  // Preferred food (most common non-'ob')
  const foodArr = searches.map(s => s.food).filter(f => f !== 'ob');
  sub.preferences.preferredFood = foodArr.length > 0 ? mode(foodArr) : null;

  // Preferred stars
  const starsArr = searches.map(s => s.stars).filter(s => s);
  sub.preferences.preferredStars = starsArr.length > 0 ? mode(starsArr) : null;

  // Preferred nights
  const nightsArr = searches.map(s => s.nights);
  sub.preferences.preferredNights = mode(nightsArr);
}

function updateTags(sub) {
  const tags = new Set();
  const prefs = sub.preferences;

  if (prefs.hasChildren) tags.add('family');
  if (!prefs.hasChildren && prefs.typicalAdults === 2) tags.add('couple');
  if (prefs.typicalAdults === 1 && !prefs.hasChildren) tags.add('solo');

  if (prefs.preferredFood === 'ai' || prefs.preferredFood === 'uai') tags.add('all-inclusive');
  if (prefs.preferredStars === '5') tags.add('luxury');
  if (prefs.preferredStars === '3') tags.add('budget');

  prefs.topCountries.forEach(c => tags.add(`dest:${c.toLowerCase()}`));

  if (sub.totalSearches >= 5) tags.add('active');
  if (sub.totalSearches === 1) tags.add('new');

  sub.tags = [...tags];
}

function mode(arr) {
  const freq = {};
  arr.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
}

// ===== SESSION STATE =====
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      step: null,
      country: null,
      departCity: { id: 1831, name: 'Chișinău' },
      dateFrom: null,
      dateTo: null,
      nights: 7,
      adults: 2,
      children: [],
      food: 'ob',
      stars: '',
      transport: 'air',
    });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.delete(chatId);
}

// ===== HELPERS =====
function expandFood(foodCode) {
  if (!foodCode || foodCode === 'ob') return '';
  const idx = FOOD_HIERARCHY.indexOf(foodCode);
  if (idx < 0) return foodCode;
  return FOOD_HIERARCHY.slice(idx).join(',');
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  const months = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun', 'iul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

const MONTH_NAMES = ['Ianuarie','Februarie','Martie','Aprilie','Mai','Iunie','Iulie','August','Septembrie','Octombrie','Noiembrie','Decembrie'];

function getAvailableMonths() {
  const months = [];
  const now = new Date();
  for (let m = 0; m < 8; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
    months.push({
      month: d.getMonth(),
      year: d.getFullYear(),
      label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`
    });
  }
  return months;
}

function getDaysForMonth(month, year) {
  const now = new Date();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const days = [];
  const startDay = (year === now.getFullYear() && month === now.getMonth())
    ? now.getDate() + 2
    : 1;
  for (let d = startDay; d <= daysInMonth; d++) {
    days.push({
      date: `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      label: `${d}`
    });
  }
  return days;
}

function buildPeople(adults, children) {
  let p = String(adults);
  for (const age of children) {
    p += String(age).padStart(2, '0');
  }
  return p;
}

function expandStars(stars) {
  if (!stars) return '';
  const s = parseInt(stars);
  const arr = [];
  for (let i = s; i <= 5; i++) arr.push(i);
  return arr.join(',');
}

function buildSearchUrl(session) {
  const checkIn = session.dateFrom;
  const checkTo = session.dateTo || addDays(checkIn, 14);
  const childAges = session.children.join(',');

  let url = `${SITE_URL}#!i=${session.country.id}`;
  url += `&c=${checkIn}&v=${checkTo}`;
  url += `&l=${session.nights}`;
  url += `&p=${buildPeople(session.adults, session.children)}`;
  url += `&tc=${childAges}`;
  url += `&g=1`;
  url += `&d=${session.departCity.id}`;
  url += `&o=${expandFood(session.food)}`;
  url += `&st=${expandStars(session.stars)}`;
  url += `&pf=100&pt=20000`;
  url += `&rt=0,10&th=&e=`;
  url += `&r=${session.transport}`;
  url += `&ex=1&cu=eur`;
  url += `&page=tour`;
  return url;
}

function buildSummary(session) {
  const country = session.country;
  const foodLabel = FOOD_OPTIONS.find(f => f.code === session.food)?.label || 'Orice';
  const starsLabel = session.stars ? `${session.stars}★+` : 'Orice';
  const childText = session.children.length > 0
    ? `\n👶 Copii: ${session.children.length} (${session.children.map(a => a + ' ani').join(', ')})`
    : '';

  return `${country.flag} <b>${country.name}</b>\n` +
    `✈️ Din: ${session.departCity.name}\n` +
    `📅 De la: ${fmtDate(session.dateFrom)}\n` +
    `🌙 ${session.nights} nopți\n` +
    `👥 ${session.adults} adulți${childText}\n` +
    `🍽️ ${foodLabel}\n` +
    `⭐ ${starsLabel}`;
}

// ================================================================
//  SEARCH FLOW STEPS
// ================================================================

async function stepCountry(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'country';
  const keyboard = [];
  for (let i = 0; i < COUNTRIES.length; i += 2) {
    keyboard.push(COUNTRIES.slice(i, i + 2).map(c => ({
      text: `${c.flag} ${c.name}`,
      callback_data: `country_${c.id}`
    })));
  }
  const text = '🌍 <b>Alege destinația:</b>';
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  }
}

async function stepMonth(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'month';
  const months = getAvailableMonths();
  const keyboard = [];
  for (let i = 0; i < months.length; i += 2) {
    keyboard.push(months.slice(i, i + 2).map(m => ({
      text: `📅 ${m.label}`,
      callback_data: `month_${m.month}_${m.year}`
    })));
  }
  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b>\n\n📅 <b>În ce lună vrei să pleci?</b>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepDay(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'day';
  const days = getDaysForMonth(s._selMonth, s._selYear);
  const keyboard = [];
  for (let i = 0; i < days.length; i += 7) {
    keyboard.push(days.slice(i, i + 7).map(d => ({
      text: d.label,
      callback_data: `day_${d.date}`
    })));
  }
  const monthLabel = `${MONTH_NAMES[s._selMonth]} ${s._selYear}`;
  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b>\n\n📅 <b>${monthLabel}</b> — alege ziua:`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepDuration(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'duration';
  const keyboard = [
    DURATIONS.slice(0, 3).map(d => ({ text: `🌙 ${d.label}`, callback_data: `dur_${d.nights}` })),
    DURATIONS.slice(3).map(d => ({ text: `🌙 ${d.label}`, callback_data: `dur_${d.nights}` })),
  ];
  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)}\n\n🌙 <b>Câte nopți?</b>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepAdults(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'adults';
  const keyboard = [
    ADULTS_OPTIONS.map(n => ({ text: n === s.adults ? `✅ ${n}` : `${n}`, callback_data: `adults_${n}` }))
  ];
  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n\n\n👥 <b>Câți adulți?</b>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepHasChildren(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'has_children';
  const keyboard = [
    [{ text: '👶 Da', callback_data: 'has_children_yes' },
     { text: '❌ Nu', callback_data: 'has_children_no' }]
  ];
  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n | 👥 ${s.adults}ad\n\n👶 <b>Călătoriți cu copii?</b>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepChildrenCount(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'children_count';
  const keyboard = [[1, 2, 3].map(n => ({ text: `${n}`, callback_data: `childcount_${n}` }))];
  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 👥 ${s.adults}ad\n\n👶 <b>Câți copii?</b>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepChildAge(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'child_age';
  const childNum = s.children.length + 1;
  const totalChildren = s._childrenTotal || 1;
  const keyboard = [];
  for (let i = 0; i < 18; i += 6) {
    const row = [];
    for (let age = i; age < Math.min(i + 6, 18); age++) {
      row.push({ text: `${age}`, callback_data: `childage_${age}` });
    }
    keyboard.push(row);
  }
  await bot.editMessageText(
    `👶 <b>Vârsta copilului ${childNum} din ${totalChildren}:</b>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepFood(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'food';
  const keyboard = [];
  for (let i = 0; i < FOOD_OPTIONS.length; i += 2) {
    keyboard.push(FOOD_OPTIONS.slice(i, i + 2).map(f => ({
      text: `${f.icon} ${f.label}`, callback_data: `food_${f.code}`
    })));
  }
  const childText = s.children.length > 0 ? ` + ${s.children.length} copii` : '';
  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n | 👥 ${s.adults}ad${childText}\n\n🍽️ <b>Ce masă preferi?</b>\n<i>"+" înseamnă acest tip și mai bun</i>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepStars(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'stars';
  const foodLabel = FOOD_OPTIONS.find(f => f.code === s.food)?.icon || '';
  const keyboard = [STARS_OPTIONS.map(st => ({ text: st.label, callback_data: `stars_${st.stars || 'any'}` }))];
  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n | ${foodLabel}\n\n⭐ <b>Câte stele?</b>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepConfirm(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'confirm';

  // Record search in DB
  recordSearch(chatId, s);

  const url = buildSearchUrl(s);
  const summary = buildSummary(s);
  const keyboard = [
    [{ text: '🔍 CAUTĂ TURURI!', url: url }],
    [{ text: '✏️ Modifică', callback_data: 'edit_search' },
     { text: '🔄 Căutare nouă', callback_data: 'new_search' }],
  ];
  await bot.editMessageText(
    `✅ <b>Căutarea ta:</b>\n\n${summary}\n\n👇 Apasă pentru a vedea rezultatele:`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } }
  );
}

async function stepEdit(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'edit';
  const summary = buildSummary(s);
  const url = buildSearchUrl(s);
  const keyboard = [
    [{ text: '🌍 Destinație', callback_data: 'edit_country' },
     { text: '📅 Data', callback_data: 'edit_date' }],
    [{ text: '🌙 Durata', callback_data: 'edit_duration' },
     { text: '👥 Turiști', callback_data: 'edit_adults' }],
    [{ text: '🍽️ Masă', callback_data: 'edit_food' },
     { text: '⭐ Stele', callback_data: 'edit_stars' }],
    [{ text: '🔍 CAUTĂ TURURI!', url: url }],
  ];
  await bot.editMessageText(
    `✏️ <b>Modifică căutarea:</b>\n\n${summary}\n\n<i>Alege ce vrei să schimbi:</i>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } }
  );
}

// ================================================================
//  ADMIN PANEL
// ================================================================

function isAdmin(chatId) {
  return ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID;
}

// /admin — Dashboard
bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  const totalSubs = Object.keys(db.subscribers).length;
  const activeSubs = Object.values(db.subscribers).filter(s => {
    const lastActive = new Date(s.lastActive);
    const daysAgo = (Date.now() - lastActive) / (1000 * 60 * 60 * 24);
    return daysAgo <= 7;
  }).length;
  const totalSearches = db.meta.totalSearches || 0;

  // Top countries
  const countryCount = {};
  Object.values(db.subscribers).forEach(sub => {
    sub.searches.forEach(s => { countryCount[s.country] = (countryCount[s.country] || 0) + 1; });
  });
  const topCountries = Object.entries(countryCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topCountriesText = topCountries.map(([c, n]) => `  ${c}: ${n}`).join('\n') || '  (fără date)';

  // Tags distribution
  const tagCount = {};
  Object.values(db.subscribers).forEach(sub => {
    sub.tags.forEach(t => { if (!t.startsWith('dest:')) tagCount[t] = (tagCount[t] || 0) + 1; });
  });
  const tagsText = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([t, n]) => `  ${t}: ${n}`).join('\n') || '  (fără date)';

  const keyboard = [
    [{ text: '👥 Toți abonații', callback_data: 'adm_users_all' }],
    [{ text: '👨‍👩‍👧 Familii', callback_data: 'adm_users_family' },
     { text: '💑 Cupluri', callback_data: 'adm_users_couple' }],
    [{ text: '🏖️ All-Inclusive', callback_data: 'adm_users_ai' },
     { text: '👑 Luxury', callback_data: 'adm_users_luxury' }],
    [{ text: '🆕 Noi (1 căutare)', callback_data: 'adm_users_new' },
     { text: '🔥 Activi (5+)', callback_data: 'adm_users_active' }],
    [{ text: '📢 Broadcast', callback_data: 'adm_broadcast_menu' }],
    [{ text: '💾 Backup acum', callback_data: 'adm_backup' },
     { text: '📊 Export JSON', callback_data: 'adm_export' }],
  ];

  await bot.sendMessage(msg.chat.id,
    `📊 <b>PANOU ADMIN — ZebraTur Bot</b>\n\n` +
    `👥 Total abonați: <b>${totalSubs}</b>\n` +
    `🟢 Activi (7 zile): <b>${activeSubs}</b>\n` +
    `🔍 Total căutări: <b>${totalSearches}</b>\n\n` +
    `🌍 <b>Top destinații:</b>\n${topCountriesText}\n\n` +
    `🏷️ <b>Segmente:</b>\n${tagsText}`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
});

// /stats — Quick stats
bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  const subs = Object.values(db.subscribers);
  const total = subs.length;
  const withSearches = subs.filter(s => s.totalSearches > 0).length;
  const families = subs.filter(s => s.tags.includes('family')).length;
  const couples = subs.filter(s => s.tags.includes('couple')).length;
  const solos = subs.filter(s => s.tags.includes('solo')).length;

  // Searches per day (last 30 days)
  const now = Date.now();
  const last30 = subs.reduce((sum, s) => {
    return sum + s.searches.filter(sr => (now - new Date(sr.timestamp)) < 30 * 24 * 60 * 60 * 1000).length;
  }, 0);

  await bot.sendMessage(msg.chat.id,
    `📊 <b>Statistici ZebraTur Bot</b>\n\n` +
    `👥 Total abonați: ${total}\n` +
    `🔍 Cu căutări: ${withSearches}\n` +
    `📈 Căutări (30 zile): ${last30}\n` +
    `📈 Media zilnică: ${(last30 / 30).toFixed(1)}\n\n` +
    `<b>Segmente:</b>\n` +
    `👨‍👩‍👧 Familii: ${families}\n` +
    `💑 Cupluri: ${couples}\n` +
    `🧍 Solo: ${solos}\n` +
    `🏖️ All-Inclusive: ${subs.filter(s => s.tags.includes('all-inclusive')).length}\n` +
    `👑 Luxury: ${subs.filter(s => s.tags.includes('luxury')).length}`,
    { parse_mode: 'HTML' }
  );
});

// /users — List subscribers
bot.onText(/\/users(.*)/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const filter = (match[1] || '').trim();
  let subs = Object.values(db.subscribers);

  if (filter) {
    subs = subs.filter(s => s.tags.includes(filter) || s.firstName.toLowerCase().includes(filter.toLowerCase()));
  }

  if (subs.length === 0) {
    await bot.sendMessage(msg.chat.id, '❌ Niciun abonat găsit.');
    return;
  }

  // Show max 20
  const list = subs.slice(0, 20).map((s, i) => {
    const name = s.firstName + (s.lastName ? ' ' + s.lastName : '');
    const uname = s.username ? ` @${s.username}` : '';
    const tags = s.tags.filter(t => !t.startsWith('dest:')).join(', ');
    return `${i + 1}. <b>${name}</b>${uname}\n   🔍 ${s.totalSearches} căutări | 🏷️ ${tags || '-'}`;
  }).join('\n\n');

  await bot.sendMessage(msg.chat.id,
    `👥 <b>Abonați${filter ? ` (filtru: ${filter})` : ''}</b> — ${subs.length} total\n\n${list}${subs.length > 20 ? `\n\n... și încă ${subs.length - 20}` : ''}`,
    { parse_mode: 'HTML' }
  );
});

// /broadcast <mesaj> — Broadcast to all
// /broadcast:family <mesaj> — Broadcast to tag
bot.onText(/\/broadcast(?::(\w+))?\s+(.+)/s, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;

  const tag = match[1] || null;
  const message = match[2];

  let targets = Object.values(db.subscribers).filter(s => !s.blocked);
  if (tag) {
    targets = targets.filter(s => s.tags.includes(tag));
  }

  if (targets.length === 0) {
    await bot.sendMessage(msg.chat.id, `❌ Niciun destinatar${tag ? ` cu tag-ul "${tag}"` : ''}.`);
    return;
  }

  await bot.sendMessage(msg.chat.id,
    `📢 Trimit mesaj la <b>${targets.length}</b> abonați${tag ? ` (${tag})` : ''}...\n\n<i>"${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"</i>`,
    { parse_mode: 'HTML' }
  );

  let sent = 0, failed = 0;
  for (const sub of targets) {
    try {
      await bot.sendMessage(sub.chatId, message, { parse_mode: 'HTML' });
      sent++;
      // Rate limit: 30 msg/sec max
      if (sent % 25 === 0) await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      failed++;
      if (e.message.includes('blocked') || e.message.includes('deactivated')) {
        sub.blocked = true;
      }
    }
  }

  saveDB();
  await bot.sendMessage(msg.chat.id, `✅ Broadcast finalizat!\n📨 Trimise: ${sent}\n❌ Erori: ${failed}`);
});

// /export — Export DB as JSON file
bot.onText(/\/export/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const jsonStr = JSON.stringify(db, null, 2);
  const filePath = '/tmp/zebratur_export.json';
  fs.writeFileSync(filePath, jsonStr);
  await bot.sendDocument(msg.chat.id, filePath, { caption: `📊 Export ZebraTur DB — ${Object.keys(db.subscribers).length} abonați` });
});

// /recommend — Send personalized recommendations
bot.onText(/\/recommend/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  const subs = Object.values(db.subscribers).filter(s => !s.blocked && s.totalSearches >= 1);
  if (subs.length === 0) {
    await bot.sendMessage(msg.chat.id, '❌ Niciun abonat cu căutări anterioare.');
    return;
  }

  let sent = 0;
  for (const sub of subs) {
    const prefs = sub.preferences;
    if (prefs.topCountries.length === 0) continue;

    const topCountry = prefs.topCountries[0];
    const country = COUNTRIES.find(c => c.name === topCountry);
    if (!country) continue;

    const foodLabel = FOOD_OPTIONS.find(f => f.code === prefs.preferredFood)?.label || 'Orice masă';
    const starsLabel = prefs.preferredStars ? `${prefs.preferredStars}★+` : 'Orice stele';
    const nights = prefs.preferredNights || 7;

    // Build a recommendation URL
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const dateFrom = nextMonth.toISOString().split('T')[0];
    const dateTo = addDays(dateFrom, 30);

    const recSession = {
      country, departCity: { id: 1831 }, dateFrom, dateTo,
      nights, adults: prefs.typicalAdults || 2,
      children: prefs.avgChildAges || [], food: prefs.preferredFood || 'ob',
      stars: prefs.preferredStars || '', transport: country.transport,
    };
    const url = buildSearchUrl(recSession);

    try {
      await bot.sendMessage(sub.chatId,
        `💡 <b>Recomandare pentru tine!</b>\n\n` +
        `Pe baza căutărilor tale, am găsit ceva care ți-ar plăcea:\n\n` +
        `${country.flag} <b>${topCountry}</b> | 🌙 ${nights}n | 🍽️ ${foodLabel} | ⭐ ${starsLabel}\n\n` +
        `👇 Vezi ofertele:`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔍 Vezi tururi recomandate', url }]] }
        }
      );
      sent++;
      if (sent % 25 === 0) await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      if (e.message.includes('blocked') || e.message.includes('deactivated')) sub.blocked = true;
    }
  }

  saveDB();
  await bot.sendMessage(msg.chat.id, `✅ Recomandări trimise la ${sent} abonați!`);
});

// ================================================================
//  ADMIN CALLBACK HANDLERS
// ================================================================

async function handleAdminCallback(chatId, msgId, data) {
  // Users by filter
  if (data.startsWith('adm_users_')) {
    const filterMap = {
      'adm_users_all': null,
      'adm_users_family': 'family',
      'adm_users_couple': 'couple',
      'adm_users_ai': 'all-inclusive',
      'adm_users_luxury': 'luxury',
      'adm_users_new': 'new',
      'adm_users_active': 'active',
    };
    const tag = filterMap[data];
    let subs = Object.values(db.subscribers);
    if (tag) subs = subs.filter(s => s.tags.includes(tag));

    if (subs.length === 0) {
      await bot.answerCallbackQuery(null, { text: 'Niciun abonat în acest segment.' });
      return;
    }

    const list = subs.slice(0, 15).map((s, i) => {
      const name = s.firstName + (s.lastName ? ' ' + s.lastName : '');
      const uname = s.username ? ` @${s.username}` : '';
      const topDest = s.preferences.topCountries.slice(0, 2).join(', ') || '-';
      return `${i + 1}. <b>${name}</b>${uname}\n   🔍 ${s.totalSearches}x | 🌍 ${topDest}`;
    }).join('\n\n');

    const tagLabel = tag || 'toți';
    const keyboard = [[{ text: `📢 Broadcast → ${tagLabel}`, callback_data: `adm_bcast_tag_${tag || 'all'}` }],
                       [{ text: '⬅️ Înapoi', callback_data: 'adm_back' }]];

    await bot.editMessageText(
      `👥 <b>${tagLabel.toUpperCase()}</b> — ${subs.length} abonați\n\n${list}${subs.length > 15 ? `\n\n... +${subs.length - 15} alții` : ''}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    );
    return;
  }

  // Broadcast menu
  if (data === 'adm_broadcast_menu') {
    const keyboard = [
      [{ text: '📢 Toți abonații', callback_data: 'adm_bcast_tag_all' }],
      [{ text: '👨‍👩‍👧 Familii', callback_data: 'adm_bcast_tag_family' },
       { text: '💑 Cupluri', callback_data: 'adm_bcast_tag_couple' }],
      [{ text: '🏖️ All-Inclusive', callback_data: 'adm_bcast_tag_all-inclusive' },
       { text: '👑 Luxury', callback_data: 'adm_bcast_tag_luxury' }],
      [{ text: '⬅️ Înapoi', callback_data: 'adm_back' }],
    ];
    await bot.editMessageText(
      '📢 <b>Broadcast</b>\n\nAlege segmentul, apoi trimite mesajul cu comanda:\n<code>/broadcast mesajul tău</code>\nsau pentru un segment:\n<code>/broadcast:family mesajul tău</code>\n\n<b>Tag-uri disponibile:</b>\nfamily, couple, solo, all-inclusive, luxury, budget, active, new',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    );
    return;
  }

  // Broadcast tag prompt
  if (data.startsWith('adm_bcast_tag_')) {
    const tag = data.replace('adm_bcast_tag_', '');
    const targets = tag === 'all'
      ? Object.values(db.subscribers).filter(s => !s.blocked)
      : Object.values(db.subscribers).filter(s => !s.blocked && s.tags.includes(tag));

    await bot.editMessageText(
      `📢 <b>Broadcast → ${tag === 'all' ? 'TOȚI' : tag}</b>\n\n` +
      `👥 Destinatari: <b>${targets.length}</b>\n\n` +
      `Trimite acum mesajul cu comanda:\n<code>/broadcast${tag !== 'all' ? ':' + tag : ''} Textul mesajului tău aici</code>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
    );
    return;
  }

  // Backup
  if (data === 'adm_backup') {
    saveDB();
    await backupToGitHub();
    await bot.editMessageText('✅ Backup salvat local + GitHub!',
      { chat_id: chatId, message_id: msgId });
    return;
  }

  // Export
  if (data === 'adm_export') {
    const jsonStr = JSON.stringify(db, null, 2);
    const filePath = '/tmp/zebratur_export.json';
    fs.writeFileSync(filePath, jsonStr);
    await bot.sendDocument(chatId, filePath, { caption: `📊 Export — ${Object.keys(db.subscribers).length} abonați` });
    return;
  }

  // Back to admin
  if (data === 'adm_back') {
    // Re-trigger admin
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    bot.emit('text', { chat: { id: chatId }, from: { id: chatId }, text: '/admin' });
    return;
  }
}

// ================================================================
//  COMMAND HANDLERS
// ================================================================

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);

  // Register subscriber
  updateSubscriberInfo(chatId, msg);
  saveDB();

  await bot.sendMessage(chatId,
    '👋 <b>Bun venit la ZebraTur!</b>\n\n' +
    '🔍 Caută tururi în câteva secunde — alege destinația, datele și parametrii, iar eu îți generez link-ul direct.\n\n' +
    'Apasă butonul de mai jos pentru a începe! 👇',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔍 Caută un tur', callback_data: 'start_search' }]],
        resize_keyboard: true,
      }
    }
  );

  await bot.sendMessage(chatId, '💡 Poți folosi /cauta oricând pentru o căutare nouă.', {
    reply_markup: {
      keyboard: [[{ text: '🔍 Caută un tur' }]],
      resize_keyboard: true,
      one_time_keyboard: false,
    }
  });
});

bot.onText(/\/cauta/, async (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  updateSubscriberInfo(chatId, msg);
  await stepCountry(chatId, null);
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    '📖 <b>Cum funcționează:</b>\n\n' +
    '1️⃣ Apasă /cauta sau butonul 🔍\n' +
    '2️⃣ Alege destinația, datele, durata, nr. turiști\n' +
    '3️⃣ Selectează tipul mesei și stelele\n' +
    '4️⃣ Primești link-ul de căutare gata!\n\n' +
    '💡 Poți modifica orice parametru fără să o iei de la capăt.\n\n' +
    '<b>Comenzi:</b>\n' +
    '/cauta — Căutare nouă\n' +
    '/start — Resetează botul',
    { parse_mode: 'HTML' }
  );
});

bot.on('message', async (msg) => {
  if (msg.text === '🔍 Caută un tur') {
    const chatId = msg.chat.id;
    resetSession(chatId);
    updateSubscriberInfo(chatId, msg);
    await stepCountry(chatId, null);
  }
});

// ================================================================
//  CALLBACK QUERY HANDLER
// ================================================================

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const s = getSession(chatId);

  await bot.answerCallbackQuery(query.id);

  try {
    // --- ADMIN CALLBACKS ---
    if (data.startsWith('adm_') && isAdmin(chatId)) {
      await handleAdminCallback(chatId, msgId, data);
      return;
    }

    // --- START SEARCH ---
    if (data === 'start_search' || data === 'new_search') {
      resetSession(chatId);
      updateSubscriberInfo(chatId, query.message);
      await stepCountry(chatId, msgId);
      return;
    }

    // --- COUNTRY ---
    if (data.startsWith('country_')) {
      const countryId = parseInt(data.split('_')[1]);
      const country = COUNTRIES.find(c => c.id === countryId);
      if (country) {
        s.country = country;
        s.transport = country.transport;
        await stepMonth(chatId, msgId);
      }
      return;
    }

    // --- DEPARTURE CITY ---
    if (data.startsWith('depart_')) {
      const cityId = parseInt(data.split('_')[1]);
      const city = DEPARTURE_CITIES.find(c => c.id === cityId);
      if (city) {
        s.departCity = city;
        await stepMonth(chatId, msgId);
      }
      return;
    }

    // --- MONTH ---
    if (data.startsWith('month_')) {
      const parts = data.split('_');
      s._selMonth = parseInt(parts[1]);
      s._selYear = parseInt(parts[2]);
      await stepDay(chatId, msgId);
      return;
    }

    // --- DAY ---
    if (data.startsWith('day_')) {
      s.dateFrom = data.substring(4);
      s.dateTo = addDays(s.dateFrom, 14);
      await stepDuration(chatId, msgId);
      return;
    }

    // --- DURATION ---
    if (data.startsWith('dur_')) {
      s.nights = parseInt(data.split('_')[1]);
      await stepAdults(chatId, msgId);
      return;
    }

    // --- ADULTS ---
    if (data.startsWith('adults_')) {
      s.adults = parseInt(data.split('_')[1]);
      await stepHasChildren(chatId, msgId);
      return;
    }

    // --- HAS CHILDREN? ---
    if (data === 'has_children_no') {
      s.children = [];
      await stepFood(chatId, msgId);
      return;
    }
    if (data === 'has_children_yes') {
      s.children = [];
      await stepChildrenCount(chatId, msgId);
      return;
    }

    // --- CHILDREN COUNT ---
    if (data.startsWith('childcount_')) {
      s._childrenTotal = parseInt(data.split('_')[1]);
      s.children = [];
      await stepChildAge(chatId, msgId);
      return;
    }

    // --- CHILD AGE ---
    if (data.startsWith('childage_')) {
      const age = parseInt(data.split('_')[1]);
      s.children.push(age);
      if (s.children.length < (s._childrenTotal || 1)) {
        await stepChildAge(chatId, msgId);
      } else {
        await stepFood(chatId, msgId);
      }
      return;
    }

    // --- FOOD ---
    if (data.startsWith('food_')) {
      s.food = data.split('_')[1];
      await stepStars(chatId, msgId);
      return;
    }

    // --- STARS ---
    if (data.startsWith('stars_')) {
      const val = data.split('_')[1];
      s.stars = val === 'any' ? '' : val;
      await stepConfirm(chatId, msgId);
      return;
    }

    // --- EDIT ---
    if (data === 'edit_search') { await stepEdit(chatId, msgId); return; }
    if (data === 'edit_country') { await stepCountry(chatId, msgId); return; }
    if (data === 'edit_depart') { await stepDepartCity(chatId, msgId); return; }
    if (data === 'edit_date') { await stepMonth(chatId, msgId); return; }
    if (data === 'edit_duration') { await stepDuration(chatId, msgId); return; }
    if (data === 'edit_adults') { s.children = []; s._childrenTotal = 0; await stepAdults(chatId, msgId); return; }
    if (data === 'edit_food') { await stepFood(chatId, msgId); return; }
    if (data === 'edit_stars') { await stepStars(chatId, msgId); return; }

  } catch (err) {
    console.error('[Bot Error]', err.message);
    if (err.message.includes('message is not modified') || err.message.includes('message to edit not found')) {
      resetSession(chatId);
      await stepCountry(chatId, null);
    }
  }
});

// ================================================================
//  STARTUP & SHUTDOWN
// ================================================================

(async () => {
  loadDB();
  await loadFromGitHub();
  startAutoBackup();
  console.log(`📊 DB: ${Object.keys(db.subscribers).length} abonați | ${db.meta.totalSearches || 0} căutări total`);
  console.log('🤖 ZebraTur Search Bot + CRM — aștept mesaje...');
})();

process.on('SIGINT', () => {
  console.log('\n👋 Bot oprit. Salvez DB...');
  saveDB();
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveDB();
  backupToGitHub().finally(() => {
    bot.stopPolling();
    process.exit(0);
  });
});

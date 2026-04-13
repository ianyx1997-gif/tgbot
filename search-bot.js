/* ============================================================
   ZEBRATUR – TELEGRAM SEARCH BOT
   Generează link de căutare turskanner, interactiv cu butoane

   Comenzi:
   /start    — Mesaj de bun venit + buton CAUTĂ
   /cauta    — Începe căutare nouă (flow interactiv)
   /help     — Instrucțiuni

   Dependențe:  npm install node-telegram-bot-api
   Start:       TELEGRAM_BOT_TOKEN=xxx node search-bot.js
   ============================================================ */

const TelegramBot = require('node-telegram-bot-api');

// ===== CONFIG =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://zebratur.md/offers';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN nu e setat! Setează variabila de mediu.');
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
const MONTH_SHORT = ['ian','feb','mar','apr','mai','iun','iul','aug','sep','oct','nov','dec'];

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
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const days = [];
  // Start from 1st or from today+2 if current month
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

function buildSearchUrl(session) {
  const checkIn = session.dateFrom;
  const checkTo = session.dateTo || addDays(checkIn, 14);
  const childAges = session.children.join(',');

  let url = `${SITE_URL}#!i=${session.country.id}`;
  url += `&c=${checkIn}&v=${checkTo}`;
  url += `&l=${session.nights}`;
  url += `&p=${session.adults}`;
  url += `&tc=${childAges}`;
  url += `&g=1`;
  url += `&d=${session.departCity.id}`;
  url += `&o=${expandFood(session.food)}`;
  url += `&st=${session.stars}`;
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

// ===== STEP: COUNTRY =====
async function stepCountry(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'country';

  const keyboard = [];
  // All countries — 2 per row
  for (let i = 0; i < COUNTRIES.length; i += 2) {
    keyboard.push(COUNTRIES.slice(i, i + 2).map(c => ({
      text: `${c.flag} ${c.name}`,
      callback_data: `country_${c.id}`
    })));
  }

  const text = '🌍 <b>Alege destinația:</b>';

  if (messageId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

// ===== STEP: DEPARTURE CITY =====
async function stepDepartCity(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'depart';

  const popular = DEPARTURE_CITIES.filter(c => c.popular);
  const others = DEPARTURE_CITIES.filter(c => !c.popular);

  const keyboard = [];
  // Popular — one row
  keyboard.push(popular.map(c => ({
    text: `${c.flag} ${c.name}`,
    callback_data: `depart_${c.id}`
  })));
  // Others — 3 per row
  for (let i = 0; i < others.length; i += 3) {
    keyboard.push(others.slice(i, i + 3).map(c => ({
      text: `${c.flag} ${c.name}`,
      callback_data: `depart_${c.id}`
    })));
  }

  const country = s.country;
  await bot.editMessageText(
    `${country.flag} <b>${country.name}</b> — din ce oraș pleci?\n\n✈️ <b>Alege orașul de plecare:</b>`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: MONTH =====
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
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: DAY =====
async function stepDay(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'day';

  const days = getDaysForMonth(s._selMonth, s._selYear);
  const keyboard = [];
  // 7 days per row (like a calendar)
  for (let i = 0; i < days.length; i += 7) {
    keyboard.push(days.slice(i, i + 7).map(d => ({
      text: d.label,
      callback_data: `day_${d.date}`
    })));
  }

  const monthLabel = `${MONTH_NAMES[s._selMonth]} ${s._selYear}`;

  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b>\n\n📅 <b>${monthLabel}</b> — alege ziua:`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: DURATION =====
async function stepDuration(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'duration';

  const keyboard = [
    DURATIONS.slice(0, 3).map(d => ({
      text: `🌙 ${d.label}`,
      callback_data: `dur_${d.nights}`
    })),
    DURATIONS.slice(3).map(d => ({
      text: `🌙 ${d.label}`,
      callback_data: `dur_${d.nights}`
    })),
  ];

  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)}\n\n🌙 <b>Câte nopți?</b>`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: ADULTS =====
async function stepAdults(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'adults';

  const keyboard = [
    ADULTS_OPTIONS.map(n => ({
      text: n === s.adults ? `✅ ${n}` : `${n}`,
      callback_data: `adults_${n}`
    }))
  ];

  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n\n\n👥 <b>Câți adulți?</b>`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: HAS CHILDREN? =====
async function stepHasChildren(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'has_children';

  const keyboard = [
    [{ text: '👶 Da', callback_data: 'has_children_yes' },
     { text: '❌ Nu', callback_data: 'has_children_no' }]
  ];

  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n | 👥 ${s.adults}ad\n\n👶 <b>Călătoriți cu copii?</b>`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: HOW MANY CHILDREN =====
async function stepChildrenCount(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'children_count';

  const keyboard = [
    [1, 2, 3].map(n => ({
      text: `${n}`,
      callback_data: `childcount_${n}`
    }))
  ];

  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 👥 ${s.adults}ad\n\n👶 <b>Câți copii?</b>`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: CHILD AGE =====
async function stepChildAge(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'child_age';

  const childNum = s.children.length + 1;
  const totalChildren = s._childrenTotal || 1;

  const keyboard = [];
  // Ages 0-17 in rows of 6
  for (let i = 0; i < 18; i += 6) {
    const row = [];
    for (let age = i; age < Math.min(i + 6, 18); age++) {
      row.push({ text: `${age}`, callback_data: `childage_${age}` });
    }
    keyboard.push(row);
  }

  await bot.editMessageText(
    `👶 <b>Vârsta copilului ${childNum} din ${totalChildren}:</b>`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: FOOD =====
async function stepFood(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'food';

  const keyboard = [];
  for (let i = 0; i < FOOD_OPTIONS.length; i += 2) {
    keyboard.push(FOOD_OPTIONS.slice(i, i + 2).map(f => ({
      text: `${f.icon} ${f.label}`,
      callback_data: `food_${f.code}`
    })));
  }

  const childText = s.children.length > 0 ? ` + ${s.children.length} copii` : '';

  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n | 👥 ${s.adults}ad${childText}\n\n🍽️ <b>Ce masă preferi?</b>\n<i>"+" înseamnă acest tip și mai bun</i>`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: STARS =====
async function stepStars(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'stars';

  const foodLabel = FOOD_OPTIONS.find(f => f.code === s.food)?.icon || '';

  const keyboard = [
    STARS_OPTIONS.map(st => ({
      text: st.label,
      callback_data: `stars_${st.stars || 'any'}`
    }))
  ];

  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n | ${foodLabel}\n\n⭐ <b>Câte stele?</b>`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: CONFIRM & GENERATE LINK =====
async function stepConfirm(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'confirm';

  const url = buildSearchUrl(s);
  const summary = buildSummary(s);

  const keyboard = [
    [{ text: '🔍 CAUTĂ TURURI!', url: url }],
    [{ text: '✏️ Modifică', callback_data: 'edit_search' },
     { text: '🔄 Căutare nouă', callback_data: 'new_search' }],
  ];

  await bot.editMessageText(
    `✅ <b>Căutarea ta:</b>\n\n${summary}\n\n👇 Apasă pentru a vedea rezultatele:`,
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== STEP: EDIT (modify individual param) =====
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
    {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ===== COMMAND HANDLERS =====

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);

  await bot.sendMessage(chatId,
    '👋 <b>Bun venit la ZebraTur!</b>\n\n' +
    '🔍 Caută tururi în câteva secunde — alege destinația, datele și parametrii, iar eu îți generez link-ul direct.\n\n' +
    'Apasă butonul de mai jos pentru a începe! 👇',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔍 Caută un tur', callback_data: 'start_search' }],
        ],
        // Persistent keyboard for quick access
        resize_keyboard: true,
      }
    }
  );

  // Also set persistent keyboard
  await bot.sendMessage(chatId, '💡 Poți folosi /cauta oricând pentru o căutare nouă.', {
    reply_markup: {
      keyboard: [[{ text: '🔍 Caută un tur' }]],
      resize_keyboard: true,
      one_time_keyboard: false,
    }
  });
});

// /cauta
bot.onText(/\/cauta/, async (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  await stepCountry(chatId, null);
});

// /help
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

// Handle "🔍 Caută un tur" text button
bot.on('message', async (msg) => {
  if (msg.text === '🔍 Caută un tur') {
    const chatId = msg.chat.id;
    resetSession(chatId);
    await stepCountry(chatId, null);
  }
});

// ===== CALLBACK QUERY HANDLER =====
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const s = getSession(chatId);

  await bot.answerCallbackQuery(query.id);

  try {
    // --- START SEARCH ---
    if (data === 'start_search' || data === 'new_search') {
      resetSession(chatId);
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
      s.dateFrom = data.substring(4); // day_2026-05-15 → 2026-05-15
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
      // If more children to add
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
    if (data === 'edit_search') {
      await stepEdit(chatId, msgId);
      return;
    }
    if (data === 'edit_country') {
      await stepCountry(chatId, msgId);
      return;
    }
    if (data === 'edit_depart') {
      await stepDepartCity(chatId, msgId);
      return;
    }
    if (data === 'edit_date') {
      await stepMonth(chatId, msgId);
      return;
    }
    if (data === 'edit_duration') {
      await stepDuration(chatId, msgId);
      return;
    }
    if (data === 'edit_adults') {
      s.children = [];
      s._childrenTotal = 0;
      await stepAdults(chatId, msgId);
      return;
    }
    if (data === 'edit_food') {
      await stepFood(chatId, msgId);
      return;
    }
    if (data === 'edit_stars') {
      await stepStars(chatId, msgId);
      return;
    }

  } catch (err) {
    console.error('[Bot Error]', err.message);
    // If edit fails (message too old), send new message
    if (err.message.includes('message is not modified') || err.message.includes('message to edit not found')) {
      resetSession(chatId);
      await stepCountry(chatId, null);
    }
  }
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', () => {
  console.log('\n👋 Bot oprit.');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bot.stopPolling();
  process.exit(0);
});

console.log('🤖 ZebraTur Search Bot — aștept mesaje...');

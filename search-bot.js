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
  { id: 115, name: 'Turcia', flag: '🇹🇷', transport: 'air', popular: true },
  { id: 43,  name: 'Egipt', flag: '🇪🇬', transport: 'air', popular: true },
  { id: 34,  name: 'Grecia', flag: '🇬🇷', transport: 'air', popular: true },
  { id: 13,  name: 'Bulgaria', flag: '🇧🇬', transport: 'bus', popular: true },
  { id: 54,  name: 'Cipru', flag: '🇨🇾', transport: 'air', popular: false },
  { id: 135, name: 'Muntenegru', flag: '🇲🇪', transport: 'bus', popular: false },
  { id: 92,  name: 'Emirate', flag: '🇦🇪', transport: 'air', popular: false },
  { id: 49,  name: 'Spania', flag: '🇪🇸', transport: 'air', popular: false },
  { id: 48,  name: 'Italia', flag: '🇮🇹', transport: 'air', popular: false },
  { id: 114, name: 'Tunisia', flag: '🇹🇳', transport: 'air', popular: false },
  { id: 113, name: 'Tailanda', flag: '🇹🇭', transport: 'air', popular: false },
  { id: 79,  name: 'Maldive', flag: '🇲🇻', transport: 'air', popular: false },
  { id: 10,  name: 'Albania', flag: '🇦🇱', transport: 'bus', popular: false },
  { id: 42,  name: 'Dominicana', flag: '🇩🇴', transport: 'air', popular: false },
  { id: 152, name: 'Tanzania', flag: '🇹🇿', transport: 'air', popular: false },
  { id: 125, name: 'Sri Lanka', flag: '🇱🇰', transport: 'air', popular: false },
  { id: 29,  name: 'Vietnam', flag: '🇻🇳', transport: 'air', popular: false },
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

function getNextMonthDates() {
  const dates = [];
  const now = new Date();
  // Generate next 6 months of date options (1st and 15th of each month)
  for (let m = 0; m < 6; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
    // If this month, start from tomorrow or nearest week
    if (m === 0) {
      const nextWeek = new Date(now);
      nextWeek.setDate(nextWeek.getDate() + 3);
      dates.push({
        date: nextWeek.toISOString().split('T')[0],
        label: `${fmtDate(nextWeek.toISOString().split('T')[0])} (curând)`
      });
    }
    // 1st of month
    if (d > now) {
      dates.push({
        date: d.toISOString().split('T')[0],
        label: `1 ${['ian','feb','mar','apr','mai','iun','iul','aug','sep','oct','nov','dec'][d.getMonth()]}`
      });
    }
    // 15th of month
    const mid = new Date(d.getFullYear(), d.getMonth(), 15);
    if (mid > now) {
      dates.push({
        date: mid.toISOString().split('T')[0],
        label: `15 ${['ian','feb','mar','apr','mai','iun','iul','aug','sep','oct','nov','dec'][mid.getMonth()]}`
      });
    }
  }
  return dates.slice(0, 12); // max 12 options
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

  const popular = COUNTRIES.filter(c => c.popular);
  const others = COUNTRIES.filter(c => !c.popular);

  const keyboard = [];
  // Popular countries — 2 per row
  for (let i = 0; i < popular.length; i += 2) {
    const row = popular.slice(i, i + 2).map(c => ({
      text: `${c.flag} ${c.name}`,
      callback_data: `country_${c.id}`
    }));
    keyboard.push(row);
  }
  // "More destinations" button
  keyboard.push([{ text: '🌍 Mai multe destinații...', callback_data: 'country_more' }]);

  const text = '🌍 <b>Alege destinația:</b>\n\n<i>Cele mai populare:</i>';

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

async function stepCountryMore(chatId, messageId) {
  const others = COUNTRIES.filter(c => !c.popular);
  const keyboard = [];
  for (let i = 0; i < others.length; i += 3) {
    const row = others.slice(i, i + 3).map(c => ({
      text: `${c.flag} ${c.name}`,
      callback_data: `country_${c.id}`
    }));
    keyboard.push(row);
  }
  keyboard.push([{ text: '⬅️ Înapoi', callback_data: 'country_back' }]);

  await bot.editMessageText('🌍 <b>Toate destinațiile:</b>', {
    chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
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

// ===== STEP: DATE =====
async function stepDate(chatId, messageId) {
  const s = getSession(chatId);
  s.step = 'date';

  const dates = getNextMonthDates();
  const keyboard = [];
  for (let i = 0; i < dates.length; i += 3) {
    keyboard.push(dates.slice(i, i + 3).map(d => ({
      text: `📅 ${d.label}`,
      callback_data: `date_${d.date}`
    })));
  }
  // "Flexible dates" option
  keyboard.push([{ text: '📆 Flexibil (orice dată)', callback_data: 'date_flex' }]);

  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> din ${s.departCity.name}\n\n📅 <b>Când vrei să pleci?</b>\n<i>Alege data aproximativă:</i>`,
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
    })),
    [{ text: '👶 + Adaugă copil', callback_data: 'add_child' },
     { text: '➡️ Continuă', callback_data: 'adults_done' }]
  ];

  let childText = '';
  if (s.children.length > 0) {
    childText = `\n👶 Copii: ${s.children.map(a => a + ' ani').join(', ')}`;
  }

  await bot.editMessageText(
    `${s.country.flag} <b>${s.country.name}</b> | 📅 ${fmtDate(s.dateFrom)} | 🌙 ${s.nights}n\n\n👥 <b>Câți adulți?</b>${childText}`,
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

  const keyboard = [];
  // Ages 0-17 in rows of 6
  for (let i = 0; i < 18; i += 6) {
    const row = [];
    for (let age = i; age < Math.min(i + 6, 18); age++) {
      row.push({ text: `${age}`, callback_data: `childage_${age}` });
    }
    keyboard.push(row);
  }
  keyboard.push([{ text: '❌ Anulează', callback_data: 'child_cancel' }]);

  await bot.editMessageText(
    '👶 <b>Vârsta copilului:</b>',
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
     { text: '✈️ Oraș plecare', callback_data: 'edit_depart' }],
    [{ text: '📅 Data', callback_data: 'edit_date' },
     { text: '🌙 Durata', callback_data: 'edit_duration' }],
    [{ text: '👥 Turiști', callback_data: 'edit_adults' },
     { text: '🍽️ Masă', callback_data: 'edit_food' }],
    [{ text: '⭐ Stele', callback_data: 'edit_stars' }],
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
    if (data === 'country_more') {
      await stepCountryMore(chatId, msgId);
      return;
    }
    if (data === 'country_back') {
      await stepCountry(chatId, msgId);
      return;
    }
    if (data.startsWith('country_')) {
      const countryId = parseInt(data.split('_')[1]);
      const country = COUNTRIES.find(c => c.id === countryId);
      if (country) {
        s.country = country;
        s.transport = country.transport;
        await stepDepartCity(chatId, msgId);
      }
      return;
    }

    // --- DEPARTURE CITY ---
    if (data.startsWith('depart_')) {
      const cityId = parseInt(data.split('_')[1]);
      const city = DEPARTURE_CITIES.find(c => c.id === cityId);
      if (city) {
        s.departCity = city;
        await stepDate(chatId, msgId);
      }
      return;
    }

    // --- DATE ---
    if (data === 'date_flex') {
      // Use tomorrow + 14 days range
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      s.dateFrom = tomorrow.toISOString().split('T')[0];
      s.dateTo = addDays(s.dateFrom, 90); // 3 months range
      await stepDuration(chatId, msgId);
      return;
    }
    if (data.startsWith('date_')) {
      s.dateFrom = data.split('_').slice(1).join('_'); // handle date format
      s.dateTo = addDays(s.dateFrom, 14); // default 2 week window
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
      await stepAdults(chatId, msgId); // refresh to show selected
      return;
    }
    if (data === 'adults_done') {
      await stepFood(chatId, msgId);
      return;
    }
    if (data === 'add_child') {
      if (s.children.length >= 3) {
        await bot.answerCallbackQuery(query.id, { text: 'Maximum 3 copii!', show_alert: true });
        return;
      }
      await stepChildAge(chatId, msgId);
      return;
    }
    if (data.startsWith('childage_')) {
      const age = parseInt(data.split('_')[1]);
      s.children.push(age);
      await stepAdults(chatId, msgId); // back to adults to see child added
      return;
    }
    if (data === 'child_cancel') {
      await stepAdults(chatId, msgId);
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
      await stepDate(chatId, msgId);
      return;
    }
    if (data === 'edit_duration') {
      await stepDuration(chatId, msgId);
      return;
    }
    if (data === 'edit_adults') {
      s.children = []; // reset children when editing
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

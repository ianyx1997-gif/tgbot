/* ============================================================
   AGENT BRIDGE — client SSE pentru creierul Zebra AI (zebra-chat)
   O tură de conversație: trimite mesajul + sessionId, consumă
   stream-ul de evenimente și cheamă hook-urile date de bot.
   Hooks: onStatus(text) · onText(fullText) · onOffers({query,offers,lang}) · onChips([..])
   Returnează { sessionId } (nou sau confirmat).
   ============================================================ */
'use strict';

const ZEBRA_API = process.env.ZEBRA_CHAT_API || 'https://zebra-chat-production.up.railway.app';
const INTERNAL_KEY = process.env.INTERNAL_KEY || '';

async function runTurn({ message, sessionId, hooks = {} }) {
  const ctl = new AbortController();
  // watchdog pe INACTIVITATE (heartbeat-ul SSE vine la 15s → 90s fără nimic = mort),
  // plus un plafon total generos — turele cu retry otpusk pot dura ~2-3 min legitim
  let idleTimer = null;
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ctl.abort(), 90000); };
  resetIdle();
  const totalTimer = setTimeout(() => ctl.abort(), 300000);

  let newSessionId = sessionId || null;
  let text = '';

  try {
    const res = await fetch(ZEBRA_API + '/api/chat', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        ...(INTERNAL_KEY ? { 'x-internal-key': INTERNAL_KEY } : {}),
      },
      body: JSON.stringify({ sessionId: sessionId || null, message, channel: 'telegram-bot' }),
    });
    if (!res.ok || !res.body) {
      let err = 'HTTP ' + res.status;
      try { const j = await res.json(); err = j.error || err; } catch {}
      throw new Error(err);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    const handle = async (event, data) => {
      if (event === 'session') newSessionId = data.sessionId;
      else if (event === 'status') { if (hooks.onStatus) await hooks.onStatus(data.text || '…'); }
      else if (event === 'delta') text += data.text || '';
      else if (event === 'offers') {
        // textul de până acum (ack-ul dinaintea căutării) se livrează înaintea cardurilor
        if (text.trim() && hooks.onText) { await hooks.onText(text.trim()); text = ''; }
        if (hooks.onOffers) await hooks.onOffers(data);
      }
      else if (event === 'chips') {
        if (text.trim() && hooks.onText) { await hooks.onText(text.trim()); text = ''; }
        if (hooks.onChips) await hooks.onChips(data.chips || []);
      }
      else if (event === 'error') throw new Error(data.error || 'eroare agent');
    };

    let pending = Promise.resolve();
    for (;;) {
      const r = await reader.read();
      resetIdle();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = null, dat = '';
        for (const l of raw.split('\n')) {
          if (l.startsWith('event:')) ev = l.slice(6).trim();
          else if (l.startsWith('data:')) dat += l.slice(5).trim();
        }
        if (ev && dat) {
          let parsed; try { parsed = JSON.parse(dat); } catch { continue; }
          // serializăm handler-ele (ordinea mesajelor în Telegram contează)
          pending = pending.then(() => handle(ev, parsed));
          await pending;
        }
      }
    }
    if (text.trim() && hooks.onText) await hooks.onText(text.trim());
    return { sessionId: newSessionId };
  } catch (e) {
    // nu pierde textul deja generat (ack-ul agentului) când tura moare la mijloc
    if (text.trim() && hooks.onText) { try { await hooks.onText(text.trim()); } catch {} }
    throw e;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
}

// fișa hotelului (pt. „Detalii") — direct din API-ul zebra-chat, cu cache mic
const hotelCache = new Map();
async function hotelDetail(hotelId, lang = 'ro') {
  const k = hotelId + ':' + lang;
  const hit = hotelCache.get(k);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.d;
  const res = await fetch(`${ZEBRA_API}/api/hotel/${hotelId}?lang=${lang}`);
  const d = await res.json();
  if (d && d.ok) { hotelCache.set(k, { at: Date.now(), d }); if (hotelCache.size > 300) hotelCache.delete(hotelCache.keys().next().value); }
  return d;
}

module.exports = { runTurn, hotelDetail, ZEBRA_API };

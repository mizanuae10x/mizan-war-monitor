// Notify API — auto-sends to Telegram on new visitor
// POST /api/notify { type: 'new_visitor' | 'stats' }

const BLOB_SAS_URL = 'https://mizanwardata.blob.core.windows.net/presence/presence.json?se=2027-01-01T00%3A00%3A00Z&sp=racwd&spr=https&sv=2026-02-06&sr=b&sig=bErxJWe8cyvDl9%2Fd2htHfvpnhlR9QgAWvn0Nvf0jL%2FE%3D';
const WAR_DB_URL = 'https://war.tamkeenai.ae/data/iran-gulf-war-db.json';
const TG_TOKEN = '8418306250:AAHIX61-wpMTBDilK2F9mxy8v_NdgRFGB1k';
const TG_CHAT = '-1003887044302';
const TG_THREAD = 1201;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

function countActive(sessions) {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  return Object.values(sessions || {}).filter(ts => ts > cutoff).length;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      message_thread_id: TG_THREAD,
      text,
      parse_mode: 'HTML',
      disable_notification: true,   // silent — no sound alert
    }),
  });
  return res.ok;
}

async function getPresence() {
  try {
    const res = await fetch(BLOB_SAS_URL, { headers: { 'x-ms-version': '2020-04-08' } });
    return res.ok ? await res.json() : { sessions: {}, total: 0 };
  } catch { return { sessions: {}, total: 0 }; }
}

module.exports = async function (context, req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers: cors, body: '' };
    return;
  }

  try {
    const { type } = req.body || {};
    const presence = await getPresence();
    const active = countActive(presence.sessions);
    const total = presence.total || 0;

    const now = new Date().toLocaleString('ar-SA', {
      timeZone: 'Asia/Dubai',
      day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });

    let msg;

    if (type === 'new_visitor') {
      msg =
`👁 <b>زائر جديد — مراقبة الأزمة</b>
🕐 ${now}

<b>المتصفحون الآن:</b> ${active}
<b>إجمالي الزيارات:</b> ${total.toLocaleString()}

🌐 <a href="https://war.tamkeenai.ae">war.tamkeenai.ae</a>`;
    } else {
      // stats summary (fallback)
      let oilPrice = '—';
      try {
        const db = await (await fetch(WAR_DB_URL + '?t=' + Date.now())).json();
        oilPrice = db?.indicators?.oilPrice?.slice(-1)[0]?.brent ?? '—';
      } catch {}

      msg =
`📊 <b>إحصائيات مراقبة الأزمة</b>
🕐 ${now}

<b>👁 المتصفحون الآن:</b> ${active}
<b>📈 إجمالي الزيارات:</b> ${total.toLocaleString()}
<b>🛢️ سعر برنت:</b> $${oilPrice}

🌐 <a href="https://war.tamkeenai.ae">war.tamkeenai.ae</a>`;
    }

    const sent = await sendTelegram(msg);
    context.res = { status: sent ? 200 : 500, headers: cors, body: JSON.stringify({ success: sent, active, total }) };

  } catch (err) {
    context.log.error('Notify error:', err.message);
    context.res = { status: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};

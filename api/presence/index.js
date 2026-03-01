// Presence API — tracks live visitors + sends location/device info to Telegram on new visitor
// GET  /api/presence        → { active, total }
// POST /api/presence        → { sessionId } → heartbeat + auto-notify on new visitor

const BLOB_SAS_URL = 'https://mizanwardata.blob.core.windows.net/presence/presence.json?se=2027-01-01T00%3A00%3A00Z&sp=racwd&spr=https&sv=2026-02-06&sr=b&sig=bErxJWe8cyvDl9%2Fd2htHfvpnhlR9QgAWvn0Nvf0jL%2FE%3D';
const TG_TOKEN   = '8418306250:AAHIX61-wpMTBDilK2F9mxy8v_NdgRFGB1k';
const TG_CHAT    = '-1003887044302';
const TG_THREAD  = 1201;
const ACTIVE_MS  = 2 * 60 * 1000;  // 2 min = "live"
const PRUNE_MS   = 10 * 60 * 1000; // keep 10 min history
const MAX_RETRY  = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  const first = xff.split(',')[0].trim();
  return first || req.headers['client-ip'] || req.headers['x-client-ip'] || 'unknown';
}

function parseUserAgent(ua = '') {
  // Device type
  let device = 'Desktop';
  if (/mobile|android.*mobile|iphone|ipod|blackberry|opera mini|iemobile/i.test(ua)) device = 'Mobile';
  else if (/ipad|android(?!.*mobile)|tablet/i.test(ua)) device = 'Tablet';

  // OS
  let os = 'Unknown OS';
  if (/windows nt 10/i.test(ua))          os = 'Windows 10/11';
  else if (/windows nt/i.test(ua))         os = 'Windows';
  else if (/mac os x/i.test(ua))           os = 'macOS';
  else if (/iphone os ([\d_]+)/i.test(ua)) os = 'iOS ' + ua.match(/iphone os ([\d_]+)/i)[1].replace(/_/g,'.');
  else if (/android ([\d.]+)/i.test(ua))   os = 'Android ' + ua.match(/android ([\d.]+)/i)[1];
  else if (/linux/i.test(ua))              os = 'Linux';

  // Browser
  let browser = 'Unknown Browser';
  if (/edg\/([\d.]+)/i.test(ua))           browser = 'Edge '  + ua.match(/edg\/([\d.]+)/i)[1];
  else if (/opr\/([\d.]+)/i.test(ua))      browser = 'Opera ' + ua.match(/opr\/([\d.]+)/i)[1];
  else if (/chrome\/([\d.]+)/i.test(ua))   browser = 'Chrome '+ ua.match(/chrome\/([\d.]+)/i)[1].split('.')[0];
  else if (/firefox\/([\d.]+)/i.test(ua))  browser = 'Firefox '+ ua.match(/firefox\/([\d.]+)/i)[1];
  else if (/safari\/([\d.]+)/i.test(ua))   browser = 'Safari';
  else if (/msie|trident/i.test(ua))       browser = 'IE';

  return { device, os, browser };
}

async function geolocate(ip) {
  if (!ip || ip === 'unknown' || ip.startsWith('127.') || ip.startsWith('::1') || ip.startsWith('10.') || ip.startsWith('172.') || ip.startsWith('192.168.')) {
    return { country: '—', city: '—', isp: '—', flag: '🌐' };
  }
  try {
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,isp,org`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return { country: '—', city: '—', isp: '—', flag: '🌐' };
    const d = await res.json();
    if (d.status !== 'success') return { country: '—', city: '—', isp: '—', flag: '🌐' };

    // Country code → flag emoji
    const flag = d.countryCode
      ? d.countryCode.toUpperCase().replace(/./g, c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0)))
      : '🌐';

    return { country: d.country || '—', city: d.city || '—', region: d.regionName || '', isp: d.isp || d.org || '—', flag };
  } catch {
    return { country: '—', city: '—', isp: '—', flag: '🌐' };
  }
}

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        message_thread_id: TG_THREAD,
        text,
        parse_mode: 'HTML',
        disable_notification: true,
      }),
    });
  } catch { /* silent */ }
}

// ── Blob helpers ──────────────────────────────────────────────────────────────

async function readBlob() {
  const res = await fetch(BLOB_SAS_URL, { headers: { 'x-ms-version': '2020-04-08' } });
  if (!res.ok) throw new Error(`Blob read failed: ${res.status}`);
  return { data: await res.json(), etag: res.headers.get('etag') };
}

async function writeBlob(data, etag) {
  const res = await fetch(BLOB_SAS_URL, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-ms-version': '2020-04-08',
      'x-ms-blob-type': 'BlockBlob',
      ...(etag ? { 'If-Match': etag } : {}),
    },
    body: JSON.stringify(data),
  });
  return res.ok || res.status === 201;
}

function countActive(sessions) {
  const cutoff = Date.now() - ACTIVE_MS;
  return Object.values(sessions).filter(ts => ts > cutoff).length;
}

function pruneOld(sessions) {
  const cutoff = Date.now() - PRUNE_MS;
  return Object.fromEntries(Object.entries(sessions).filter(([, ts]) => ts > cutoff));
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function (context, req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') { context.res = { status: 204, headers: cors, body: '' }; return; }

  try {
    // ── GET ──
    if (req.method === 'GET') {
      const { data } = await readBlob();
      const active = countActive(data.sessions || {});
      context.res = { status: 200, headers: cors, body: JSON.stringify({ active, total: data.total || 0 }) };
      return;
    }

    // ── POST ──
    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) {
      context.res = { status: 400, headers: cors, body: JSON.stringify({ error: 'Invalid sessionId' }) };
      return;
    }

    const ip = getClientIP(req);
    const ua = req.headers['user-agent'] || '';

    let result = { active: 0, total: 0, isNew: false };

    // Optimistic-lock write loop
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const { data, etag } = await readBlob();
      const sessions = pruneOld(data.sessions || {});
      const isNew = !sessions[sessionId];
      sessions[sessionId] = Date.now();

      const newData = {
        sessions,
        total: (data.total || 0) + (isNew ? 1 : 0),
        lastUpdated: new Date().toISOString(),
      };

      const ok = await writeBlob(newData, etag);
      if (ok) {
        result = { active: countActive(sessions), total: newData.total, isNew };
        break;
      }
      await new Promise(r => setTimeout(r, 60 * (attempt + 1)));
    }

    // ── New visitor → enrich + notify ──
    if (result.isNew) {
      // Run in parallel — don't block the response
      (async () => {
        const [geo, { device, os, browser }] = await Promise.all([
          geolocate(ip),
          Promise.resolve(parseUserAgent(ua)),
        ]);

        const now = new Date().toLocaleString('ar-SA', {
          timeZone: 'Asia/Dubai', day: 'numeric', month: 'short',
          hour: '2-digit', minute: '2-digit', hour12: false,
        });

        const msg =
`👁 <b>زائر جديد — مراقبة الأزمة</b>
🕐 ${now} (توقيت الإمارات)

${geo.flag} <b>الموقع:</b> ${geo.city}${geo.region ? ', ' + geo.region : ''} — ${geo.country}
🌐 <b>مزود الإنترنت:</b> ${geo.isp}
🖥 <b>الجهاز:</b> ${device} · ${os}
🌍 <b>المتصفح:</b> ${browser}
📡 <b>IP:</b> <code>${ip}</code>

👥 المتصفحون الآن: <b>${result.active}</b>
📈 الإجمالي: <b>${result.total}</b>

🔗 <a href="https://war.tamkeenai.ae">war.tamkeenai.ae</a>`;

        await sendTelegram(msg);
      })();
    }

    context.res = { status: 200, headers: cors, body: JSON.stringify(result) };

  } catch (err) {
    context.log.error('Presence error:', err.message);
    context.res = { status: 500, headers: cors, body: JSON.stringify({ error: 'Internal error', active: 0, total: 0 }) };
  }
};

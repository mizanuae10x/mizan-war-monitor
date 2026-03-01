// /api/db — Live proxy: always returns fresh war database from Azure Blob
const BLOB_SAS = 'https://mizanwardata.blob.core.windows.net/data/iran-gulf-war-db.json?se=2027-01-01T00%3A00%3A00Z&sp=r&spr=https&sv=2026-02-06&sr=b&sig=54ZvlgVGeaoh09%2BfWx%2BEz0hC1uj2OPOHBs58z9jRR%2BQ%3D';

module.exports = async function (context, req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (req.method === 'OPTIONS') { context.res = { status: 204, headers: cors, body: '' }; return; }

  try {
    const res = await fetch(BLOB_SAS + '&t=' + Date.now(), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Blob ${res.status}`);
    const body = await res.text();
    context.res = { status: 200, headers: cors, body };
  } catch (err) {
    context.log.error('DB proxy error:', err.message);
    context.res = { status: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};

/**
 * 收租系統 Cloudflare Worker（一個 Worker 包晒網站同 WhatsApp 後台）
 *
 *   https://你的域名/             → site/ 入面嘅網頁（WhatsApp 示範 + CRM 後台）
 *   https://你的域名/webhook      → Meta WhatsApp webhook：驗證簽名，轉發去 Google Apps Script
 *   https://你的域名/api/health   → 檢查設定齊唔齊（唔會顯示任何密碼）
 *
 * 密碼一律用 Cloudflare Secrets（wrangler secret put …），唔好寫入 repo：
 *   VERIFY_TOKEN   自己作一個字串，喺 Meta 設定 webhook 時填同一個
 *   APP_SECRET     Meta App 嘅 App Secret（用嚟驗證訊息真係由 Meta 發出）
 *   GAS_URL        Apps Script「網頁應用程式」網址（https://script.google.com/macros/s/.../exec）
 *   RELAY_SECRET   同 Apps Script 指令碼屬性 RELAY_SECRET 一樣
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/webhook') return webhook(request, env, ctx, url);
    if (path === '/api/health') return health(env);

    // 其他全部係網站檔案
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
};

async function webhook(request, env, ctx, url) {
  // 1. Meta 第一次設定 webhook 時嘅驗證
  if (request.method === 'GET') {
    const ok = !!env.VERIFY_TOKEN &&
      url.searchParams.get('hub.mode') === 'subscribe' &&
      url.searchParams.get('hub.verify_token') === env.VERIFY_TOKEN;
    return ok ? new Response(url.searchParams.get('hub.challenge') || '', { status: 200 })
      : new Response('forbidden', { status: 403 });
  }
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // 2. 驗證簽名
  const body = await request.text();
  const sig = request.headers.get('x-hub-signature-256') || '';
  if (!(await validSignature(body, sig, env.APP_SECRET))) return new Response('bad signature', { status: 401 });

  let payload;
  try { payload = JSON.parse(body); } catch (e) { return new Response('bad json', { status: 400 }); }

  // 只轉發有訊息嘅通知（已讀、已送達等狀態唔使理）
  const hasMessages = (payload.entry || []).some(e => (e.changes || []).some(c => ((c.value && c.value.messages) || []).length));
  if (hasMessages && env.GAS_URL) {
    // 即刻回 200 俾 Meta，喺背景轉發（Apps Script 可能要幾秒）
    ctx.waitUntil(fetch(env.GAS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.RELAY_SECRET, payload }),
      redirect: 'follow',
    }).catch(err => console.log('forward failed', String(err))));
  }
  return new Response('ok', { status: 200 });
}

function health(env) {
  const need = ['VERIFY_TOKEN', 'APP_SECRET', 'GAS_URL', 'RELAY_SECRET'];
  const missing = need.filter(k => !env[k]);
  return Response.json({ ok: missing.length === 0, missing, site: !!env.ASSETS },
    { headers: { 'cache-control': 'no-store' } });
}

export async function validSignature(body, header, secret) {
  if (!secret || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

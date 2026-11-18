// node --test worker/test  （唔使裝任何嘢，Node 20 或以上）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';

const env = { VERIFY_TOKEN: 'vt', APP_SECRET: 'as', GAS_URL: 'https://gas.example/exec', RELAY_SECRET: 'rs',
  ASSETS: { fetch: () => new Response('<html>site</html>') } };
const waits = [];
const ctx = { waitUntil: p => waits.push(p) };
const sign = b => 'sha256=' + createHmac('sha256', env.APP_SECRET).update(b).digest('hex');

test('Meta 驗證', async () => {
  const ok = await worker.fetch(new Request('https://x/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=123'), env, ctx);
  assert.equal(ok.status, 200); assert.equal(await ok.text(), '123');
  const bad = await worker.fetch(new Request('https://x/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=1'), env, ctx);
  assert.equal(bad.status, 403);
});

test('簽名錯就拒絕', async () => {
  const r = await worker.fetch(new Request('https://x/webhook', { method: 'POST', body: '{}', headers: { 'x-hub-signature-256': 'sha256=00' } }), env, ctx);
  assert.equal(r.status, 401);
});

test('有訊息就轉發去 Apps Script', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { sent.push([u, JSON.parse(o.body)]); return new Response('ok'); };
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '852', text: { body: '欠幾多' } }] } }] }] });
  const r = await worker.fetch(new Request('https://x/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } }), env, ctx);
  await Promise.all(waits);
  globalThis.fetch = realFetch;
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], env.GAS_URL);
  assert.equal(sent[0][1].secret, 'rs');
});

test('網站同 health', async () => {
  assert.equal(await (await worker.fetch(new Request('https://x/'), env, ctx)).text(), '<html>site</html>');
  const h = await (await worker.fetch(new Request('https://x/api/health'), { ASSETS: env.ASSETS }, ctx)).json();
  assert.equal(h.ok, false); assert.deepEqual(h.missing, ['VERIFY_TOKEN', 'APP_SECRET', 'GAS_URL', 'RELAY_SECRET']);
});

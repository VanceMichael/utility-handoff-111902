import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createSource } from '../source.mjs';

const scenario = JSON.parse(await readFile(new URL('../scenario.json', import.meta.url), 'utf8'));

const server = createSource().listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const request = (path, options) => fetch(origin + path, options);
const send = (path, value) => request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});

test.after(async () => {
  server.close();
  await once(server, 'close');
});

test('已登记的原始资料可以按来源契约读取', async () => {
  const routes = scenario.routes.filter(route => route.method === 'GET' &&
    !route.steps[0].lookup && route.kind !== 'ticket');
  assert.ok(routes.length > 2);
  for (const phase of [0, 1]) {
    const changed = await send('/replay/phase', { phase });
    assert.deepEqual(await changed.json(), { phase });
    for (const route of routes) {
      const query = new URLSearchParams(route.query || {});
      const response = await request(route.path + (query.size ? '?' + query : ''));
      assert.equal(response.status, route.status, route.path);
      const received = route.kind === 'ndjson'
        ? (await response.text()).trimEnd().split('\n').map(line => JSON.parse(line))
        : await response.json();
      assert.deepEqual(received, route.steps[phase], route.path);
    }
    assert.equal((await request('/nonexistent')).status, 404);
  }
});

const ticketRoute = scenario.routes.find(route => route.steps[0].response === 'ticket');
if (ticketRoute) {
  test('领取票绑定报告编号、修订及使用次数', async () => {
    await send('/replay/phase', { phase: 0 });
    const response = await send(ticketRoute.path, { requestKey: '检查-1', proof: 'P24', revision: 1 });
    assert.equal(response.status, 201);
    const { downloadPath } = await response.json();
    const obtained = await request(downloadPath);
    assert.equal(obtained.status, 200);
    assert.equal((await obtained.json()).proof, 'P24');
    assert.equal((await request(downloadPath)).status, 410);
    const next = await send(ticketRoute.path, { requestKey: '检查-2', proof: 'P24', revision: 1 });
    await send('/replay/phase', { phase: 1 });
    assert.equal((await request((await next.json()).downloadPath)).status, 410);
  });
}

const receiptRoute = scenario.routes.find(route => route.steps[0].response === 'receipt');
if (receiptRoute) {
  test('受理记录可以按原经办号追认', async () => {
    const { path, steps } = receiptRoute;
    const [config] = steps;
    const record = Object.fromEntries(config.fields.map(field => [field, '样例-' + field]));
    assert.equal((await send(path, {})).status, 400);
    const checkpoint = await send('/replay/phase', { phase: config.drop ? 0 : 1 });
    assert.equal(checkpoint.status, 200);
    if (config.drop) {
      await assert.rejects(send(path, record), /fetch failed/);
      const pending = await request(path + '?requestKey=' + encodeURIComponent(record.requestKey));
      assert.equal((await pending.json()).state, '待显示');
      await send('/replay/phase', { phase: 1 });
    } else {
      assert.equal((await send(path, record)).status, 201);
    }
    const read = await request(path + '?requestKey=' + encodeURIComponent(record.requestKey));
    const taken = await read.json();
    assert.equal(taken.state, '已受理');
    assert.deepEqual(taken.submitted, record);
    assert.equal((await (await send(path, record)).json()).receipt, taken.receipt);
    assert.equal((await send(path, { ...record, extra: true })).status, 409);
  });
}

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSource } from '../source.mjs';
import { createClient } from '../lib/client.mjs';
import { createDesk } from '../lib/desk.mjs';
import { Drill } from '../lib/drill.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { ReplyService } from '../lib/replies.mjs';
import { createFileStore, storePath } from '../lib/store.mjs';

async function deskHarness() {
  const source = createSource().listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = 'http://127.0.0.1:' + source.address().port;
  const directory = await mkdtemp(join(tmpdir(), 'handoff-'));

  async function build() {
    const ledger = await Ledger.load(createFileStore(storePath(directory, 'H-406')));
    const client = createClient({ baseUrl: sourceUrl });
    const replies = new ReplyService({ client, ledger });
    const drill = new Drill({ client, ledger, replies });
    const desk = createDesk({ ledger, drill, replies, caseId: 'H-406' });
    desk.listen(0, '127.0.0.1');
    await once(desk, 'listening');
    return { ledger, replies, drill, desk, origin: 'http://127.0.0.1:' + desk.address().port };
  }

  const first = await build();
  const at = path => first.origin + path;
  const post = (path, body) => fetch(at(path), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const phase = async value => {
    const response = await fetch(sourceUrl + '/replay/phase', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase: value }),
    });
    assert.equal(response.status, 200);
  };

  return {
    sourceUrl,
    at,
    post,
    phase,
    async restart() {
      first.desk.close();
      await once(first.desk, 'close');
      const next = await build();
      Object.assign(first, next);
      return next;
    },
    async close() {
      first.desk.close();
      await once(first.desk, 'close');
      source.close();
      await once(source, 'close');
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('演练全流程：派发、过程、补领、回告、补充回告、重启交班', async () => {
  const harness = await deskHarness();
  try {
    assert.equal((await harness.post('/api/dispatch', { caseId: 'H-406' })).status, 303);
    assert.equal((await harness.post('/api/sync', { after: 8, from: 9, to: 10 })).status, 303);

    let state = await (await fetch(harness.at('/api/state'))).json();
    assert.deepEqual(state.parts.map(part => part.id), ['L1', 'L2', 'L3']);
    assert.equal(state.parts.find(part => part.id === 'L2').currentTeam, '供热');
    assert.equal(state.parts.find(part => part.id === 'L2').ticket, 'T-81');
    assert.equal(state.parts.find(part => part.id === 'L2').basis.includes('P-16'), true);
    assert.equal(state.parts.find(part => part.id === 'L1').ticket, 'W-51');

    // 阶段 1：新处理记录与能改变结论的补充说明。
    await harness.phase(1);
    assert.equal((await harness.post('/api/sync', { after: 8, from: 9, to: 10 })).status, 303);
    state = await (await fetch(harness.at('/api/state'))).json();
    const l2 = state.parts.find(part => part.id === 'L2');
    assert.equal(l2.resolutions.find(item => item.offset === 12).finding, '阀门调校');
    assert.equal(l2.resolutions.find(item => item.offset === 12).active, false);
    assert.equal(l2.findings[0].finding, '支管压差尚待复测');
    assert.ok(state.notes.some(note => note.kind === '处理结论可能变化'));

    // 回执要等下一阶段可见：本次发送先挂原身份。
    await harness.phase(0);
    const send = await harness.post('/api/replies', { part: 'L2', text: '已处理', requestKey: 'REQ-L2-1' });
    assert.equal(send.status, 303);
    state = await (await fetch(harness.at('/api/state'))).json();
    let reply = state.replies.find(item => item.requestKey === 'REQ-L2-1');
    assert.equal(reply.state, '已发送');
    assert.equal(reply.receiptOpen, false);
    const requestKeyCount = state.replies.length;

    await harness.phase(1);
    const retry = await (await harness.post('/api/replies/retry')).json();
    assert.equal(retry.length, 1);
    assert.equal(retry[0].requestKey, 'REQ-L2-1');
    assert.ok(retry[0].receipt);
    state = await (await fetch(harness.at('/api/state'))).json();
    assert.equal(state.replies.length, requestKeyCount, '重跑不新增回告身份');
    reply = state.replies.find(item => item.requestKey === 'REQ-L2-1');
    assert.equal(reply.state, '已受理');
    assert.equal(reply.receipt, retry[0].receipt);

    // 重启后仍能接着交班，并且同一身份再发不会产生新回执。
    await harness.restart();
    state = await (await fetch(harness.at('/api/state'))).json();
    assert.equal(state.parts.find(part => part.id === 'L2').findings[0].finding, '支管压差尚待复测');
    const again = await harness.post('/api/replies', { part: 'L2', text: '已处理', requestKey: 'REQ-L2-1' });
    assert.equal(again.status, 303);
    state = await (await fetch(harness.at('/api/state'))).json();
    assert.equal(state.replies.length, requestKeyCount);
    assert.equal(state.replies.find(item => item.requestKey === 'REQ-L2-1').receipt, reply.receipt);

    // 补充回告：引用原回执，保留原回告依据；其他分项照常回告。
    const priorReceipt = reply.receipt;
    const supplement = await harness.post('/api/replies', {
      part: 'L2', text: '补充：已处理，支管压差尚待复测', priorReceipt, requestKey: 'REQ-L2-SUP',
    });
    assert.equal(supplement.status, 303);
    const other = await harness.post('/api/replies', { part: 'L1', text: '已处理', requestKey: 'REQ-L1-1' });
    assert.equal(other.status, 303);
    state = await (await fetch(harness.at('/api/state'))).json();
    const extra = state.replies.find(item => item.requestKey === 'REQ-L2-SUP');
    assert.equal(extra.priorReceipt, priorReceipt);
    assert.equal(extra.source.priorReply.receipt, priorReceipt);
    assert.equal(extra.source.findings[0].id, 'F-71');
    assert.equal(extra.source.ticket, 'T-81');

    const handover = await (await fetch(harness.at('/api/handover'))).json();
    assert.deepEqual(handover.repliesSent.map(item => item.receipt).sort(),
      [priorReceipt, extra.receipt, state.replies.find(item => item.requestKey === 'REQ-L1-1').receipt].sort());
    assert.deepEqual(handover.stillFollowing.map(item => item.part), ['L1', 'L2', 'L3']);

    const page = await (await fetch(harness.at('/'))).text();
    assert.match(page, /分项归属/);
    assert.match(page, /已送回热线/);
  } finally {
    await harness.close();
  }
});

test('只补领到转出、还没看到对方接收时，分项留在跟进清单上', async () => {
  const harness = await deskHarness();
  try {
    await harness.post('/api/dispatch', { caseId: 'H-406' });
    // 只按补领区间取数，不带实时页里的接收记录。
    const response = await harness.post('/api/sync', { from: 9, to: 10, mode: 'replay' });
    assert.equal(response.status, 303);
    const handover = await (await fetch(harness.at('/api/handover'))).json();
    assert.deepEqual(handover.pendingAcceptance.map(item => item.part), ['L2']);
    assert.equal(handover.pendingAcceptance[0].expectedTeam, '供热');
    const l2 = handover.stillFollowing.find(item => item.part === 'L2');
    assert.equal(l2.pending, true);
    assert.equal(l2.ticket, 'T-81');

    const page = await (await fetch(harness.at('/'))).text();
    assert.match(page, /社区清单上仍需跟进/);
    assert.match(page, /提醒供热催接/);

    // 补上实时页的接收记录后，才从待确认承接里撤下。
    await harness.post('/api/sync', { after: 8, from: 9, to: 10 });
    const next = await (await fetch(harness.at('/api/handover'))).json();
    assert.deepEqual(next.pendingAcceptance, []);
    assert.equal(next.stillFollowing.find(item => item.part === 'L2').pending, false);
  } finally {
    await harness.close();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../lib/ledger.mjs';
import { RemoteError } from '../lib/client.mjs';
import { ReplyService } from '../lib/replies.mjs';

const DISPATCH = {
  caseId: 'H-406',
  affectedScope: '小桥北巷 2 号',
  parts: [
    { id: 'L1', service: '查漏', operator: 'water' },
    { id: 'L2', service: '恢复供暖', operator: 'heat' },
    { id: 'L3', service: '清理井室', operator: 'water' },
  ],
};

async function ready() {
  const ledger = new Ledger();
  await ledger.ingestDispatch(DISPATCH);
  for (const record of [
    { offset: 9, type: 'opened', office: 'water', ticket: 'W-51', parts: ['L1', 'L2', 'L3'] },
    { offset: 10, type: 'handed_off', office: 'water', ticket: 'W-51', handoff: 'P-16', nextOffice: 'heat', nextTicket: 'T-81', parts: ['L2'] },
    { offset: 11, type: 'accepted', office: 'heat', ticket: 'T-81', handoff: 'P-16', parts: ['L2'] },
    { offset: 12, type: 'resolved', office: 'heat', ticket: 'T-81', parts: ['L2'], finding: '阀门调校' },
  ]) {
    await ledger.ingestRecord(record, 'replay');
  }
  await ledger.ingestFindings({
    records: [{ id: 'F-71', ticket: 'T-81', part: 'L2', replacesOffset: 12, finding: '支管压差尚待复测' }],
  });
  return ledger;
}

// 模拟热线的回告受理：按 requestKey 幂等，受理后要等阶段推进才给回执。
function fakeHotline({ dropFirst = false, hideReceipt = false } = {}) {
  const inbox = new Map();
  const calls = { submit: 0, lookup: 0 };
  let dropped = !dropFirst;
  let visible = !hideReceipt;
  return {
    calls,
    inbox,
    showReceipts() { visible = true; },
    async submitReply(record) {
      calls.submit += 1;
      if (!dropped) {
        dropped = true;
        throw new RemoteError('来源连接中断：fetch failed', { network: true });
      }
      if (!inbox.has(record.requestKey)) {
        inbox.set(record.requestKey, { receipt: 'R-' + (inbox.size + 1), body: record });
      }
      const saved = inbox.get(record.requestKey);
      return visible
        ? { state: '已受理', receipt: saved.receipt, submitted: saved.body }
        : { state: '待显示' };
    },
    async readReply(requestKey) {
      calls.lookup += 1;
      const saved = inbox.get(requestKey);
      if (!saved) throw new RemoteError('来源返回 404', { status: 404 });
      return visible ? { state: '已受理', receipt: saved.receipt, submitted: saved.body } : { state: '待显示' };
    },
  };
}

test('提交时断线：用同一回告身份重投，不产生第二份受理', async () => {
  const ledger = await ready();
  const hotline = fakeHotline({ dropFirst: true });
  const replies = new ReplyService({ client: hotline, ledger, sleep: async () => {} });
  const draft = await replies.draft({ partId: 'L2', text: '已处理' });
  const result = await replies.send(draft.requestKey);
  assert.equal(result.receipt, 'R-1');
  assert.equal(hotline.inbox.size, 1);
  assert.ok(ledger.findReply({ requestKey: draft.requestKey }).attempts
    .some(attempt => attempt.kind === 'network'));
  const again = await replies.send(draft.requestKey);
  assert.equal(again.receipt, 'R-1');
  assert.equal(hotline.inbox.size, 1);
});

test('回执还查不到时不换身份：先挂原身份，可见后追认', async () => {
  const ledger = await ready();
  const hotline = fakeHotline({ hideReceipt: true });
  const replies = new ReplyService({ client: hotline, ledger, sleep: async () => {} });
  const draft = await replies.draft({ partId: 'L2', text: '已处理' });
  const first = await replies.send(draft.requestKey);
  assert.equal(first.state, '已发送');
  assert.equal(first.receipt, null);
  assert.equal(first.awaitingReceipt, true);

  // 超时重跑：仍是原 requestKey。
  const retried = await replies.retryPending();
  assert.equal(retried.length, 1);
  assert.equal(retried[0].requestKey, draft.requestKey);
  assert.equal(retried[0].receipt, null);

  hotline.showReceipts();
  const confirmed = await replies.retryPending();
  assert.equal(confirmed[0].receipt, 'R-1');
  assert.equal(ledger.findReply({ requestKey: draft.requestKey }).state, '已受理');
  assert.equal(hotline.inbox.size, 1, '重投沿用原身份，热线只有一份受理');
  assert.ok(hotline.calls.submit >= 1);
});

test('补充回告引用原回执，可继续其他分项并保留原回告依据', async () => {
  const ledger = await ready();
  const hotline = fakeHotline();
  const replies = new ReplyService({ client: hotline, ledger, sleep: async () => {} });
  const original = await replies.send((await replies.draft({ partId: 'L2', text: '已处理' })).requestKey);
  assert.equal(original.receipt, 'R-1');

  await assert.rejects(
    replies.draft({ partId: 'L2', text: '已处理' }),
    /必须引用其回执号/,
  );
  const supplement = await replies.send((await replies.draft({
    partId: 'L2',
    text: '补充：已处理，支管压差尚待复测',
    priorReceipt: original.receipt,
  })).requestKey);
  assert.equal(supplement.state, '已受理');
  assert.equal(supplement.receipt, 'R-2');
  assert.equal(hotline.inbox.get(supplement.requestKey).body.priorReceipt, 'R-1');

  const basis = ledger.findReply({ requestKey: supplement.requestKey }).source;
  assert.equal(basis.priorReply.receipt, 'R-1');
  assert.equal(basis.ticket, 'T-81');
  assert.equal(basis.activeResolution, null, '证据已让原处理说明失效');
  assert.equal(basis.findings[0].id, 'F-71');
  assert.equal(basis.findings[0].supersedes, '阀门调校');

  // 其他分项照常回告。
  const other = await replies.send((await replies.draft({ partId: 'L1', text: '已处理' })).requestKey);
  assert.equal(other.receipt, 'R-3');
});

test('回执还未可查时没有回执号可引用，只能沿用原身份追认', async () => {
  const ledger = await ready();
  const hotline = fakeHotline({ hideReceipt: true });
  const replies = new ReplyService({ client: hotline, ledger, sleep: async () => {} });
  const pending = await replies.send((await replies.draft({ partId: 'L2', text: '已处理' })).requestKey);
  assert.equal(pending.receipt, null);
  assert.equal(pending.awaitingReceipt, true);
  await assert.rejects(
    replies.draft({ partId: 'L2', text: '补充：漏报', priorReceipt: 'R-1' }),
    /找不到回执号/,
  );
});

test('补充回告也经历过断线重投，原回执身份不变', async () => {
  const ledger = await ready();
  const hotline = fakeHotline();
  const replies = new ReplyService({ client: hotline, ledger, sleep: async () => {} });
  const original = await replies.send((await replies.draft({ partId: 'L2', text: '已处理' })).requestKey);
  const draft = await replies.draft({ partId: 'L2', text: '补充：尚待复测', priorReceipt: original.receipt });
  const before = hotline.calls.submit;
  hotline.submitReply = (function (submit) {
    return async record => {
      hotline.calls.submit += 1;
      if (hotline.calls.submit === before + 1) throw new RemoteError('网络中断', { network: true });
      return submit.call(hotline, record);
    };
  })(hotline.submitReply);
  const result = await replies.send(draft.requestKey);
  assert.equal(hotline.inbox.size, 2);
  assert.equal(result.receipt, 'R-2');
  assert.equal(result.priorReceipt, 'R-1');
});

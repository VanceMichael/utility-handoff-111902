import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../lib/ledger.mjs';

const DISPATCH = {
  caseId: 'H-406',
  affectedScope: '小桥北巷 2 号',
  parts: [
    { id: 'L1', service: '查漏', operator: 'water' },
    { id: 'L2', service: '恢复供暖', operator: 'heat' },
    { id: 'L3', service: '清理井室', operator: 'water' },
  ],
};

const OPENED = { offset: 9, type: 'opened', office: 'water', ticket: 'W-51', parts: ['L1', 'L2', 'L3'] };
const HANDOFF = {
  offset: 10, type: 'handed_off', office: 'water', ticket: 'W-51', handoff: 'P-16',
  nextOffice: 'heat', nextTicket: 'T-81', parts: ['L2'],
};
const ACCEPT = { offset: 11, type: 'accepted', office: 'heat', ticket: 'T-81', handoff: 'P-16', parts: ['L2'] };

async function desk() {
  const ledger = new Ledger();
  await ledger.ingestDispatch(DISPATCH);
  return ledger;
}

function part(ledger, id) {
  return ledger.view().parts.find(candidate => candidate.id === id);
}

test('热线分项建档：住址和类别不改变归属', async () => {
  const ledger = await desk();
  const view = ledger.view();
  assert.equal(view.caseId, 'H-406');
  assert.deepEqual(view.parts.map(item => item.id), ['L1', 'L2', 'L3']);
  assert.equal(view.parts[0].status, '待接手');
  assert.equal(view.parts[1].dispatchedTeam, '供热');

  await ledger.ingestDispatch({ ...DISPATCH, affectedScope: '小桥北巷 2 号（核对）' });
  assert.equal(part(ledger, 'L2').currentTeam, '供热');
  assert.equal(part(ledger, 'L2').ticket, null);
});

test('转出只结束原企业责任，未确认承接的分项留在跟进清单', async () => {
  const ledger = await desk();
  await ledger.ingestRecord(OPENED, 'replay');
  await ledger.ingestRecord(HANDOFF, 'replay');

  const l2 = part(ledger, 'L2');
  assert.equal(l2.pending, true);
  assert.equal(l2.currentTeam, '供热');
  assert.equal(l2.ticket, 'T-81');
  assert.deepEqual(ledger.view().pendingAcceptance.map(item => item.part), ['L2']);

  // 原企业末次补报不能把已交接的分项关回去。
  await ledger.ingestRecord({
    offset: 13, type: 'resolved', office: 'water', ticket: 'W-51', parts: ['L1', 'L2', 'L3'], finding: '临时止漏',
  }, 'live');
  assert.equal(part(ledger, 'L2').resolutions.length, 0);
  assert.deepEqual(part(ledger, 'L1').activeResolution.finding, '临时止漏');
  assert.deepEqual(part(ledger, 'L3').activeResolution.finding, '临时止漏');
  assert.ok(ledger.view().notes.some(note => note.kind === '末次补报不关单'));

  await ledger.ingestRecord({ ...ACCEPT, offset: 12 }, 'live');
  assert.equal(part(ledger, 'L2').pending, false);
  assert.equal(ledger.view().pendingAcceptance.length, 0);
});

test('先看到接收、后看到转出，凭据一到就接到原分项', async () => {
  const ledger = await desk();
  await ledger.ingestRecord({ ...ACCEPT, offset: 11 }, 'live');
  assert.equal(part(ledger, 'L2').ticket, null, '没有凭据的接收记录不能认领分项');

  await ledger.ingestRecord(OPENED, 'replay');
  await ledger.ingestRecord(HANDOFF, 'replay');
  const l2 = part(ledger, 'L2');
  assert.equal(l2.currentTeam, '供热');
  assert.equal(l2.ticket, 'T-81');
  assert.equal(l2.pending, false);
  assert.equal(l2.handoffs[0].status, '对方已确认承接');
  // 只认转出记录里明确承接的分项。
  assert.equal(part(ledger, 'L1').ticket, 'W-51');
  assert.equal(part(ledger, 'L3').ticket, 'W-51');
});

test('一张单拆给两家：另一家的处理记录不影响已交接的分项', async () => {
  const ledger = await desk();
  for (const record of [OPENED, HANDOFF, { ...ACCEPT, offset: 11 }]) {
    await ledger.ingestRecord(record, 'replay');
  }
  await ledger.ingestRecord({ offset: 12, type: 'resolved', office: 'heat', ticket: 'T-81', parts: ['L2'], finding: '阀门调校' }, 'live');
  assert.equal(part(ledger, 'L2').activeResolution.finding, '阀门调校');
  // 供水对同一张单里自己分项的处理记录，不把供热分项一起关掉。
  await ledger.ingestRecord({ offset: 14, type: 'resolved', office: 'water', ticket: 'W-51', parts: ['L1', 'L2', 'L3'], finding: '临时止漏' }, 'live');
  assert.equal(part(ledger, 'L2').activeResolution.finding, '阀门调校');
  assert.equal(part(ledger, 'L1').activeResolution.finding, '临时止漏');
});

test('过程记录重复投递只算一次，实时与补领同一偏移不重复入账', async () => {
  const ledger = await desk();
  for (const record of [OPENED, HANDOFF, { ...ACCEPT, offset: 11 }]) {
    await ledger.ingestRecord(record, 'replay');
    await ledger.ingestRecord(record, 'live');
    await ledger.ingestRecord(record, 'replay');
  }
  const view = ledger.view();
  assert.equal(view.parts.find(item => item.id === 'L2').handoffs.length, 1);
  assert.equal(view.parts.find(item => item.id === 'L2').activeResolution, null);
  assert.equal(ledger.state.records.length, 3);
  assert.equal(view.counters['offset:10'], 3);
});

test('没有凭据可判归属时直接给出矛盾的两个企业编号', async () => {
  const ledger = await desk();
  await ledger.ingestRecord({ offset: 20, type: 'opened', office: 'heat', ticket: 'T-82', parts: ['L2'] }, 'live');
  await ledger.ingestRecord({ offset: 21, type: 'opened', office: 'water', ticket: 'W-52', parts: ['L2'] }, 'live');
  const view = ledger.view();
  assert.equal(view.conflicts.length, 1);
  const conflict = view.conflicts[0];
  assert.equal(conflict.part, 'L2');
  assert.deepEqual(conflict.tickets.map(item => item.ticket).sort(), ['T-82', 'W-52']);
  assert.deepEqual(conflict.tickets.map(item => item.officeName).sort(), ['供水', '供热']);
  assert.match(conflict.message, /需要核实/);
});

test('转出没有关联凭据时不改归属，留待核实', async () => {
  const ledger = await desk();
  await ledger.ingestRecord(OPENED, 'replay');
  assert.equal(part(ledger, 'L3').ticket, 'W-51');
  await ledger.ingestRecord({
    offset: 30, type: 'handed_off', office: 'water', ticket: 'W-51', parts: ['L3'], nextOffice: 'heat', nextTicket: 'T-83',
  }, 'replay');
  const l3 = part(ledger, 'L3');
  assert.equal(l3.ticket, 'W-51');
  assert.equal(l3.currentTeam, '供水');
  assert.equal(l3.pending, false);
  assert.ok(ledger.view().notes.some(note => note.kind === '转出无凭据'));
});

test('企业补来能改变结论的说明：标记结论变化并保留更正前后依据', async () => {
  const ledger = await desk();
  for (const record of [OPENED, HANDOFF, { ...ACCEPT, offset: 11 },
    { offset: 12, type: 'resolved', office: 'heat', ticket: 'T-81', parts: ['L2'], finding: '阀门调校' }]) {
    await ledger.ingestRecord(record, 'replay');
  }
  await ledger.ingestFindings({
    records: [{ id: 'F-71', ticket: 'T-81', part: 'L2', replacesOffset: 12, finding: '支管压差尚待复测' }],
  });
  const l2 = part(ledger, 'L2');
  assert.equal(l2.activeResolution, null);
  assert.equal(l2.resolutions.length, 1);
  assert.equal(l2.resolutions[0].active, false);
  assert.equal(l2.resolutions[0].finding, '阀门调校');
  assert.equal(l2.findings.length, 1);
  assert.equal(l2.findings[0].supersedes, '阀门调校');
  assert.ok(ledger.view().notes.some(note => note.kind === '处理结论可能变化'));
});

test('回告身份一经登记不能换内容重发', async () => {
  const ledger = await desk();
  for (const record of [OPENED, HANDOFF, { ...ACCEPT, offset: 11 }]) {
    await ledger.ingestRecord(record, 'replay');
  }
  const first = await ledger.registerReply({ partId: 'L2', requestKey: 'REQ-1', text: '已处理' });
  assert.equal(first.state, '待发送');
  const again = await ledger.registerReply({ partId: 'L2', requestKey: 'REQ-1', text: '已处理' });
  assert.equal(again.requestKey, 'REQ-1');
  assert.throws(() => ledger.registerReply({ partId: 'L2', requestKey: 'REQ-1', text: '另一段' }), /不能换身份重发/);
  await ledger.recordAccepted('REQ-1', 'R-1');
  assert.throws(() => ledger.registerReply({ partId: 'L2', requestKey: 'REQ-2', text: '已处理' }), /必须引用/);
  assert.throws(() => ledger.registerReply({ partId: 'L2', requestKey: 'REQ-3', text: '补充', priorReceipt: 'R-404' }), /找不到回执/);
  const supplementary = await ledger.registerReply({
    partId: 'L2', requestKey: 'REQ-4', text: '补充：已处理，支管压差尚待复测', priorReceipt: 'R-1',
  });
  assert.equal(supplementary.source.priorReply.receipt, 'R-1');
  assert.ok(supplementary.source.ticket);
});

test('对方尚未确认承接到位时，新工单的处理记录先暂存并继续提醒催接', async () => {
  const ledger = await desk();
  await ledger.ingestRecord(OPENED, 'replay');
  await ledger.ingestRecord(HANDOFF, 'replay');
  await ledger.ingestRecord({ offset: 40, type: 'resolved', office: 'heat', ticket: 'T-81', parts: ['L2'], finding: '供热已处理' }, 'live');
  const l2 = part(ledger, 'L2');
  assert.equal(l2.pending, true);
  assert.equal(l2.activeResolution.finding, '供热已处理');
  assert.ok(ledger.view().notes.some(note => note.kind === '待承接期间的处理记录'));
  assert.deepEqual(ledger.view().pendingAcceptance.map(item => item.part), ['L2']);

  await ledger.ingestRecord({ ...ACCEPT, offset: 41 }, 'live');
  assert.equal(part(ledger, 'L2').pending, false);
  assert.equal(part(ledger, 'L2').activeResolution.finding, '供热已处理');
});

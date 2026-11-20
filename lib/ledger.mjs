// 联办台账：把来源资料归并成「每个分项由谁接手、依据是什么」，并持久化。
// 这里不做 HTTP 编排，只接受已经取回的资料片段。
//
// 归属依据只有三类，其余一律只作登记、不改变归属：
//   1. 热线派发（无企业工单号，只有承办单位）；
//   2. 企业开单记录按分项号作出的申报（只在该单位本就是派发对象时采信）；
//   3. 企业给出的关联凭据 handoff：把目标工单接到原分项，转出方原工单随之失去该分项。

import { randomUUID } from 'node:crypto';

export const OPEN = '待接手';
export const ACCEPTED = '已接手';
export const RESOLVED = '已处理';
export const DEFERRED = '待核实';

const ENTITY_NAMES = { water: '供水', heat: '供热' };

export function teamName(office) {
  return ENTITY_NAMES[office] ?? office ?? '未指明单位';
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

export class Ledger {
  constructor({ store = null, clock = now } = {}) {
    this.store = store;
    this.clock = clock;
    this.state = {
      caseId: null,
      affectedScope: null,
      parts: {},
      counters: { live: 0, replay: 0, findings: 0 },
      records: [],
      repeats: [],
      findings: {},
      conflicts: [],
      notes: [],
      replies: {},
      updatedAt: null,
    };
  }

  static async load(store) {
    const ledger = new Ledger({ store });
    const saved = await store.read();
    if (saved && saved.caseId) ledger.state = saved;
    return ledger;
  }

  snapshot() {
    return clone(this.state);
  }

  #save() {
    this.state.updatedAt = this.clock();
    return this.store ? this.store.write(this.snapshot()) : Promise.resolve();
  }

  #part(id) {
    const part = this.state.parts[id];
    if (!part) throw new Error('分项 ' + id + ' 尚未从热线任务读取');
    return part;
  }

  #note(kind, message, detail = {}) {
    this.state.notes.push({ at: this.clock(), kind, message, ...clone(detail) });
    if (this.state.notes.length > 500) this.state.notes.splice(0, this.state.notes.length - 500);
  }

  // ── 热线任务 ──────────────────────────────────────────────

  ingestDispatch(document) {
    if (!document || !Array.isArray(document.parts) || !document.caseId) {
      throw new Error('热线任务缺少 caseId 或分项');
    }
    if (this.state.caseId && this.state.caseId !== document.caseId) {
      throw new Error('该台账已登记诉求 ' + this.state.caseId + '，不能改挂 ' + document.caseId);
    }
    this.state.caseId = document.caseId;
    if (document.affectedScope) this.state.affectedScope = document.affectedScope;
    for (const incoming of document.parts) {
      const existing = this.state.parts[incoming.id];
      if (existing) {
        // 住址和类别只供核对；热线改派才改写归属，原有轨迹保留。
        existing.service = incoming.service;
        existing.scope = this.state.affectedScope;
        if (existing.dispatchedOffice !== incoming.operator) {
          const previous = existing.dispatchedOffice;
          existing.dispatchedOffice = incoming.operator;
          existing.history.push({
            at: this.clock(), type: 'redispatched', office: incoming.operator,
            reason: '热线重新派发（原派发对象 ' + teamName(previous) + '）',
          });
          if (!existing.current?.ticket) {
            existing.current = { office: incoming.operator, ticket: null, basis: '热线重新派发' };
          } else if (existing.current.office !== incoming.operator) {
            // 热线改派但旧工单还在办：保留在办工单，同时把新承办单位列为待催接对象。
            existing.current.pending = true;
            existing.current.expectedOffice = incoming.operator;
            existing.current.pendingReason = '热线改派，待新承办单位接单';
            existing.current.basis = '热线改派 ' + teamName(incoming.operator) + '，但在办工单 ' +
              existing.current.ticket + ' 仍挂在' + teamName(existing.current.office) + '名下，待核实';
            this.#note('改派与在办工单不一致', '分项 ' + incoming.id + ' 热线改派给' +
              teamName(incoming.operator) + '，但在办工单 ' + existing.current.ticket + ' 仍在' +
              teamName(existing.current.office) + '，需要核实由谁继续办理。', {
              part: incoming.id, ticket: existing.current.ticket,
            });
          }
        }
        continue;
      }
      this.state.parts[incoming.id] = {
        id: incoming.id,
        service: incoming.service,
        scope: this.state.affectedScope,
        dispatchedOffice: incoming.operator,
        current: { office: incoming.operator, ticket: null, basis: '热线派发' },
        handoffs: [],
        knownTickets: [],
        resolutions: {},
        history: [{
          at: this.clock(), type: 'dispatched', office: incoming.operator, reason: '热线派发',
        }],
      };
    }
    this.#settle();
    return this.#save();
  }

  // ── 企业过程记录 ──────────────────────────────────────────

  // 记录键只取投递偏移：实时页和补领区间会重复给出同一条记录，重复投递次数另行累计。
  ingestRecord(record, flow) {
    if (!record || typeof record.offset !== 'number' || !record.type) {
      throw new Error('企业记录缺少 offset 或 type');
    }
    if (flow !== 'live' && flow !== 'replay') throw new Error('flow 应为 live 或 replay');
    const key = 'offset:' + record.offset;
    const repeated = this.state.records.some(entry => entry.key === key);
    if (repeated) {
      this.state.counters[key] = (this.state.counters[key] ?? 1) + 1;
      this.state.repeats.push({ flow, offset: record.offset, at: this.clock() });
      return this.#save();
    }
    this.state.counters[key] = 1;
    this.state.records.push({ key, flow, record: clone(record), applied: false, at: this.clock() });
    this.#settle();
    return this.#save();
  }

  ingestFindings(document) {
    const records = Array.isArray(document?.records) ? document.records : [];
    for (const finding of records) {
      if (!finding?.id || !finding.ticket) continue;
      const part = this.#findPartForTicket(finding.ticket);
      if (!part) {
        this.#note('证据未归属', '证据 ' + finding.id + '（工单 ' + finding.ticket + '）接不回本诉求分项。', {
          evidence: finding.id, ticket: finding.ticket,
        });
        continue;
      }
      this.state.counters.findings += 1;
      const superseded = finding.replacesOffset == null ? null : part.resolutions[finding.replacesOffset];
      if (superseded) superseded.active = false;
      this.state.findings[finding.id] = {
        id: finding.id,
        ticket: finding.ticket,
        part: finding.part ?? part.id,
        replacesOffset: finding.replacesOffset ?? null,
        finding: finding.finding,
        supersedes: superseded?.finding ?? null,
        recordedAt: this.clock(),
      };
      part.history.push({
        at: this.clock(), type: 'finding', evidence: finding.id, ticket: finding.ticket,
        finding: finding.finding, replacesOffset: finding.replacesOffset ?? null,
        reason: '企业补充说明（可能改变处理结论）',
      });
      this.#note('处理结论可能变化', '证据 ' + finding.id + ' 补充：' + finding.finding +
        '。若该分项已回告「已处理」，需要一条可确认的补充回告。', {
        part: part.id, evidence: finding.id, replacesOffset: finding.replacesOffset ?? null,
      });
    }
    this.#settle();
    return this.#save();
  }

  #findPartForTicket(ticket) {
    return Object.values(this.state.parts).find(part =>
      part.knownTickets.includes(ticket) || part.current?.ticket === ticket ||
      Object.values(part.resolutions).some(item => item.ticket === ticket));
  }

  // 重放未归属记录，直到没有再能接上的；然后重算矛盾。按投递偏移顺序重放，
  // 这样同批资料里的转出会排在接收之后，不会被较早的接收记录挡住。
  #settle() {
    const pending = () => this.state.records.filter(entry => !entry.applied)
      .sort((a, b) => a.record.offset - b.record.offset);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const entry of pending()) {
        if (this.#apply(entry.record, entry.flow)) {
          entry.applied = true;
          progressed = true;
        }
      }
    }
    this.#checkConflicts();
  }

  #apply(record, flow) {
    switch (record.type) {
      case 'opened': return this.#open(record, flow);
      case 'handed_off': return this.#handOff(record, flow);
      case 'accepted': return this.#accept(record, flow);
      case 'resolved': return this.#resolve(record, flow);
      default:
        this.#note('未知记录', '企业记录类型 ' + record.type + ' 未识别。', { flow, offset: record.offset });
        return true;
    }
  }

  #claimed(record) {
    return Array.isArray(record.parts)
      ? record.parts.filter(id => Object.hasOwn(this.state.parts, id))
      : [];
  }

  #open(record, flow) {
    if (!record.ticket) return false;
    const claimed = this.#claimed(record);
    if (claimed.length === 0) return false;
    if (claimed.some(id => this.state.parts[id].knownTickets.includes(record.ticket))) return true;
    const touched = [];
    for (const id of claimed) {
      const part = this.state.parts[id];
      // 企业开单只说明这张单涉及哪些分项，不等于归属；归属仍以热线派发或转出凭据为准。
      if (!part.current?.ticket && part.current?.office === record.office) {
        part.current = { office: record.office, ticket: record.ticket, basis: '企业开单（与热线派发一致）' };
        if (!part.knownTickets.includes(record.ticket)) part.knownTickets.push(record.ticket);
        touched.push(id);
      }
      part.history.push({
        at: this.clock(), type: 'opened', office: record.office, ticket: record.ticket,
        flow, offset: record.offset, reason: '企业开单',
      });
    }
    // 未被派给该单位的分项不据此归属，只登记为该工单的申报范围。
    const extra = claimed.filter(id => this.state.parts[id].dispatchedOffice !== record.office);
    if (extra.length) {
      this.#note('开单范围与派发不一致', '工单 ' + record.ticket + ' 申报包含分项 ' + extra.join('、') +
        '，但热线未将这些分项派给' + teamName(record.office) + '，未据此改写归属。', {
        flow, offset: record.offset, ticket: record.ticket, parts: extra,
      });
    }
    return touched.length > 0 || extra.length > 0;
  }

  // 转出只结束原企业责任；分项留在跟进清单上等对方确认。
  #handOff(record, flow) {
    if (!record.ticket || !record.handoff) {
      if (record.ticket && this.#claimed(record).length) {
        this.#note('转出无凭据', '工单 ' + record.ticket + ' 的转出记录没有关联凭据，不能据此改变分项归属。', {
          flow, offset: record.offset, ticket: record.ticket, parts: this.#claimed(record),
          office: record.office,
        });
        return true;
      }
      return false;
    }
    const claimed = this.#claimed(record);
    // 转出范围以记录的 parts 为准：同一张单往往只转出其中几项。
    const touched = claimed.length
      ? claimed.filter(id => {
        const part = this.state.parts[id];
        return part.current?.ticket === record.ticket ||
          part.knownTickets.includes(record.ticket) ||
          part.current?.office === record.office ||
          part.current?.office === record.nextOffice;
      })
      : Object.values(this.state.parts).filter(part =>
        part.current?.ticket === record.ticket).map(part => part.id);
    if (touched.length === 0) return false;

    for (const id of touched) {
      const part = this.state.parts[id];
      if (!part.knownTickets.includes(record.ticket)) part.knownTickets.push(record.ticket);
      let handoff = part.handoffs.find(item => item.proof === record.handoff);
      if (!handoff) {
        handoff = {
          proof: record.handoff,
          fromOffice: record.office,
          fromTicket: record.ticket,
          nextOffice: record.nextOffice ?? null,
          nextTicket: record.nextTicket ?? null,
          at: this.clock(),
          status: record.nextTicket || record.nextOffice ? '待对方确认承接' : '未指明承接方',
          acceptedBy: null,
          acceptedTicket: null,
          seenIn: [{ flow, offset: record.offset, source: 'handed_off' }],
        };
        part.handoffs.push(handoff);
      } else {
        handoff.seenIn.push({ flow, offset: record.offset, source: 'handed_off' });
      }
      if (!handoff.nextOffice && record.nextOffice) handoff.nextOffice = record.nextOffice;
      if (!handoff.nextTicket && record.nextTicket) handoff.nextTicket = record.nextTicket;
      part.history.push({
        at: handoff.at, type: 'handed_off', office: record.office, ticket: record.ticket,
        proof: record.handoff, nextOffice: handoff.nextOffice, nextTicket: handoff.nextTicket,
        flow, offset: record.offset, reason: '原企业转出（仅结束原企业责任）',
      });
      if (part.current?.ticket === record.ticket || part.current?.office === record.office ||
        part.current?.office === handoff.nextOffice) {
        part.current = {
          office: handoff.nextOffice ?? record.office,
          ticket: handoff.nextTicket ?? null,
          basis: '凭据 ' + handoff.proof + ' 转出，待对方确认承接',
          expectedOffice: handoff.nextOffice ?? null,
          pendingReason: '转出后待对方确认承接',
          pending: true,
        };
      }
      const accepted = part.handoffs.find(item => item.proof === record.handoff && item.acceptedBy);
      if (accepted) {
        part.current = {
          office: accepted.acceptedBy,
          ticket: accepted.acceptedTicket,
          basis: '凭据 ' + handoff.proof + '，对方已确认承接',
        };
        handoff.status = '对方已确认承接';
        handoff.acceptedBy = accepted.acceptedBy;
        handoff.acceptedTicket = accepted.acceptedTicket;
      }
    }
    return true;
  }

  // 接收记录可以早于转出记录出现；凭据一到就重放核对。
  #accept(record, flow) {
    if (!record.ticket || !record.handoff) return false;
    // 只有凭据把该目标工单接到原分项，接收记录才改归属。
    // 仅凭「工单里写了分项号、单位又恰好是派发对象」不足以认领，那可能是别的诉求。
    const claimed = this.#claimed(record);
    const matched = [];
    for (const part of Object.values(this.state.parts)) {
      const handoff = part.handoffs.find(item => item.proof === record.handoff);
      if (!handoff) continue;
      if (claimed.length && !claimed.includes(part.id)) continue;
      if (handoff.nextTicket && handoff.nextTicket !== record.ticket) continue;
      if (handoff.nextOffice && handoff.nextOffice !== record.office) continue;
      matched.push({ part, handoff });
    }
    if (matched.length === 0) return false;

    for (const { part, handoff } of matched) {
      if (!part.knownTickets.includes(record.ticket)) part.knownTickets.push(record.ticket);
      if (handoff) {
        handoff.acceptedBy = record.office;
        handoff.acceptedTicket = record.ticket;
        handoff.status = '对方已确认承接';
        if (!handoff.nextOffice) handoff.nextOffice = record.office;
        if (!handoff.nextTicket) handoff.nextTicket = record.ticket;
        if (!handoff.seenIn.some(item => item.source === 'accepted')) {
          handoff.seenIn.push({ flow, offset: record.offset, source: 'accepted' });
        }
      }
      part.current = {
        office: record.office,
        ticket: record.ticket,
        basis: handoff
          ? '凭据 ' + record.handoff + '，对方已确认承接'
          : '企业接收记录（与热线派发一致）',
      };
      part.history.push({
        at: this.clock(), type: 'accepted', office: record.office, ticket: record.ticket,
        proof: record.handoff, flow, offset: record.offset,
        reason: handoff ? '对方确认承接' : '企业接收记录',
      });
    }
    return true;
  }

  // 只有当前持有该分项的企业，其处理记录才能改变处理结论。
  #resolve(record, flow) {
    if (!record.ticket) return false;
    const claimed = this.#claimed(record);
    const known = claimed.length
      ? claimed.map(id => this.state.parts[id])
      : Object.values(this.state.parts).filter(part => part.knownTickets.includes(record.ticket));
    if (known.length === 0) return false;
    for (const part of known) {
      if (part.current?.ticket !== record.ticket) {
        // 原企业末次补报只能关自己当前持有的分项。
        part.history.push({
          at: this.clock(), type: 'resolve_ignored', office: record.office, ticket: record.ticket,
          flow, offset: record.offset,
          reason: '原企业末次补报不改变已交接分项的归属',
        });
        this.#note('末次补报不关单', '分项 ' + part.id + ' 已不在工单 ' + record.ticket +
          ' 名下，' + teamName(record.office) + ' 的末次补报不改变其结论。', {
          part: part.id, flow, offset: record.offset, ticket: record.ticket,
        });
        continue;
      }
      if (part.current.pending) {
        // 新工单已经报处理、凭据也对上了，只是接收记录还没看到：仍要提醒催接，
        // 但处理说明可以先核对，不能因此把关单记录丢掉。
        part.current.pendingReason = part.current.pendingReason ?? '转出后待对方确认承接';
        this.#note('待承接期间的处理记录', '分项 ' + part.id + ' 仍待 ' +
          teamName(part.current.expectedOffice ?? part.current.office) +
          ' 确认承接，先暂存 ' + teamName(record.office) + ' 工单 ' + record.ticket + ' 的处理记录。', {
          part: part.id, flow, offset: record.offset, ticket: record.ticket,
        });
      }
      if (part.resolutions[record.offset]) continue;
      part.resolutions[record.offset] = {
        offset: record.offset,
        at: this.clock(),
        office: record.office,
        ticket: record.ticket,
        finding: record.finding ?? null,
        flow,
        active: true,
      };
      part.history.push({
        at: this.clock(), type: 'resolved', office: record.office, ticket: record.ticket,
        finding: record.finding ?? null, flow, offset: record.offset,
        reason: '企业处理记录（业务结论待值班员核对）',
      });
    }
    return true;
  }

  // 同一分项被两个企业编号同时声称、却没有可判定的凭据时，把矛盾摆到值班员面前。
  #checkConflicts() {
    const conflicts = [];
    for (const part of Object.values(this.state.parts)) {
      const holders = new Set(part.knownTickets);
      if (part.current?.ticket) holders.add(part.current.ticket);
      const claims = new Map();
      for (const entry of this.state.records) {
        const { record } = entry;
        if (!record.ticket || !this.#claimed(record).includes(part.id)) continue;
        const office = record.office ?? record.nextOffice;
        if (!office) continue;
        const known = claims.get(record.ticket);
        if (!known) {
          claims.set(record.ticket, {
            office,
            officeName: teamName(office),
            ticket: record.ticket,
            proof: record.handoff ?? null,
            type: record.type,
            explained: holders.has(record.ticket),
          });
        } else if (!known.proof && record.handoff) {
          known.proof = record.handoff;
        }
      }
      const unexplained = [...claims.values()].filter(claim => !claim.explained);
      const explained = [...claims.values()].filter(claim => claim.explained);
      if (unexplained.length === 0) continue;
      // 一张有凭据的工单 + 一张来路不明的工单，或两张互相矛盾的无凭据工单。
      if (explained.length === 0 && unexplained.length < 2) continue;
      const shown = [...explained.slice(0, 1), ...unexplained].slice(0, 4);
      conflicts.push({
        key: part.id + ':' + shown.map(item => item.ticket).sort().join(','),
        at: this.clock(),
        part: part.id,
        service: part.service,
        scope: part.scope,
        tickets: shown.map(item => ({
          office: item.office, officeName: item.officeName, ticket: item.ticket,
          proof: item.proof, explained: item.explained,
        })),
        message: '分项 ' + part.id + '（' + part.service + '）没有可判定的承接凭据：' +
          shown.map(item => item.officeName + ' ' + item.ticket).join(' 与 ') +
          ' 同时指向该分项，需要核实。',
      });
    }
    this.state.conflicts = conflicts;
  }

  // ── 查询视图 ──────────────────────────────────────────────

  partView(part) {
    const resolutions = Object.values(part.resolutions).sort((a, b) => a.offset - b.offset);
    const findings = Object.values(this.state.findings).filter(item => item.part === part.id);
    return {
      id: part.id,
      service: part.service,
      scope: part.scope,
      dispatchedOffice: part.dispatchedOffice,
      dispatchedTeam: teamName(part.dispatchedOffice),
      currentOffice: part.current?.office ?? null,
      currentTeam: teamName(part.current?.office),
      ticket: part.current?.ticket ?? null,
      basis: part.current?.basis ?? null,
      pending: Boolean(part.current?.pending),
      pendingReason: part.current?.pendingReason ?? null,
      expectedOffice: part.current?.expectedOffice ?? null,
      expectedTeam: part.current?.expectedOffice ? teamName(part.current.expectedOffice) : null,
      status: part.current?.pending ? DEFERRED : part.current?.ticket ? ACCEPTED : OPEN,
      handoffs: clone(part.handoffs),
      resolutions: clone(resolutions),
      activeResolution: clone(resolutions.filter(item => item.active).at(-1) ?? null),
      findings: clone(findings),
      history: clone(part.history),
    };
  }

  view() {
    return {
      caseId: this.state.caseId,
      affectedScope: this.state.affectedScope,
      parts: Object.values(this.state.parts).map(part => this.partView(part)),
      pendingAcceptance: this.pendingAcceptance(),
      conflicts: clone(this.state.conflicts),
      notes: clone(this.state.notes),
      replies: Object.values(this.state.replies).map(reply => clone(reply)),
      // 接不回本诉求分项的企业记录：单看一条不构成矛盾，但值班员需要知道它们没有计入归属。
      unattributed: this.state.records.filter(entry => !entry.applied).map(entry => ({
        flow: entry.flow,
        offset: entry.record.offset,
        type: entry.record.type,
        office: entry.record.office ?? null,
        ticket: entry.record.ticket ?? null,
        parts: entry.record.parts ?? [],
      })),
      counters: clone(this.state.counters),
      updatedAt: this.state.updatedAt,
    };
  }

  pendingAcceptance() {
    return Object.values(this.state.parts).filter(part => part.current?.pending).map(part => ({
      part: part.id,
      service: part.service,
      expectedOffice: part.current.expectedOffice ?? part.current.office,
      expectedTeam: teamName(part.current.expectedOffice ?? part.current.office),
      basis: part.current.basis,
      reason: part.current.pendingReason ?? '转出后待对方确认承接',
    }));
  }

  // ── 回告 ─────────────────────────────────────────────────

  registerReply({ partId, requestKey, text, priorReceipt = null }) {
    const part = this.#part(partId);
    if (!requestKey || !text) throw new Error('回告需要回告身份和正文');
    const existing = this.state.replies[requestKey];
    if (existing) {
      if (existing.partId !== partId || existing.text !== text || existing.priorReceipt !== priorReceipt) {
        throw new Error('回告身份 ' + requestKey + ' 已用于不同内容，不能换身份重发');
      }
      return existing;
    }
    if (priorReceipt) {
      const prior = Object.values(this.state.replies).find(reply => reply.receipt === priorReceipt);
      if (!prior) throw new Error('找不到回执号 ' + priorReceipt + ' 对应的原回告');
      if (prior.partId !== partId) throw new Error('回执 ' + priorReceipt + ' 属于分项 ' + prior.partId + '，不能用于分项 ' + partId);
      if (!prior.receiptOpen) throw new Error('原回告 ' + priorReceipt + ' 的回执尚未可查，不能据此补发');
    } else if (this.#jobDoneReply(partId)) {
      throw new Error('分项 ' + partId + ' 已有「已处理」回告 ' + this.#jobDoneReply(partId).requestKey +
        '，补充回告必须引用其回执号');
    }
    const reply = {
      requestKey,
      partId,
      text,
      priorReceipt,
      state: '待发送',
      receipt: null,
      receiptOpen: false,
      attempts: [],
      createdAt: this.clock(),
      sentAt: null,
      acceptedAt: null,
      source: clone(this.#replyBasis(partId, priorReceipt)),
    };
    this.state.replies[requestKey] = reply;
    part.history.push({
      at: reply.createdAt, type: 'reply_drafted', requestKey,
      reason: priorReceipt
        ? '补充回告（引用 ' + priorReceipt + '）'
        : '分项回告',
    });
    return this.#save().then(() => reply);
  }

  // 「已处理」是否已经送回热线。没有回执的回告不算送出，也就还允许按普通回告重发。
  #jobDoneReply(partId) {
    return Object.values(this.state.replies).find(reply =>
      reply.partId === partId && Boolean(reply.receipt) && reply.text.includes('已处理')) ?? null;
  }

  #replyBasis(partId, priorReceipt) {
    const part = this.state.parts[partId];
    const prior = priorReceipt
      ? Object.values(this.state.replies).find(reply => reply.receipt === priorReceipt)
      : null;
    return {
      part: partId,
      service: part.service,
      scope: part.scope,
      currentOffice: part.current?.office ?? null,
      ticket: part.current?.ticket ?? null,
      basis: part.current?.basis ?? null,
      activeResolution: Object.values(part.resolutions).filter(item => item.active).at(-1) ?? null,
      findings: Object.values(this.state.findings).filter(item => item.part === partId),
      priorReply: prior ? { requestKey: prior.requestKey, receipt: prior.receipt, text: prior.text } : null,
      capturedAt: this.clock(),
    };
  }

  findReply({ requestKey, receipt }) {
    if (requestKey) return this.state.replies[requestKey] ?? null;
    return Object.values(this.state.replies).find(reply => reply.receipt === receipt) ?? null;
  }

  recordAttempt(requestKey, outcome) {
    const reply = this.state.replies[requestKey];
    if (!reply) throw new Error('未登记的回告身份 ' + requestKey);
    reply.attempts.push({ at: this.clock(), ...clone(outcome) });
    if (outcome.kind === 'network' || outcome.kind === 'unknown') reply.state = '发送中断';
    return this.#save();
  }

  recordAccepted(requestKey, receipt) {
    const reply = this.state.replies[requestKey];
    if (!reply) throw new Error('未登记的回告身份 ' + requestKey);
    if (reply.receipt && reply.receipt !== receipt) {
      throw new Error('回告身份 ' + requestKey + ' 已有回执 ' + reply.receipt + '，来源却给出 ' + receipt);
    }
    reply.state = '已受理';
    reply.receipt = receipt;
    reply.receiptOpen = true;
    reply.acceptedAt = this.clock();
    this.state.parts[reply.partId].history.push({
      at: reply.acceptedAt, type: 'reply_accepted', requestKey, receipt, reason: '热线已受理回告',
    });
    return this.#save();
  }

  recordReceiptOpen(requestKey) {
    const reply = this.state.replies[requestKey];
    if (!reply) throw new Error('未登记的回告身份 ' + requestKey);
    reply.receiptOpen = true;
    return this.#save();
  }

  markSent(requestKey) {
    const reply = this.state.replies[requestKey];
    if (!reply) throw new Error('未登记的回告身份 ' + requestKey);
    if (reply.state === '待发送') reply.sentAt = this.clock();
    reply.state = '已发送';
    return this.#save();
  }

  pendingReplies() {
    return Object.values(this.state.replies).filter(reply =>
      ['待发送', '发送中断', '已发送'].includes(reply.state));
  }

  newKey(prefix) {
    return prefix + '-' + randomUUID().slice(0, 8);
  }
}

// 演练编排：按阶段把来源资料取回台账。
// 企业实时页可能缺一段（missing），补领区间与实时页会有重复，
// 接收记录也可能比转出记录先出现，这些都交给台账去重与重放。

import { RemoteError } from './client.mjs';

export class Drill {
  constructor({ client, ledger, replies = null }) {
    this.client = client;
    this.ledger = ledger;
    this.replies = replies;
  }

  async pullDispatch(caseId = this.ledger.state.caseId) {
    if (!caseId) throw new Error('需要诉求号才能取派发任务');
    const document = await this.client.dispatch(caseId);
    await this.ledger.ingestDispatch(document);
    return document;
  }

  // live 页：一页一取，next 记作下次查询位置。来源尚未发布更后区间时以 404 结束，不算故障。
  async pullLive({ after = 0, pages = 1 } = {}) {
    let cursor = after;
    const gaps = [];
    const pulled = [];
    for (let page = 0; page < pages; page += 1) {
      let answer;
      try {
        answer = await this.client.live(cursor);
      } catch (error) {
        if (error instanceof RemoteError && error.status === 404) break;
        throw error;
      }
      for (const record of answer?.records ?? []) {
        pulled.push(record);
        await this.ledger.ingestRecord(record, 'live');
      }
      for (const gap of answer?.missing ?? []) gaps.push(gap);
      const next = answer?.next;
      if (typeof next !== 'number' || next <= cursor) break;
      cursor = next;
    }
    return { pulled, gaps, next: cursor };
  }

  // 补领时来源可能只发布了片段：404 表示该区间暂时没有可补领的记录，不是故障。
  async pullReplay(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
      throw new Error('补领区间应为闭区间 [from, to]');
    }
    let answer;
    try {
      answer = await this.client.replay(from, to);
    } catch (error) {
      if (error instanceof RemoteError && error.status === 404) return [];
      throw error;
    }
    for (const record of answer?.records ?? []) {
      await this.ledger.ingestRecord(record, 'replay');
    }
    return answer?.records ?? [];
  }

  async fillGaps(gaps) {
    const results = [];
    for (const [from, to] of gaps) results.push(await this.pullReplay(from, to));
    return results.flat();
  }

  async pullFindings() {
    const answer = await this.client.findings();
    await this.ledger.ingestFindings(answer);
    return answer?.records ?? [];
  }

  // 一次交班取数：热线任务 → 实时页 → 补领缺口 → 证据。顺序固定，便于复现。
  async sync({ caseId, after = 0, gaps = [] } = {}) {
    const dispatch = await this.pullDispatch(caseId);
    const live = await this.pullLive({ after });
    const wanted = [...gaps, ...live.gaps];
    const unique = [...new Map(wanted.map(pair => [pair.join(','), pair])).values()];
    const repaired = await this.fillGaps(unique);
    const findings = await this.pullFindings();
    return { dispatch, live, repaired, findings, view: this.ledger.view() };
  }
}

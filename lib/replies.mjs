// 回告投递：一个分项一份回告，回告身份由值班员发起时确定。
// 断线、超时、查询短暂只有「受理状态」时，都用同一个 requestKey 重试；
// 热线的受理记录按 requestKey 幂等，换身份重发会造成重复受理。

import { RemoteError } from './client.mjs';

export class ReplyService {
  constructor({ client, ledger, maxConfirmAttempts = 3, maxSendAttempts = 3, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    this.client = client;
    this.ledger = ledger;
    this.maxConfirmAttempts = maxConfirmAttempts;
    this.maxSendAttempts = maxSendAttempts;
    this.sleep = sleep;
  }

  async draft({ partId, text, priorReceipt = null, requestKey = null }) {
    const key = requestKey ?? this.ledger.newKey('REQ-' + (priorReceipt ? 'SUP' : 'RPL'));
    return this.ledger.registerReply({ partId, requestKey: key, text, priorReceipt });
  }

  async send(requestKey) {
    const reply = this.ledger.findReply({ requestKey });
    if (!reply) throw new Error('未登记的回告身份 ' + requestKey);
    if (reply.state === '已受理') return this.#result(reply);

    const body = {
      requestKey: reply.requestKey,
      caseId: this.ledger.state.caseId,
      part: reply.partId,
      text: reply.text,
    };
    if (reply.priorReceipt) body.priorReceipt = reply.priorReceipt;

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxSendAttempts; attempt += 1) {
      try {
        const answer = await this.client.submitReply(body);
        await this.ledger.recordAttempt(requestKey, {
          kind: 'response', attempt, state: answer?.state ?? null, receipt: answer?.receipt ?? null,
        });
        const receipt = answer?.receipt ?? null;
        if (answer?.state !== '待显示' && receipt) {
          await this.ledger.markSent(requestKey);
          await this.ledger.recordAccepted(requestKey, receipt);
          return this.#result(this.ledger.findReply({ requestKey }));
        }
        // 接受后连接可能断开；热线只回了「待显示」时先留着原身份，等服务端可见再追认。
        await this.ledger.recordAttempt(requestKey, { kind: 'accepted-pending-visibility', attempt });
        if (attempt < this.maxSendAttempts) {
          await this.sleep(0);
          continue;
        }
        await this.ledger.markSent(requestKey);
        return this.confirm(requestKey, { acceptPending: true });
      } catch (error) {
        lastError = error;
        const kind = error instanceof RemoteError && error.network ? 'network'
          : error instanceof RemoteError && error.status === 409 ? 'conflict' : 'error';
        await this.ledger.recordAttempt(requestKey, {
          kind, attempt, status: error.status ?? null, message: error.message,
        });
        if (kind === 'conflict') break;
        if (attempt < this.maxSendAttempts) await this.sleep(0);
      }
    }
    // 发送结果不明时，先用原身份查询，热线可能其实已经受理。
    const confirmed = await this.confirm(requestKey, { acceptPending: true });
    if (confirmed.state === '已受理') return confirmed;
    await this.ledger.markSent(requestKey);
    if (lastError) throw lastError;
    return confirmed;
  }

  // 以原身份查询受理编号。未进入可见阶段时只有「待显示」，不算失败，也不换身份。
  async confirm(requestKey, { acceptPending = false } = {}) {
    const reply = this.ledger.findReply({ requestKey });
    if (!reply) throw new Error('未登记的回告身份 ' + requestKey);
    let last = null;
    for (let attempt = 1; attempt <= this.maxConfirmAttempts; attempt += 1) {
      try {
        const answer = await this.client.readReply(requestKey);
        last = answer;
        if (answer?.state === '待显示') {
          await this.ledger.recordAttempt(requestKey, { kind: 'lookup-pending', attempt });
          if (attempt < this.maxConfirmAttempts) await this.sleep(0);
          continue;
        }
        if (answer?.receipt) {
          await this.ledger.recordAccepted(requestKey, answer.receipt);
          return this.#result(this.ledger.findReply({ requestKey }));
        }
        await this.ledger.recordAttempt(requestKey, { kind: 'lookup-unknown', attempt, state: answer?.state ?? null });
      } catch (error) {
        await this.ledger.recordAttempt(requestKey, {
          kind: 'lookup-error', attempt, status: error.status ?? null, message: error.message,
        });
        last = null;
      }
      if (attempt < this.maxConfirmAttempts) await this.sleep(0);
    }
    if (acceptPending) {
      const pending = this.ledger.findReply({ requestKey });
      return { ...this.#result(pending), awaitingReceipt: true, lastLookup: last };
    }
    return { ...this.#result(this.ledger.findReply({ requestKey })), awaitingReceipt: true, lastLookup: last };
  }

  // 交班或超时重跑：所有未拿到回执的回告都用原 requestKey 重投再追认。
  // 热线按 requestKey 幂等，重投不会产生第二份；先查询只是为了让已受理的少一次写入。
  async retryPending() {
    const results = [];
    for (const reply of this.ledger.pendingReplies()) {
      try {
        const confirmed = await this.confirm(reply.requestKey);
        results.push(confirmed.state === '已受理' ? confirmed : await this.send(reply.requestKey));
      } catch (error) {
        results.push({ requestKey: reply.requestKey, state: reply.state, error: error.message });
      }
    }
    return results;
  }

  #result(reply) {
    return {
      requestKey: reply.requestKey,
      part: reply.partId,
      state: reply.state,
      receipt: reply.receipt,
      priorReceipt: reply.priorReceipt,
      attempts: reply.attempts.length,
    };
  }
}

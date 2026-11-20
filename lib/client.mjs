// 演练接口客户端。只负责 HTTP 语义，不解释业务状态。

export class RemoteError extends Error {
  constructor(message, { status = null, body = null, network = false } = {}) {
    super(message);
    this.name = 'RemoteError';
    this.status = status;
    this.body = body;
    this.network = network;
  }
}

export function createClient({ baseUrl, fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function call(method, path, { body, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let response;
    let text;
    try {
      response = await fetchImpl(root + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      throw new RemoteError('来源连接中断：' + (error.message || error.name), { network: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      throw new RemoteError('来源返回 ' + response.status, { status: response.status, body: parsed });
    }
    return parsed;
  }

  return {
    request: call,
    dispatch: caseId => call('GET', '/dispatch/' + encodeURIComponent(caseId)),
    live: after => call('GET', '/enterprise/live?after=' + encodeURIComponent(after)),
    replay: (from, to) => call('GET', '/enterprise/replay?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)),
    findings: () => call('GET', '/enterprise/findings'),
    submitReply: (record, options) => call('POST', '/hotline/replies', { ...options, body: record }),
    readReply: requestKey => call('GET', '/hotline/replies?requestKey=' + encodeURIComponent(requestKey)),
  };
}

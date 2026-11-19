import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const fixture = JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url)));

function htmlEscape(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return String(value).replace(/[&<>"]/g, character => entities[character]);
}

function portalMarkup(title, body) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + htmlEscape(title) + '</title><style>' +
    'body{font:16px system-ui,sans-serif;margin:0;background:#f7f8f8;color:#182625}' +
    'main{max-width:1100px;margin:auto;padding:24px}nav{display:flex;flex-wrap:wrap;gap:16px;padding:16px 24px;background:#123b36}' +
    'nav a{color:#fff}h1{font-size:24px}h2{font-size:18px}.table{overflow:auto}' +
    'table{border-collapse:collapse;width:100%;background:white}td,th{border-bottom:1px solid #d6e0df;padding:10px 14px;text-align:left}' +
    'th{background:#e4efed}form{margin-block:22px;border-top:1px solid #d6e0df;padding-block:12px}' +
    'label{display:inline-grid;gap:5px;margin:0 12px 12px 0}input,button{font:inherit;padding:8px;box-sizing:border-box;max-width:100%}' +
    'button{background:#126354;color:white;border:0;border-radius:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere}' +
    'a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #b47510;outline-offset:3px}' +
    '</style><nav aria-label="门户">' + fixture.pages.map(page =>
      '<a href="' + htmlEscape(page.path) + '">' + htmlEscape(page.name) + '</a>').join('') +
    '</nav><main><h1>' + htmlEscape(title) + '</h1>' + body + '</main></html>';
}

function renderPage(page, phase) {
  const headings = page.headings.map(heading => '<th scope="col">' + htmlEscape(heading) + '</th>').join('');
  const rows = page.rows[phase].map(row => '<tr>' +
    row.map(cell => '<td>' + htmlEscape(cell) + '</td>').join('') + '</tr>').join('');
  const forms = page.forms.map(form => {
    const fields = Object.entries(form.fields).map(([id, label]) => '<label>' +
      htmlEscape(label) + '<input name="' + htmlEscape(id) + '" required></label>').join('');
    return '<form aria-label="' + htmlEscape(form.name) + '" method="' + (form.method || 'POST') +
      '" action="' + htmlEscape(form.path) + '"><h2>' + htmlEscape(form.name) + '</h2>' +
      fields + '<button type="submit">' + htmlEscape(form.name) + '</button></form>';
  }).join('');
  return portalMarkup(page.name, '<div class="table"><table><thead><tr>' + headings +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' + forms);
}

async function readBody(request) {
  let input = '';
  for await (const chunk of request) {
    input += chunk;
    if (input.length > 65536) throw new Error('请求正文超出限制');
  }
  if (request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(input));
  }
  return JSON.parse(input || '{}');
}

export function createSource() {
  let phase = 0;
  const receipts = new Map();
  const tickets = new Map();

  function stateOf(receipt) {
    if (receipt.released) return '已释放';
    if (receipt.pendingUntil > phase) return '待显示';
    if (!receipt.lease) return '已受理';
    const lease = receipt.lease;
    if (phase >= lease.promotedAt && receipt.body.area === lease.area && receipt.body.hall === lease.hall) {
      return '正式留座';
    }
    if (phase > receipt.issuedPhase && phase >= lease.expiresAt) return '已到期';
    return '临时锁定';
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const portal = Boolean(fixture.pages);
    function send(status, value, kind = 'json') {
      const types = { json: 'application/json', ndjson: 'application/x-ndjson', html: 'text/html' };
      const body = kind === 'ndjson' ? value.map(row => JSON.stringify(row)).join('\n') + '\n'
        : kind === 'json' ? JSON.stringify(value) : value;
      response.writeHead(status, { 'content-type': types[kind] + '; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    }
    function answer(status, value) {
      if (!portal) return send(status, value);
      const title = value.state || value.error || '门户回应';
      return send(status, portalMarkup(title, '<pre>' + htmlEscape(JSON.stringify(value, null, 2)) + '</pre>'), 'html');
    }
    function view(receipt) {
      const state = stateOf(receipt);
      if (state === '待显示') return { state };
      const detail = { state, receipt: receipt.id, submitted: receipt.body };
      if (receipt.lease) detail.validUntil = receipt.validUntil;
      return detail;
    }
    try {
      if (url.pathname === '/replay/phase' && request.method === 'POST') {
        const body = await readBody(request);
        if (body.phase !== 0 && body.phase !== 1) return send(400, { error: '演练阶段应为 0 或 1' });
        phase = body.phase;
        return send(200, { phase });
      }
      if (url.pathname === '/' && request.method === 'GET') {
        if (portal) {
          response.writeHead(303, { location: fixture.pages[0].path });
          return response.end();
        }
        return send(200, { name: fixture.label, phase });
      }
      const page = portal && fixture.pages.find(candidate => candidate.path === url.pathname);
      if (page && request.method === 'GET') return send(200, renderPage(page, phase), 'html');
      const route = fixture.routes.find(candidate => candidate.path === url.pathname &&
        candidate.method === request.method &&
        Object.entries(candidate.query || {}).every(([name, value]) => url.searchParams.get(name) === value));
      if (!route) return answer(404, { error: '查无来源资料' });
      const value = route.steps[phase];
      if (value.lookup) {
        const key = url.searchParams.get(value.key);
        const receipt = receipts.get(key);
        if (!receipt || receipt.namespace !== url.pathname.split('/').slice(0, -1).join('/')) {
          return answer(404, { error: '查无受理' });
        }
        return answer(200, view(receipt));
      }
      if (route.kind === 'ticket') {
        const token = url.searchParams.get('token');
        const ticket = tickets.get(token);
        if (!ticket || ticket.phase !== phase) return answer(410, { error: '领取票已失效' });
        const document = value.find(entry => entry.proof === ticket.proof && entry.revision === ticket.revision);
        if (!document) return answer(404, { error: '报告原件暂未发布' });
        tickets.delete(token);
        return send(200, document);
      }
      if (!value.fields) return send(route.status, value, route.kind);
      const body = await readBody(request);
      if (!body || value.fields.some(field => !Object.hasOwn(body, field) || body[field] === '')) {
        return answer(400, { error: '表单资料不全', fields: value.fields });
      }
      if (value.response === 'ticket') {
        const token = randomUUID();
        tickets.set(token, { proof: body.proof, revision: String(body.revision), phase });
        return send(201, { downloadPath: '/qc/documents?token=' + token });
      }
      const namespace = url.pathname.split('/').slice(0, -1).join('/');
      const prior = receipts.get(body.requestKey);
      if (prior) {
        if (prior.namespace !== namespace || JSON.stringify(prior.body) !== JSON.stringify(body)) {
          return answer(409, { error: '经办号对应不同的提交' });
        }
        return answer(200, view(prior));
      }
      if (value.response === 'release') {
        const lock = [...receipts.values()].find(item => item.id === body.priorReceipt && item.namespace === namespace);
        if (!lock || stateOf(lock) !== '临时锁定') return answer(409, { error: '原锁位无法释放' });
        lock.released = true;
      }
      const receipt = { body, namespace, id: 'R-' + randomUUID().slice(0, 8),
        pendingUntil: value.pendingUntil, lease: value.lease, issuedPhase: phase };
      if (value.lease) {
        const taken = [...receipts.values()].some(existing =>
          existing.namespace === namespace && existing.body.session === body.session && existing.body.hall === body.hall &&
          existing.body.area === body.area && ['临时锁定', '正式留座'].includes(stateOf(existing)));
        if (taken) return answer(409, { error: '该区域已有锁位' });
        const portalPage = fixture.pages.find(item => item.path === namespace);
        if (!portalPage.rows[phase].some(([session, hall, area, ...rest]) =>
          session === body.session && hall === body.hall && area === body.area && rest.at(-1) === '可锁')) {
          return answer(409, { error: '区域已变更或不可锁' });
        }
        receipt.validUntil = new Date(Date.UTC(2026, 10, 19, 5, phase * 15 + value.lease.minutes)).toISOString();
      }
      receipts.set(body.requestKey, receipt);
      if (value.drop && phase === 0) return request.socket.destroy();
      return answer(201, view(receipt));
    } catch (error) {
      return answer(400, { error: error.message });
    }
  });
}

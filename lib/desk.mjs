// 值班台：本机回环地址上的联办工作台。
// 页面只做两件事：把「每个分项现在归谁、依据是什么」摆出来，以及驱动联办/回告/交班。

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function markup(title, body) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escape(title) + '</title><style>' +
    'body{font:16px system-ui,sans-serif;margin:0;background:#f7f8f8;color:#182625}' +
    'main{max-width:1100px;margin:auto;padding:24px}h1{font-size:24px}h2{font-size:19px;margin-top:32px}' +
    'table{border-collapse:collapse;width:100%;background:white}' +
    'td,th{border-bottom:1px solid #d6e0df;padding:9px 12px;text-align:left;vertical-align:top}' +
    'th{background:#e4efed}.table{overflow:auto}' +
    'form{margin-block:18px;border-top:1px solid #d6e0df;padding-block:12px}' +
    'label{display:inline-grid;gap:5px;margin:0 12px 12px 0}' +
    'input,textarea,button{font:inherit;padding:8px;box-sizing:border-box;max-width:100%}' +
    'button{background:#126354;color:white;border:0;border-radius:4px;cursor:pointer}' +
    '.warn{background:#fff4e0;border-left:4px solid #b47510;padding:12px 14px;margin-block:12px}' +
    '.todo{background:#eef5ff;border-left:4px solid #1f5fa8;padding:12px 14px;margin-block:12px}' +
    '.muted{color:#4b5b59}code{background:#eef1f0;padding:1px 5px;border-radius:3px}' +
    'a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #b47510;outline-offset:3px}' +
    '</style><main><h1>' + escape(title) + '</h1>' + body + '</main></html>';
}

async function readJson(request) {
  let input = '';
  for await (const chunk of request) {
    input += chunk;
    if (input.length > 65536) throw new Error('请求正文超出限制');
  }
  if (!input) return {};
  if (request.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(input));
  }
  return JSON.parse(input);
}

function partRow(part) {
  const status = part.pending ? '待对方确认承接' : part.ticket ? '已接手' : '待接手';
  return '<tr><td>' + escape(part.id) + '<div class="muted">' + escape(part.service) + '</div></td>' +
    '<td>' + escape(part.dispatchedTeam) + (part.dispatchedTeam !== part.currentTeam ?
      ' <span class="muted">→ ' + escape(part.currentTeam) + '</span>' : '') + '</td>' +
    '<td>' + escape(part.ticket ?? '—') + '</td>' +
    '<td>' + escape(status) + '</td>' +
    '<td>' + escape(part.basis ?? '') + '</td>' +
    '<td>' + (part.activeResolution
      ? escape(part.activeResolution.finding ?? '（未写说明）') + '<div class="muted">工单 ' +
        escape(part.activeResolution.ticket) + '，偏移 ' + escape(part.activeResolution.offset) + '</div>'
      : '—') + '</td></tr>';
}

function renderDesk(ledger, message = null) {
  const view = ledger.view();
  if (!view.caseId) {
    return markup('联办台', '<p>尚未读取热线派发任务。</p>' + dispatchForm() + messageBlock(message));
  }
  const conflicts = view.conflicts.length
    ? view.conflicts.map(conflict => '<div class="warn" role="alert"><strong>' + escape(conflict.message) +
      '</strong><ul>' + conflict.tickets.map(ticket => '<li>' + escape(ticket.officeName) + ' 企业编号 <code>' +
        escape(ticket.ticket) + '</code>' + (ticket.proof ? '，凭据 <code>' + escape(ticket.proof) + '</code>'
          : '，<strong>没有关联凭据</strong>') + '</li>').join('') + '</ul>' +
      '<p>请核实分项 <code>' + escape(conflict.part) + '</code> 到底由哪家承接。</p></div>').join('')
    : '';
  const pending = view.pendingAcceptance.length
    ? '<div class="todo"><strong>待对方确认承接，社区清单上仍需跟进：</strong><ul>' +
      view.pendingAcceptance.map(item => '<li>分项 <code>' + escape(item.part) + '</code> ' +
        escape(item.service) + '，应提醒' + escape(item.expectedTeam) + '催接（' + escape(item.reason) +
        '；' + escape(item.basis) + '）</li>').join('') +
      '</ul></div>'
    : '';
  const unattributed = view.unattributed.length
    ? '<div class="todo"><strong>以下企业记录暂时接不回本诉求分项，未计入归属：</strong><ul>' +
      view.unattributed.map(item => '<li>' + escape(item.flow === 'live' ? '实时页' : '补领区间') +
        ' 偏移 ' + escape(item.offset) + '：' + escape(item.type) + '，工单 <code>' +
        escape(item.ticket) + '</code>' + (item.parts.length ? '，自报分项 ' + escape(item.parts.join('、')) : '') +
        '</li>').join('') + '</ul><p>可用原凭据补领对应区间后核对。</p></div>'
    : '';
  const findingNotes = view.notes.filter(note => note.kind === '处理结论可能变化');
  const replies = view.replies.length
    ? '<div class="table"><table><thead><tr><th scope="col">回告身份</th><th scope="col">分项</th>' +
      '<th scope="col">状态</th><th scope="col">回执号</th><th scope="col">引用原回执</th><th scope="col">正文</th></tr></thead><tbody>' +
      view.replies.map(reply => '<tr><td>' + escape(reply.requestKey) + '</td><td>' + escape(reply.partId) +
        '</td><td>' + escape(reply.state) + (reply.receiptOpen ? '' : '（回执暂未可查）') + '</td><td>' +
        escape(reply.receipt ?? '—') + '</td><td>' + escape(reply.priorReceipt ?? '—') + '</td><td>' +
        escape(reply.text) + '</td></tr>').join('') + '</tbody></table></div>'
    : '<p class="muted">尚无回告。</p>';
  const history = view.parts.map(part => '<details><summary>分项 <code>' + escape(part.id) + '</code> 轨迹（' +
    part.history.length + '）</summary><ul>' + part.history.map(entry =>
      '<li>' + escape(entry.at) + ' — ' + escape(entry.type) + '：' + escape(entry.reason) + '</li>').join('') +
    '</ul></details>').join('');

  return markup('联办台 ' + view.caseId, messageBlock(message) + conflicts + pending + unattributed +
    (findingNotes.length ? '<h2>处理结论可能变化</h2>' + findingNotes.map(note =>
      '<div class="warn">' + escape(note.message) + '</div>').join('') : '') +
    '<h2>分项归属</h2><div class="table"><table><thead><tr>' +
    '<th scope="col">分项</th><th scope="col">承办单位</th><th scope="col">企业工单</th>' +
    '<th scope="col">状态</th><th scope="col">归属依据</th><th scope="col">当前处理说明</th>' +
    '</tr></thead><tbody>' + view.parts.map(partRow).join('') + '</tbody></table></div>' +
    '<p class="muted">服务地点：' + escape(view.affectedScope ?? '—') +
    '。企业过程记录只作核对；未确认承接的分项不会被企业补报关回。</p>' +
    syncForm() + replyForm(view) + '<h2>回告</h2>' + replies +
    '<h2>交班</h2>' + handoverForm(view) + history);
}

function messageBlock(message) {
  if (!message) return '';
  return '<div class="' + (message.kind === 'error' ? 'warn' : 'todo') + '">' + escape(message.text) + '</div>';
}

function dispatchForm() {
  return '<form method="post" action="/api/dispatch"><h2>读取热线派发</h2>' +
    '<label>诉求号<input name="caseId" value="H-406" required></label>' +
    '<button type="submit">读取</button></form>';
}

function syncForm() {
  return '<form method="post" action="/api/sync"><h2>取企业过程</h2>' +
    '<label>实时页起点 after<input name="after" type="number" value="8" min="0"></label>' +
    '<label>补领区间 from<input name="from" type="number" value="9" min="0"></label>' +
    '<label>补领区间 to<input name="to" type="number" value="10" min="0"></label>' +
    '<label>取数方式<select name="mode"><option value="both">实时页 + 补领</option>' +
    '<option value="replay">只补领</option></select></label>' +
    '<button type="submit">取数</button></form>';
}

function replyForm(view) {
  return '<form method="post" action="/api/replies"><h2>发起回告</h2>' +
    '<label>分项<select name="part">' + view.parts.map(part =>
      '<option value="' + escape(part.id) + '">' + escape(part.id) + ' ' + escape(part.service) + '</option>').join('') +
    '</select></label>' +
    '<label>回告身份（可选，重跑时沿用）<input name="requestKey"></label>' +
    '<label>引用原回执（补充回告必填）<input name="priorReceipt"></label>' +
    '<label>正文<textarea name="text" rows="2" required>已处理</textarea></label>' +
    '<button type="submit">发出</button></form>';
}

function handoverForm(view) {
  const lines = view.parts.map(part => '分项 ' + part.id + ' ' + part.service + '：' +
    part.currentTeam + (part.ticket ? '（' + part.ticket + '）' : '') +
    (part.pending ? ' 待对方确认承接' : ' 已接手')).join('\n');
  const sent = view.replies.filter(reply => reply.receipt)
    .map(reply => '分项 ' + reply.partId + ' 回告 ' + reply.receipt + '（' + reply.text + '）').join('\n');
  return '<p class="muted">交班说明中列出已送回热线的回执，以及仍在社区清单上的分项。</p>' +
    '<textarea name="handover" rows="' + (view.parts.length + 3) + '" style="width:100%" readonly>' +
    escape('已送回热线：\n' + (sent || '（无）') + '\n\n仍需跟进：\n' + lines) + '</textarea>';
}

export function createDesk({ ledger, drill, replies, caseId = 'H-406' }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const redirect = (message) => {
      response.writeHead(303, { location: '/?message=' + encodeURIComponent(message) });
      response.end();
    };
    try {
      if (url.pathname === '/' && request.method === 'GET') {
        const message = url.searchParams.get('message');
        return send(200, renderDesk(ledger, message ? { kind: 'notice', text: message } : null), 'text/html');
      }
      if (url.pathname === '/api/state' && request.method === 'GET') {
        return send(200, ledger.view());
      }
      if (url.pathname === '/api/dispatch' && request.method === 'POST') {
        const body = await readJson(request);
        await drill.pullDispatch(body.caseId || caseId);
        return redirect('已读取热线派发任务');
      }
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        const body = await readJson(request);
        const from = Number(body.from ?? 9);
        const to = Number(body.to ?? 10);
        // 实时页可以单独跳过：只凭补领区间时，转出已登记但对方接收记录还没看到，
        // 值班员据此确认哪些分项需要催接。
        if (body.mode === 'replay') {
          const records = await drill.pullReplay(from, to);
          await drill.pullFindings();
          return redirect('已按补领区间取数（未取实时页），共 ' + records.length + ' 条');
        }
        const live = await drill.pullLive({ after: Number(body.after ?? 8) });
        await drill.fillGaps([...live.gaps, [from, to]]);
        await drill.pullFindings();
        return redirect('已取回企业过程，重复记录已按投递偏移去重');
      }
      if (url.pathname === '/api/replies' && request.method === 'POST') {
        const body = await readJson(request);
        const draft = await replies.draft({
          partId: body.part,
          text: body.text,
          priorReceipt: body.priorReceipt || null,
          requestKey: body.requestKey || null,
        });
        const result = await replies.send(draft.requestKey);
        return redirect('回告 ' + result.requestKey + '：' + result.state +
          (result.receipt ? '，回执 ' + result.receipt : '') +
          (result.awaitingReceipt ? '（回执暂未可查，保留原身份待追认）' : ''));
      }
      if (url.pathname === '/api/replies/retry' && request.method === 'POST') {
        const results = await replies.retryPending();
        return send(200, results);
      }
      if (url.pathname === '/api/handover' && request.method === 'GET') {
        const view = ledger.view();
        return send(200, {
          caseId: view.caseId,
          repliesSent: view.replies.filter(reply => reply.receipt)
            .map(reply => ({ part: reply.partId, receipt: reply.receipt, text: reply.text })),
          repliesAwaiting: view.replies.filter(reply => !reply.receipt)
            .map(reply => ({ part: reply.partId, requestKey: reply.requestKey, state: reply.state })),
          stillFollowing: view.parts.map(part => ({
            part: part.id, service: part.service, team: part.currentTeam,
            ticket: part.ticket, pending: part.pending,
          })),
          pendingAcceptance: view.pendingAcceptance,
          conflicts: view.conflicts,
        });
      }
      return send(404, { error: '查无页面', requestId: randomUUID() });
    } catch (error) {
      const message = error.message || '未知错误';
      if (url.pathname.startsWith('/api/')) {
        if (request.headers.accept?.includes('text/html')) return redirect(message);
        return send(400, { error: message });
      }
      return send(400, renderDesk(ledger, { kind: 'error', text: message }), 'text/html');
    }
  });
}

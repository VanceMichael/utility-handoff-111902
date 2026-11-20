import { createSource } from './source.mjs';
import { createClient } from './lib/client.mjs';
import { createDesk } from './lib/desk.mjs';
import { Drill } from './lib/drill.mjs';
import { Ledger } from './lib/ledger.mjs';
import { ReplyService } from './lib/replies.mjs';
import { createFileStore, storePath } from './lib/store.mjs';

const port = Number(process.env.PORT ?? 3200);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 应为 1 到 65535 之间的整数');
}
const sourcePort = Number(process.env.SOURCE_PORT ?? 3100);
const sourceUrl = process.env.SOURCE_URL ?? 'http://127.0.0.1:' + sourcePort;
const caseId = process.env.CASE_ID ?? 'H-406';
const dataDir = process.env.DATA_DIR ?? new URL('./data/', import.meta.url).pathname;
const embedded = process.env.EMBEDDED_SOURCE !== '0';

if (embedded) {
  createSource().listen(sourcePort, '127.0.0.1', () => {
    console.log('演练来源已启动 http://127.0.0.1:' + sourcePort);
  });
}

const store = createFileStore(storePath(dataDir, caseId));
const ledger = await Ledger.load(store);
const client = createClient({ baseUrl: sourceUrl });
const replies = new ReplyService({ client, ledger });
const drill = new Drill({ client, ledger, replies });
const desk = createDesk({ ledger, drill, replies, caseId });

desk.listen(port, '127.0.0.1', () => {
  console.log('值班台已启动 http://127.0.0.1:' + port);
  console.log('诉求 ' + caseId + '，来源 ' + sourceUrl + '，台账 ' + storePath(dataDir, caseId));
});

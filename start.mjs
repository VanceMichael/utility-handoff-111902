import { createSource } from './source.mjs';

const port = Number(process.env.PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 应为 1 到 65535 之间的整数');
}
createSource().listen(port, '127.0.0.1', () => {
  console.log('演练来源已启动 http://127.0.0.1:' + port);
});

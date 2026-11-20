// 台账落盘：一个诉求一个文件，重启后仍能接着交班。
// 写文件采用「同目录临时文件 + 改名」，避免值班中途断电留下半个 JSON。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function createFileStore(path) {
  let queue = Promise.resolve();

  async function read() {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function write(value) {
    queue = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = join(dirname(path), '.' + path.split('/').at(-1) + '.' + process.pid + '.tmp');
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
      await rename(temporary, path);
    });
    return queue;
  }

  return { read, write };
}

export function storePath(dataDir, caseId) {
  return join(dataDir, String(caseId).replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
}

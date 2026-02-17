/**
 * 测试 Inrupt SDK 的 fetch 对 302 重定向的处理
 *
 * 启动一个本地 HTTP 服务器：
 *   - GET /file → 302 重定向到 /target
 *   - GET /target → 200 返回文件内容
 *
 * 然后用 @inrupt/solid-client 的 getFile() 请求 /file，
 * 验证是否能正确跟随重定向拿到文件内容。
 *
 * 用法: npx tsx scripts/test-redirect-fetch.ts
 */

import http from 'node:http';
import { getFile } from '@inrupt/solid-client';

const PORT = 9877;
const FILE_CONTENT = 'Hello from redirected COS presigned URL!';

// 模拟服务端：/file 返回 302，/target 模拟 COS 直出
const server = http.createServer((req, res) => {
  if (req.url === '/file') {
    console.log(`[server] ${req.method} /file → 302 to /target`);
    console.log(`[server] Authorization header: ${req.headers.authorization ?? '(none)'}`);
    res.writeHead(302, { Location: `http://localhost:${PORT}/target` });
    res.end();
  } else if (req.url === '/target') {
    console.log(`[server] ${req.method} /target → 200`);
    console.log(`[server] Authorization header on redirected request: ${req.headers.authorization ?? '(none)'}`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': Buffer.byteLength(FILE_CONTENT).toString(),
    });
    res.end(FILE_CONTENT);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

async function runTest() {
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`[test] Server listening on port ${PORT}\n`);

  try {
    // 测试 1: 原生 fetch 跟随重定向
    console.log('=== Test 1: Native fetch with redirect ===');
    const nativeRes = await fetch(`http://localhost:${PORT}/file`);
    console.log(`[test] Status: ${nativeRes.status}`);
    console.log(`[test] OK: ${nativeRes.ok}`);
    console.log(`[test] Redirected: ${nativeRes.redirected}`);
    console.log(`[test] Final URL: ${nativeRes.url}`);
    const nativeBody = await nativeRes.text();
    console.log(`[test] Body: "${nativeBody}"`);
    console.log(`[test] Match: ${nativeBody === FILE_CONTENT}\n`);

    // 测试 2: 原生 fetch 带 Authorization header（模拟 DPoP）
    console.log('=== Test 2: Native fetch with Authorization header ===');
    const authRes = await fetch(`http://localhost:${PORT}/file`, {
      headers: { Authorization: 'DPoP fake-token-12345' },
    });
    console.log(`[test] Status: ${authRes.status}`);
    console.log(`[test] OK: ${authRes.ok}`);
    console.log(`[test] Redirected: ${authRes.redirected}`);
    const authBody = await authRes.text();
    console.log(`[test] Body: "${authBody}"`);
    console.log(`[test] Match: ${authBody === FILE_CONTENT}\n`);

    // 测试 3: Inrupt getFile()
    console.log('=== Test 3: Inrupt getFile() with redirect ===');
    try {
      const blob = await getFile(`http://localhost:${PORT}/file`, {
        fetch: fetch,
      });
      const text = await blob.text();
      console.log(`[test] getFile() succeeded`);
      console.log(`[test] Body: "${text}"`);
      console.log(`[test] Match: ${text === FILE_CONTENT}`);
    } catch (error: any) {
      console.log(`[test] getFile() failed: ${error.message}`);
    }

    console.log('\n=== All tests complete ===');
  } finally {
    server.close();
  }
}

runTest().catch(console.error);

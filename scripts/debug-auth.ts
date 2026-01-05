/**
 * 调试认证问题
 */

import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

const BASE_URL = 'http://localhost:4000';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = BASE_URL + '/';

async function main() {
  console.log('=== Debug Auth ===\n');
  console.log('clientId:', clientId?.slice(0, 20) + '...');
  console.log('oidcIssuer:', oidcIssuer);

  const session = new Session();

  try {
    await session.login({
      clientId: clientId!,
      clientSecret: clientSecret!,
      oidcIssuer,
      tokenType: 'DPoP',
    });

    console.log('\nLogin result:');
    console.log('  isLoggedIn:', session.info.isLoggedIn);
    console.log('  webId:', session.info.webId);

    if (!session.info.isLoggedIn) {
      console.error('Login failed');
      return;
    }

    // 使用自定义 fetch 包装来查看请求头
    const originalFetch = session.fetch.bind(session);
    const debugFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      console.log('\n--- Request ---');
      console.log('URL:', input.toString());

      // 调用原始 fetch
      const response = await originalFetch(input, init);

      // 打印响应
      console.log('Status:', response.status);
      console.log('Response headers:');
      response.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));

      return response;
    };

    // 测试请求 Pod 根目录
    console.log('\n=== Test 1: GET Pod root ===');
    const podUrl = session.info.webId!.replace(/profile\/card#me$/, '');
    console.log('Pod URL:', podUrl);

    const res1 = await debugFetch(podUrl);
    console.log('Body preview:', (await res1.text()).slice(0, 200));

    // 测试请求 vector 端点
    console.log('\n=== Test 2: GET /-/vector/models ===');
    const res2 = await debugFetch(`${BASE_URL}/-/vector/models`);
    const body2 = await res2.text();
    console.log('Body:', body2);

    // 测试请求 Pod 内的 vector 端点
    console.log('\n=== Test 3: GET /test/-/vector/models ===');
    const res3 = await debugFetch(`${podUrl}-/vector/models`);
    const body3 = await res3.text();
    console.log('Body:', body3);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await session.logout().catch(() => {});
  }
}

main();

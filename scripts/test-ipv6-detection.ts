/**
 * 测试 IPv6 检测和上报流程
 * 
 * 运行方式: npx ts-node scripts/test-ipv6-detection.ts
 */

import { EdgeNodeCapabilityDetector } from '../src/edge/EdgeNodeCapabilityDetector';

async function main() {
  console.log('=== IPv6 检测测试 ===\n');

  const detector = new EdgeNodeCapabilityDetector({
    dynamicDetection: {
      enableNetworkDetection: true,
    },
  });

  console.log('1. 检测网络地址...');
  const networkInfo = await detector.detectNetworkAddresses();
  
  console.log('\n检测结果:');
  console.log(`  本地 IPv4: ${networkInfo.ipv4 ?? '未检测到'}`);
  console.log(`  本地 IPv6: ${networkInfo.ipv6 ?? '未检测到'}`);
  console.log(`  公网 IPv4: ${networkInfo.ipv4Public ?? '未检测到'}`);
  console.log(`  公网 IPv6: ${networkInfo.ipv6Public ?? '未检测到'}`);
  console.log(`  是否有公网 IPv6: ${networkInfo.hasPublicIPv6 ? '是' : '否'}`);

  console.log('\n2. 模拟心跳上报...');
  
  const heartbeatPayload = {
    nodeId: 'test-node-001',
    token: 'test-token',
    baseUrl: 'https://test-node.example.com/',
    ipv4: networkInfo.ipv4Public ?? networkInfo.ipv4,
    ipv6: networkInfo.ipv6Public ?? networkInfo.ipv6,
    capabilities: ['direct', 'proxy'],
  };

  console.log('\n心跳载荷:');
  console.log(JSON.stringify(heartbeatPayload, null, 2));

  console.log('\n3. DNS 记录模拟...');
  
  if (networkInfo.hasPublicIPv6 && networkInfo.ipv6Public) {
    console.log(`  推荐模式: direct (IPv6)`);
    console.log(`  DNS 记录: AAAA -> ${networkInfo.ipv6Public}`);
    console.log(`  ✅ 可以使用 IPv6 直连，无需 Cloudflare Tunnel！`);
  } else if (networkInfo.ipv4Public) {
    console.log(`  推荐模式: direct (IPv4)`);
    console.log(`  DNS 记录: A -> ${networkInfo.ipv4Public}`);
    console.log(`  ⚠️ 仅有 IPv4，可能需要检查 NAT 穿透`);
  } else {
    console.log(`  推荐模式: proxy`);
    console.log(`  ⚠️ 未检测到公网 IP，需要使用隧道/代理模式`);
  }

  console.log('\n=== 测试完成 ===');
}

main().catch(console.error);

/**
 * 局域网检测工具
 *
 * 通过比较 IP 地址判断两个节点是否在同一局域网
 */

import { networkInterfaces } from 'node:os';

/**
 * 获取本机内网 IP 地址
 */
export function getLocalIPs(): { ipv4: string[]; ipv6: string[] } {
  const result = { ipv4: [] as string[], ipv6: [] as string[] };
  const interfaces = networkInterfaces();

  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue; // 跳过 loopback

      if (addr.family === 'IPv4') {
        result.ipv4.push(addr.address);
      } else if (addr.family === 'IPv6' && !addr.address.startsWith('fe80')) {
        // 跳过 link-local
        result.ipv6.push(addr.address);
      }
    }
  }

  return result;
}

/**
 * 判断 IP 是否是内网地址
 */
export function isPrivateIP(ip: string): boolean {
  // IPv4 内网地址范围
  const privateRanges = [
    /^10\./,                    // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^192\.168\./,              // 192.168.0.0/16
    /^169\.254\./,              // Link-local
  ];

  // IPv6 内网地址
  const privateV6Ranges = [
    /^fc/i,  // Unique local (fc00::/7)
    /^fd/i,  // Unique local (fd00::/8)
  ];

  for (const range of privateRanges) {
    if (range.test(ip)) return true;
  }

  for (const range of privateV6Ranges) {
    if (range.test(ip)) return true;
  }

  return false;
}

/**
 * 从 IP 地址获取网段（简单实现，假设 /24）
 */
export function getNetworkPrefix(ip: string, prefixLength = 24): string {
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;

  // 对于 /24，取前三段
  if (prefixLength === 24) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }

  // 对于 /16，取前两段
  if (prefixLength === 16) {
    return `${parts[0]}.${parts[1]}.0.0/16`;
  }

  return ip;
}

/**
 * 判断两个 IP 是否在同一网段
 */
export function isSameNetwork(ip1: string, ip2: string, prefixLength = 24): boolean {
  return getNetworkPrefix(ip1, prefixLength) === getNetworkPrefix(ip2, prefixLength);
}

/**
 * 局域网节点信息
 */
export interface LocalNodeInfo {
  nodeId: string;
  privateIPs: string[];
  publicIP?: string;
}

/**
 * 局域网检测器
 *
 * Cloud 端使用，判断 Client 是否与 Local 在同一局域网
 */
export class LocalNetworkDetector {
  /** 存储已注册的 Local 节点信息 */
  private readonly nodes = new Map<string, LocalNodeInfo>();

  /**
   * 注册 Local 节点信息（从心跳获取）
   */
  public registerNode(nodeId: string, privateIPs: string[], publicIP?: string): void {
    this.nodes.set(nodeId, { nodeId, privateIPs, publicIP });
  }

  /**
   * 移除节点
   */
  public removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
  }

  /**
   * 检测 Client 是否与指定 Local 在同一局域网
   *
   * 检测逻辑：
   * 1. 比较公网 IP：如果相同，可能在同一 NAT 后
   * 2. 比较内网 IP 网段：如果有重叠，很可能在同一局域网
   */
  public detectSameNetwork(
    targetNodeId: string,
    clientPrivateIPs: string[],
    clientPublicIP?: string,
  ): { isSameNetwork: boolean; reason: string; localIPs?: string[] } {
    const node = this.nodes.get(targetNodeId);
    if (!node) {
      return { isSameNetwork: false, reason: 'Node not found' };
    }

    // 1. 检查公网 IP
    if (clientPublicIP && node.publicIP && clientPublicIP === node.publicIP) {
      // 公网 IP 相同，可能在同一 NAT 后面
      // 进一步检查内网 IP
      for (const clientIP of clientPrivateIPs) {
        for (const nodeIP of node.privateIPs) {
          if (isSameNetwork(clientIP, nodeIP)) {
            return {
              isSameNetwork: true,
              reason: 'Same public IP and same private network',
              localIPs: node.privateIPs,
            };
          }
        }
      }
      return {
        isSameNetwork: false,
        reason: 'Same public IP but different private networks (different NAT layers?)',
      };
    }

    // 2. 只检查内网 IP（如果没有公网 IP 信息）
    for (const clientIP of clientPrivateIPs) {
      if (!isPrivateIP(clientIP)) continue;

      for (const nodeIP of node.privateIPs) {
        if (!isPrivateIP(nodeIP)) continue;

        if (isSameNetwork(clientIP, nodeIP)) {
          return {
            isSameNetwork: true,
            reason: 'Same private network segment',
            localIPs: node.privateIPs,
          };
        }
      }
    }

    return {
      isSameNetwork: false,
      reason: 'Different networks',
    };
  }

  /**
   * 获取节点信息
   */
  public getNode(nodeId: string): LocalNodeInfo | undefined {
    return this.nodes.get(nodeId);
  }
}

// 测试
if (require.main === module) {
  console.log('Local IPs:', getLocalIPs());

  const detector = new LocalNetworkDetector();

  // 模拟 Local 节点注册
  detector.registerNode('local-1', ['192.168.1.100', '10.0.0.5'], '1.2.3.4');

  // 测试 1: 同一局域网的 Client
  console.log('\nTest 1 - Same network:');
  console.log(detector.detectSameNetwork('local-1', ['192.168.1.50'], '1.2.3.4'));

  // 测试 2: 不同局域网的 Client
  console.log('\nTest 2 - Different network:');
  console.log(detector.detectSameNetwork('local-1', ['192.168.2.50'], '5.6.7.8'));

  // 测试 3: 同一公网 IP 但不同内网网段
  console.log('\nTest 3 - Same public IP, different private:');
  console.log(detector.detectSameNetwork('local-1', ['172.16.0.50'], '1.2.3.4'));
}

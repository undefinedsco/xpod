import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 获取设备首个非内部网卡的 MAC 地址。
 * 返回小写冒号分隔格式，如 "aa:bb:cc:dd:ee:ff"。
 * 容器/虚拟机中可能拿不到稳定 MAC，此时返回 undefined。
 */
function getFirstMacAddress(): string | undefined {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac.toLowerCase();
      }
    }
  }
  return undefined;
}

/**
 * 读取或生成设备 ID（持久化到 <rootDir>/.device-id）。
 *
 * 优先级：
 *   1. 环境变量 XPOD_NODE_ID
 *   2. 已持久化的 <rootDir>/.device-id
 *   3. 基于 MAC 地址的 SHA-256 哈希（截取前 32 位 hex）
 *   4. 随机 UUID（容器/虚拟机无稳定 MAC 时兜底）
 *
 * 生成后写入 data/.device-id，后续启动直接读取，保证同一设备 ID 稳定。
 *
 * `rootDir` is explicit so a launcher can resolve identity under the same data
 * root it will hand to its children without mutating the parent environment.
 */
export function loadOrGenerateDeviceId(
  envNodeId?: string,
  rootDir = process.env.CSS_ROOT_FILE_PATH || './data',
): string | undefined {
  if (envNodeId) {
    return envNodeId;
  }

  const deviceIdPath = path.join(rootDir, '.device-id');

  // 尝试从文件读取
  try {
    if (fs.existsSync(deviceIdPath)) {
      const content = fs.readFileSync(deviceIdPath, 'utf-8').trim();
      if (content) {
        return content;
      }
    }
  } catch {
    // 读取失败，继续生成
  }

  // 优先用 MAC 哈希，拿不到则 UUID 兜底
  const mac = getFirstMacAddress();
  const deviceId = mac
    ? createHash('sha256').update(mac).digest('hex').slice(0, 32)
    : randomUUID();

  try {
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }
    fs.writeFileSync(deviceIdPath, deviceId, 'utf-8');
  } catch {
    // 写入失败不阻塞启动
  }

  return deviceId;
}

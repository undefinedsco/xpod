import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimePlatform } from '../types';

export class NodeRuntimePlatform implements RuntimePlatform {
  public readonly name = 'node';
  public readonly baseEnv: Record<string, string | undefined>;

  public constructor(baseEnv: Record<string, string | undefined> = { ...process.env }) {
    this.baseEnv = { ...baseEnv };
  }

  public createRuntimeId(): string {
    return randomUUID().slice(0, 8);
  }

  public cwd(): string {
    return process.cwd();
  }

  public joinPath(...segments: string[]): string {
    return path.join(...segments);
  }

  public resolvePath(...segments: string[]): string {
    return path.resolve(...segments);
  }

  public dirname(filePath: string): string {
    return path.dirname(filePath);
  }

  public fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  public readTextFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }

  public writeTextFile(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content);
  }

  public ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  public getEnv(key: string): string | undefined {
    return process.env[key];
  }

  public setEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
      return;
    }

    process.env[key] = value;
  }

  public fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return fetch(input as any, init as any);
  }
}

export const nodeRuntimePlatform = new NodeRuntimePlatform();

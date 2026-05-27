export interface RuntimePlatform {
  readonly name: string;
  readonly baseEnv: Record<string, string | undefined>;
  createRuntimeId(): string;
  cwd(): string;
  joinPath(...segments: string[]): string;
  resolvePath(...segments: string[]): string;
  dirname(filePath: string): string;
  fileExists(filePath: string): boolean;
  readTextFile(filePath: string): string;
  writeTextFile(filePath: string, content: string): void;
  ensureDir(dirPath: string): void;
  getEnv(key: string): string | undefined;
  setEnv(key: string, value: string | undefined): void;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

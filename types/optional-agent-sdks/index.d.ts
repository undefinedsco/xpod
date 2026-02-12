declare module '@anthropic-ai/claude-agent-sdk' {
  export type SDKMessage = any;
  export type SDKResultMessage = any;
  export type Options = any;
  export function query(input: { prompt: string; options?: Options }): AsyncIterable<any>;
}

declare module '@tencent-ai/agent-sdk' {
  export type McpServerConfig = any;
  export type Options = any;
  export type SystemMessage = any;
  export function query(input: { prompt: string; options?: Options }): AsyncIterable<any> & {
    accountInfo(): Promise<any>;
  };
}

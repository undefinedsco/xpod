/// <reference types="node" />

// Node.js global types
declare const process: NodeJS.Process;
declare const console: Console;
declare const Buffer: typeof globalThis.Buffer;

// Fetch types (Node.js 18+)
declare const fetch: typeof globalThis.fetch;
declare const Request: typeof globalThis.Request;
declare const Response: typeof globalThis.Response;
declare const Headers: typeof globalThis.Headers;
declare const RequestInit: typeof globalThis.RequestInit;
declare const ReadableStream: typeof globalThis.ReadableStream;

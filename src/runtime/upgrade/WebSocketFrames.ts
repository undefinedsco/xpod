import { randomBytes } from 'node:crypto';

/**
 * Minimal RFC 6455 frame codec used by the gateway's native (Bun) WebSocket
 * upgrade relay.
 *
 * The gateway only needs it on runtimes whose HTTP server cannot hand the raw
 * upgraded socket back to JavaScript (see `BunNativeUpgradeRelay`): there the
 * client side is a native WebSocket (message level), while the upstream side is
 * a raw socket, so frames have to be decoded/encoded in between.
 *
 * The codec deliberately implements a single, predictable flavour of the
 * protocol: no extensions (the relay never offers `permessage-deflate`), no
 * fragmentation on the outbound path (one frame per message) and a bounded
 * inbound message size.
 */

export const WS_OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export type WebSocketFrameOpcode = typeof WS_OPCODE[keyof typeof WS_OPCODE];

/** Close code used when the peer violates the protocol. */
export const WS_CLOSE_PROTOCOL_ERROR = 1002;
/** Close code used when a message exceeds the configured size limit. */
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

export interface EncodeWebSocketFrameOptions {
  opcode: WebSocketFrameOpcode;
  /** Client-to-server frames must be masked; server-to-client frames must not. */
  mask: boolean;
  /** Deterministic mask key, for tests only. */
  maskKey?: Buffer;
}

export function encodeWebSocketFrame(payload: Buffer, options: EncodeWebSocketFrameOptions): Buffer {
  const { opcode, mask } = options;
  const length = payload.length;
  const lengthBytes = length < 126 ? 1 : length <= 0xffff ? 3 : 9;
  const maskBytes = mask ? 4 : 0;
  const frame = Buffer.allocUnsafe(1 + lengthBytes + maskBytes + length);
  frame[0] = 0x80 | opcode;
  let offset: number;
  if (length < 126) {
    frame[1] = (mask ? 0x80 : 0) | length;
    offset = 2;
  } else if (length <= 0xffff) {
    frame[1] = (mask ? 0x80 : 0) | 126;
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame[1] = (mask ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }

  if (!mask) {
    payload.copy(frame, offset);
    return frame;
  }

  const maskKey = options.maskKey ?? randomBytes(4);
  maskKey.copy(frame, offset);
  for (let index = 0; index < length; index++) {
    frame[offset + 4 + index] = payload[index]! ^ maskKey[index % 4]!;
  }
  return frame;
}

/** Encodes a close frame body (`code` + UTF-8 reason). */
export function encodeWebSocketClosePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8');
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

export interface WebSocketFrameSink {
  /** A complete (possibly reassembled) data message. */
  onMessage(payload: Buffer, isBinary: boolean): void;
  onPing(payload: Buffer): void;
  onPong(payload: Buffer): void;
  onClose(code: number, reason: string): void;
  /** The peer sent something that violates the protocol; the connection should be closed with 1002. */
  onProtocolError(reason: string): void;
}

export interface WebSocketFrameParserOptions {
  /** Upper bound for a single (reassembled) message; oversized messages raise a protocol error. */
  maxMessageBytes?: number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export class WebSocketFrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  private fragmentOpcode: WebSocketFrameOpcode | undefined;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private failed = false;
  private readonly maxMessageBytes: number;

  public constructor(
    private readonly sink: WebSocketFrameSink,
    options: WebSocketFrameParserOptions = {},
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  public push(chunk: Buffer): void {
    if (this.failed || chunk.length === 0) {
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([ this.buffer, chunk ]);
    while (!this.failed && this.parseFrame()) {
      // Keep consuming buffered frames.
    }
  }

  private fail(reason: string): void {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = undefined;
    this.sink.onProtocolError(reason);
  }

  /** @returns whether a complete frame was consumed. */
  private parseFrame(): boolean {
    const buffer = this.buffer;
    if (buffer.length < 2) {
      return false;
    }

    const fin = (buffer[0]! & 0x80) !== 0;
    const reserved = buffer[0]! & 0x70;
    const opcode = (buffer[0]! & 0x0f) as WebSocketFrameOpcode;
    const masked = (buffer[1]! & 0x80) !== 0;
    let payloadLength = buffer[1]! & 0x7f;
    let offset = 2;

    if (reserved !== 0) {
      this.fail('reserved frame bits set without a negotiated extension');
      return false;
    }

    if (payloadLength === 126) {
      if (buffer.length < offset + 2) {
        return false;
      }
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buffer.length < offset + 8) {
        return false;
      }
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.fail('frame payload length is out of range');
        return false;
      }
      payloadLength = Number(big);
      offset += 8;
    }

    const isControl = (opcode & 0x8) !== 0;
    if (isControl && (!fin || payloadLength > 125)) {
      this.fail('invalid control frame');
      return false;
    }

    const maskBytes = masked ? 4 : 0;
    if (payloadLength > this.maxMessageBytes || this.fragmentBytes + payloadLength > this.maxMessageBytes) {
      this.fail('message exceeds the configured size limit');
      return false;
    }
    if (buffer.length < offset + maskBytes + payloadLength) {
      return false;
    }

    const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
    offset += maskBytes;
    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
    this.buffer = buffer.subarray(offset + payloadLength);

    if (maskKey) {
      for (let index = 0; index < payload.length; index++) {
        payload[index] = payload[index]! ^ maskKey[index % 4]!;
      }
    }

    this.handleFrame(fin, opcode, payload);
    return !this.failed;
  }

  private handleFrame(fin: boolean, opcode: WebSocketFrameOpcode, payload: Buffer): void {
    switch (opcode) {
      case WS_OPCODE.continuation:
        if (this.fragmentOpcode === undefined) {
          this.fail('continuation frame without a started message');
          return;
        }
        this.appendFragment(payload);
        if (fin) {
          this.completeMessage();
        }
        return;
      case WS_OPCODE.text:
      case WS_OPCODE.binary:
        if (this.fragmentOpcode !== undefined) {
          this.fail('new data frame while a fragmented message is in progress');
          return;
        }
        this.fragmentOpcode = opcode;
        this.appendFragment(payload);
        if (fin) {
          this.completeMessage();
        }
        return;
      case WS_OPCODE.close: {
        if (payload.length === 1) {
          this.fail('close frame with a 1 byte payload');
          return;
        }
        // The close frame ends the data stream: nothing after it is dispatched.
        this.failed = true;
        this.buffer = Buffer.alloc(0);
        this.sink.onClose(payload.length === 0 ? 1005 : payload.readUInt16BE(0), payload.subarray(2).toString('utf8'));
        return;
      }
      case WS_OPCODE.ping:
        this.sink.onPing(payload);
        return;
      case WS_OPCODE.pong:
        this.sink.onPong(payload);
        return;
      default:
        this.fail(`unsupported opcode ${opcode}`);
    }
  }

  private appendFragment(payload: Buffer): void {
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) {
      this.fail('message exceeds the configured size limit');
      return;
    }
    this.fragments.push(payload);
  }

  private completeMessage(): void {
    const opcode = this.fragmentOpcode;
    const fragments = this.fragments;
    this.fragmentOpcode = undefined;
    this.fragments = [];
    this.fragmentBytes = 0;
    const payload = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments);
    this.sink.onMessage(payload, opcode === WS_OPCODE.binary);
  }
}

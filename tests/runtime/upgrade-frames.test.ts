import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WS_CLOSE_PROTOCOL_ERROR,
  WS_CLOSE_MESSAGE_TOO_BIG,
  WS_OPCODE,
  WebSocketFrameParser,
  encodeWebSocketClosePayload,
  encodeWebSocketFrame,
  type WebSocketFrameSink,
} from '../../src/runtime/upgrade/WebSocketFrames';

interface RecordedSink extends WebSocketFrameSink {
  messages: Array<{ binary: boolean; payload: Buffer }>;
  pings: Buffer[];
  pongs: Buffer[];
  closes: Array<{ code: number; reason: string }>;
  errors: string[];
}

function createSink(overrides: Partial<WebSocketFrameSink> = {}): RecordedSink {
  const sink: RecordedSink = {
    messages: [],
    pings: [],
    pongs: [],
    closes: [],
    errors: [],
    onMessage(payload, isBinary) {
      sink.messages.push({ binary: isBinary, payload });
    },
    onPing(payload) {
      sink.pings.push(payload);
    },
    onPong(payload) {
      sink.pongs.push(payload);
    },
    onClose(code, reason) {
      sink.closes.push({ code, reason });
    },
    onProtocolError(reason) {
      sink.errors.push(reason);
    },
    ...overrides,
  };
  return sink;
}

describe('WebSocket frame encoding', () => {
  it('encodes small, extended and 64 bit payloads with the right length marker', () => {
    const small = encodeWebSocketFrame(Buffer.from('hi'), { opcode: WS_OPCODE.text, mask: false });
    expect(small[1]).toBe(2);

    const medium = encodeWebSocketFrame(Buffer.alloc(200), { opcode: WS_OPCODE.binary, mask: false });
    expect(medium[1]).toBe(126);
    expect(medium.readUInt16BE(2)).toBe(200);

    const large = encodeWebSocketFrame(Buffer.alloc(70_000), { opcode: WS_OPCODE.binary, mask: false });
    expect(large[1]).toBe(127);
    expect(large.readBigUInt64BE(2)).toBe(70_000n);
  });

  it('masks client frames and leaves server frames unmasked', () => {
    const maskKey = Buffer.from([ 0x01, 0x02, 0x03, 0x04 ]);
    const masked = encodeWebSocketFrame(Buffer.from([ 0xff, 0xff, 0xff, 0xff ]), {
      opcode: WS_OPCODE.binary,
      mask: true,
      maskKey,
    });
    expect(masked[1]! & 0x80).toBe(0x80);
    expect(masked.subarray(2, 6)).toEqual(maskKey);
    expect(masked.subarray(6)).toEqual(Buffer.from([ 0xfe, 0xfd, 0xfc, 0xfb ]));

    const plain = encodeWebSocketFrame(Buffer.from('abc'), { opcode: WS_OPCODE.text, mask: false });
    expect(plain[1]! & 0x80).toBe(0);
    expect(plain.subarray(2)).toEqual(Buffer.from('abc'));
  });

  it('round-trips text, binary, masked and control frames through the parser', () => {
    const sink = createSink();
    const parser = new WebSocketFrameParser(sink);
    parser.push(Buffer.concat([
      encodeWebSocketFrame(Buffer.from('hello'), { opcode: WS_OPCODE.text, mask: true }),
      encodeWebSocketFrame(Buffer.from([ 0, 1, 2 ]), { opcode: WS_OPCODE.binary, mask: false }),
      encodeWebSocketFrame(Buffer.from('ping!'), { opcode: WS_OPCODE.ping, mask: true }),
      encodeWebSocketFrame(encodeWebSocketClosePayload(1000, 'bye'), { opcode: WS_OPCODE.close, mask: true }),
    ]));

    expect(sink.messages).toEqual([
      { binary: false, payload: Buffer.from('hello') },
      { binary: true, payload: Buffer.from([ 0, 1, 2 ]) },
    ]);
    expect(sink.pings).toEqual([ Buffer.from('ping!') ]);
    expect(sink.closes).toEqual([ { code: 1000, reason: 'bye' } ]);
    expect(sink.errors).toEqual([]);
  });

  it('reassembles fragmented messages', () => {
    const sink = createSink();
    const parser = new WebSocketFrameParser(sink);
    const masked = (payload: Buffer, opcode: number, fin: boolean): Buffer => {
      const frame = encodeWebSocketFrame(payload, { opcode: opcode as 0 | 1 | 2, mask: true });
      if (!fin) {
        frame[0] = frame[0]! & 0x7f;
      }
      return frame;
    };
    parser.push(masked(Buffer.from('frag'), WS_OPCODE.text, false));
    expect(sink.messages).toHaveLength(0);
    parser.push(masked(Buffer.from('mented'), WS_OPCODE.continuation, true));
    expect(sink.messages).toEqual([ { binary: false, payload: Buffer.from('fragmented') } ]);
  });

  it('handles frames split across pushes', () => {
    const sink = createSink();
    const parser = new WebSocketFrameParser(sink);
    const frame = encodeWebSocketFrame(Buffer.from('split-frame'), { opcode: WS_OPCODE.text, mask: true });
    for (const byte of frame) {
      parser.push(Buffer.from([ byte ]));
    }
    expect(sink.messages).toEqual([ { binary: false, payload: Buffer.from('split-frame') } ]);
  });

  it('reports protocol violations instead of dispatching frames', () => {
    const continuation = createSink();
    new WebSocketFrameParser(continuation).push(encodeWebSocketFrame(Buffer.from('x'), { opcode: WS_OPCODE.continuation, mask: false }));
    expect(continuation.errors[0]).toContain('continuation frame');

    const reserved = createSink();
    const reservedFrame = encodeWebSocketFrame(Buffer.from('x'), { opcode: WS_OPCODE.text, mask: false });
    reservedFrame[0] = reservedFrame[0]! | 0x40;
    new WebSocketFrameParser(reserved).push(reservedFrame);
    expect(reserved.errors[0]).toContain('reserved frame bits');

    const fragmentedControl = createSink();
    const ping = encodeWebSocketFrame(Buffer.from('x'), { opcode: WS_OPCODE.ping, mask: false });
    ping[0] = ping[0]! & 0x7f;
    new WebSocketFrameParser(fragmentedControl).push(ping);
    expect(fragmentedControl.errors[0]).toContain('invalid control frame');

    expect(WS_CLOSE_PROTOCOL_ERROR).toBe(1002);
  });

  it('refuses oversized messages', () => {
    const sink = createSink();
    const parser = new WebSocketFrameParser(sink, { maxMessageBytes: 8 });
    parser.push(encodeWebSocketFrame(Buffer.alloc(64), { opcode: WS_OPCODE.binary, mask: false }));
    expect(sink.messages).toHaveLength(0);
    expect(sink.errors[0]).toContain('size limit');
    expect(WS_CLOSE_MESSAGE_TOO_BIG).toBe(1009);
  });

  it('reports a close frame without a status code as 1005', () => {
    const sink = createSink();
    new WebSocketFrameParser(sink).push(encodeWebSocketFrame(Buffer.alloc(0), { opcode: WS_OPCODE.close, mask: false }));
    expect(sink.closes).toEqual([ { code: 1005, reason: '' } ]);
  });

  it('ignores pushes after a protocol failure', () => {
    const sink = createSink();
    const parser = new WebSocketFrameParser(sink);
    const invalid = encodeWebSocketFrame(Buffer.from('x'), { opcode: WS_OPCODE.continuation, mask: false });
    parser.push(invalid);
    parser.push(encodeWebSocketFrame(Buffer.from('after'), { opcode: WS_OPCODE.text, mask: false }));
    expect(sink.messages).toHaveLength(0);
    expect(sink.errors).toHaveLength(1);
  });

  it('uses a random mask key per frame', () => {
    const first = encodeWebSocketFrame(Buffer.alloc(8, 1), { opcode: WS_OPCODE.binary, mask: true });
    const second = encodeWebSocketFrame(Buffer.alloc(8, 1), { opcode: WS_OPCODE.binary, mask: true });
    expect(first.subarray(2, 6)).not.toEqual(second.subarray(2, 6));
    expect(randomBytes(4).length).toBe(4);
  });
});

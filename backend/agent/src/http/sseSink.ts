/**
 * AskEmitter over an HTTP response — ARCHITECTURE.md §2 (http/sseSink.ts). Frame and
 * header conventions mirror gateway/src/sse.ts: four anti-buffering headers, flush per
 * frame, `: keepalive` comments during silent research stretches.
 */
import type {
  DoneEvent,
  PlanEvent,
  SourcesEvent,
  StreamErrorEvent,
  TokenEvent,
  TraceEvent
} from '@lumina/contract';
import type { AskEmitter } from '../core/loop.js';

/** The slice of Express Response the sink touches; keeps tests transport-free. */
export interface SseResponse {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  /** Present when compression middleware wraps the response; harmless otherwise. */
  flush?(): void;
}

export interface SseSinkOptions {
  /** Injectable timer seam; returns a cancel function. Defaults to setInterval. */
  schedule?: (fn: () => void, ms: number) => () => void;
  keepaliveMs?: number;
}

export interface SseSink extends AskEmitter {
  /** Client disconnect: cancel the keepalive; later emits are silently ignored. */
  close(): void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

export function createSseSink(res: SseResponse, opts: SseSinkOptions = {}): SseSink {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  const cancelKeepalive = (opts.schedule ?? defaultSchedule)(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, opts.keepaliveMs ?? 15000);

  const send = (event: string, data: unknown): void => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    cancelKeepalive();
  };

  return {
    plan: (data: PlanEvent) => send('plan', data),
    trace: (data: TraceEvent) => send('trace', data),
    sources: (data: SourcesEvent) => send('sources', data),
    token: (data: TokenEvent) => send('token', data),
    done: (data: DoneEvent) => {
      send('done', data);
      close();
    },
    error: (data: StreamErrorEvent) => {
      send('error', data);
      close();
    },
    close
  };
}

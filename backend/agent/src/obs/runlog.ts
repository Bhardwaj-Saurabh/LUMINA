/**
 * RunLog builder — ARCHITECTURE.md §2 (obs/runlog.ts): runs/<requestId>.json (local)
 * AND upsert into the runs collection. Contract enforcement is the contract's own:
 * build() = RunLog.parse, so a failed call without an error string throws (A1).
 */
import { RunLog, type Depth, type Terminated, type ToolName } from '@lumina/contract';

export interface RunLogInput {
  depth: Depth;
  now: () => number;
}

export interface RunLogToolCall {
  name: ToolName;
  ok: boolean;
  error?: string;
  ms?: number;
}

export interface RunLogFinish {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  terminated: Terminated;
}

export interface RunLogPersist {
  requestId: string;
  writeFile: (path: string, content: string) => Promise<void>;
  upsert: (doc: Record<string, unknown>) => Promise<void>;
}

export interface RunLogBuilder {
  toolCall(call: RunLogToolCall): void;
  finish(totals: RunLogFinish): void;
  build(): RunLog;
  persist(seams: RunLogPersist): Promise<void>;
}

export function createRunLog({ depth, now }: RunLogInput): RunLogBuilder {
  const startedAt = now();
  const toolCalls: RunLogToolCall[] = [];
  let totals: (RunLogFinish & { endedAt: number }) | undefined;

  const build = (): RunLog => {
    if (!totals) throw new Error('runlog: finish() before build()');
    return RunLog.parse({
      tokens: totals.tokensIn + totals.tokensOut,
      wallClockSec: (totals.endedAt - startedAt) / 1000,
      costUsd: totals.costUsd,
      terminated: totals.terminated,
      depth,
      toolCalls
    });
  };

  return {
    toolCall: (call) => void toolCalls.push(call),
    finish: (f) => void (totals = { ...f, endedAt: now() }),
    build,
    persist: async ({ requestId, writeFile, upsert }) => {
      const log = build();
      await writeFile(`runs/${requestId}.json`, JSON.stringify(log, null, 2));
      await upsert({ requestId, ...log });
    }
  };
}

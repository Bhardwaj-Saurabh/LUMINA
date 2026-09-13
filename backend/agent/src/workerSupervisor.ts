/**
 * Worker supervision — ARCHITECTURE.md §6.1. The jobs worker runs as a CHILD PROCESS of
 * the agent, not as a promise inside it: parsing a 60-page PDF and packing 1536-float
 * batches is CPU work, and on the request thread it would show up as the bench's
 * search-during-ingest ratio blowing past 1.3.
 *
 * Cloud Run runs this container with `--no-cpu-throttling`, min 1 / max 1, because a
 * request-billed instance freezes a polling loop the moment a request ends.
 *
 * `WORKER_MODE=off` leaves it unstarted — that is how `npm run worker` runs standalone
 * without two workers competing for the same queue.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface SupervisorLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const RESTART_DELAY_MS = 2000;

/**
 * The worker sits next to this module, so its entry has this module's own extension:
 * `worker.ts` under tsx in dev, `worker.js` from dist in the container.
 */
function workerEntry(): string {
  const self = fileURLToPath(import.meta.url);
  return self.replace(/workerSupervisor\.(m?[tj]s)$/, 'worker.$1');
}

export function superviseWorker(log: SupervisorLog): void {
  const entry = workerEntry();
  let child: ChildProcess | undefined;
  let stopping = false;

  const start = (): void => {
    // Inherit execArgv so the tsx loader that is running us also runs the worker.
    child = spawn(process.execPath, [...process.execArgv, entry], {
      stdio: 'inherit',
      env: process.env
    });
    log.info({ entry, pid: child.pid }, 'jobs worker started as a child process');

    child.on('exit', (code, signal) => {
      if (stopping) return;
      log.warn({ code, signal }, 'jobs worker exited — restarting');
      setTimeout(start, RESTART_DELAY_MS).unref();
    });
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
      child?.kill(signal);
    });
  }

  start();
}

import { resolve } from 'node:path';
import type { Subprocess } from 'bun';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

export interface AppProcess {
  instanceId: string;
  port: number;
  baseUrl: string;
  /** Hard kill (no graceful shutdown), like a crashed container. */
  kill(): Promise<void>;
}

const usedPorts = new Set<number>();

function freshPort(): number {
  for (;;) {
    const port = 41_000 + Math.floor(Math.random() * 7_000);
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
}

async function waitUntilLive(baseUrl: string, process: Subprocess, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`app process exited early with code ${process.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`app at ${baseUrl} did not become live in ${timeoutMs}ms`);
}

/**
 * Starts the real application (`bun src/main.ts`) as a separate OS process,
 * with every background worker enabled: HTTP, SQS consumer, outbox publisher
 * and pending-reference worker.
 */
export async function spawnApp(
  env: Record<string, string>,
  instanceId: string,
  port = freshPort(),
): Promise<AppProcess> {
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      ...env,
      PORT: String(port),
      INSTANCE_ID: instanceId,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUntilLive(baseUrl, child);
  return {
    instanceId,
    port,
    baseUrl,
    async kill() {
      child.kill(9);
      await child.exited;
    },
  };
}

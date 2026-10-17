/**
 * @fileoverview Bounded JSON-RPC client for testing packaged stdio processes.
 * @module tests/fixtures/stdio-client
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Tool response fields inspected by artifact tests. */
export interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent: Record<string, unknown>;
}

/** Start one packaged server and always close its process after the probe. */
export async function withStdioServer(
  runtime: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  probe: (
    call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
  ) => Promise<void>,
): Promise<void> {
  const args = runtime === 'bun' ? ['--no-install', 'dist/index.js'] : ['dist/index.js'];
  const child = spawn(runtime, args, { cwd, env, stdio: 'pipe' });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: ToolResult) => void; reject: (error: Error) => void }
  >();
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', (code) => rejectPending(new Error(`Packaged server exited ${code}: ${stderr}`)));
  const timer = setTimeout(
    () => rejectPending(new Error(`Packaged server timed out: ${stderr}`)),
    30_000,
  );
  async function request(method: string, params: Record<string, unknown>): Promise<ToolResult> {
    const id = ++nextId;
    const response = new Promise<ToolResult>((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }
  try {
    await request('initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'artifact-test', version: '1' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    await probe((name, args) => request('tools/call', { name, arguments: args }));
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(killTimer);
    }
  }
}

/**
 * @fileoverview Characterizes standalone CLI readiness diagnostics and logging.
 * @module tests/scripts/mirror-cli.test
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openSqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureDb } from '../fixtures/build-fixture-db.js';

const exec = promisify(execFile);
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'faa-cli-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('standalone mirror verify diagnostics', () => {
  it.each(['initialized', 'cold', 'ready-empty'] as const)(
    'reports %s mirror readiness with visible logs',
    async (state) => {
      const mirrorPath = join(scratch, `${state}.db`);
      if (state !== 'cold') await buildFixtureDb(mirrorPath);
      if (state === 'ready-empty') {
        const handle = await openSqliteHandle(mirrorPath);
        handle.exec('DELETE FROM registration');
        handle.close();
      }
      const result = await exec('bun', ['run', 'mirror:verify'], {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          FAA_MIRROR_PATH: mirrorPath,
          LOGS_DIR: join(scratch, 'logs'),
          MCP_LOG_LEVEL: 'info',
        },
      }).then(
        ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
        (error) => ({ code: error.code, output: error.stdout + error.stderr }),
      );
      expect(result.code).toBe(state === 'initialized' ? 0 : 1);
      expect(result.output).toContain('FAA registry mirror status:');
      expect(result.output).toContain(
        state === 'initialized'
          ? 'integrity check passed'
          : state === 'cold'
            ? 'Mirror is NOT ready'
            : 'registration table is EMPTY',
      );
    },
  );
});

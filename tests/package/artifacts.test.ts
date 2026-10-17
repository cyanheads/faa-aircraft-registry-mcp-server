/**
 * @fileoverview Tests real npm and cleaned MCPB artifacts without checkout aliases.
 * @module tests/package/artifacts.test
 */

import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { openSqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureDb } from '../fixtures/build-fixture-db.js';
import { makeZip } from '../fixtures/make-zip.js';
import { type ToolResult, withStdioServer } from '../fixtures/stdio-client.js';

const exec = promisify(execFile);
const root = new URL('../../', import.meta.url).pathname;
const artifactDirectory = process.env.FAA_PACKAGE_TEST_ARTIFACTS_DIR;
let scratch: string;
let npm: string;
let mcpb: string;

function text(result: ToolResult): string {
  return result.content.map((block) => block.text ?? '').join('\n');
}

function environment(mirrorPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    MCP_TRANSPORT_TYPE: 'stdio',
    MCP_AUTH_MODE: 'none',
    // bunfig's run.bun prepends a node→Bun shim; Node probes must use real Node.
    PATH: process.env.PATH?.split(delimiter)
      .filter((entry) => !basename(entry).startsWith('bun-node-'))
      .join(delimiter),
    FAA_MIRROR_PATH: mirrorPath,
    FAA_REDACT_OWNER_PII: 'true',
    LOGS_DIR: join(scratch, 'logs'),
    MCP_LOG_LEVEL: 'info',
    OTEL_ENABLED: 'false',
  };
}

async function cli(
  cwd: string,
  command: string,
  mirrorPath: string,
  runtime = 'node',
  databaseUrl?: string,
) {
  const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  const entry = pkg.scripts[`mirror:${command}`].split(' ').at(-1);
  return exec(runtime, runtime === 'bun' ? ['--no-install', entry] : [entry], {
    cwd,
    env: { ...environment(mirrorPath), ...(databaseUrl ? { FAA_DATABASE_URL: databaseUrl } : {}) },
    timeout: 30_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (error) => ({ code: error.code, output: error.stdout + error.stderr }),
  );
}

beforeAll(async () => {
  scratch = await mkdtemp(join(artifactDirectory ?? tmpdir(), 'faa-artifacts-'));
  npm = join(scratch, 'package');
  mcpb = join(scratch, 'mcpb');
  const bundle = await exec('bun', ['run', 'bundle'], {
    cwd: root,
    // Full-tree pack + clean exceeded three minutes during concurrent package runs.
    timeout: 360_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  await writeFile(join(scratch, 'bundle.log'), bundle.stdout + bundle.stderr);
  const bundlePath = join(scratch, 'faa-aircraft-registry-mcp-server.mcpb');
  await cp(join(root, 'dist/faa-aircraft-registry-mcp-server.mcpb'), bundlePath);
  await exec('unzip', ['-q', bundlePath, '-d', mcpb]);
  const packed = await exec(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch],
    { cwd: root },
  );
  const [{ filename }] = JSON.parse(packed.stdout);
  await exec('tar', ['-xzf', join(scratch, filename), '-C', scratch]);
  // Only the dependency tree that survived actual MCPB cleaning supplies runtime modules.
  await cp(join(mcpb, 'node_modules'), join(npm, 'node_modules'), { recursive: true });
  if (artifactDirectory) console.info(`Package test artifacts: ${scratch}`);
}, 420_000);

afterAll(async () => {
  if (scratch && !artifactDirectory) await rm(scratch, { recursive: true, force: true });
});

describe('packaged mirror lifecycle', () => {
  it.each(['npm', 'mcpb'])(
    'ships the %s server entry without source or checkout configuration',
    async (artifact) => {
      const cwd = artifact === 'npm' ? npm : mcpb;
      const entries = await readdir(cwd);
      expect(entries).not.toContain('src');
      expect(entries).not.toContain('scripts');
      expect(entries).not.toContain('tsconfig.json');
      expect(await readFile(join(cwd, 'dist/index.js'), 'utf8')).toContain('createApp');
    },
  );

  it.each(['initialized', 'cold', 'ready-empty'] as const)(
    'verifies a %s mirror outside the checkout',
    async (state) => {
      const path = join(scratch, `${state}.db`);
      if (state !== 'cold') await buildFixtureDb(path);
      if (state === 'ready-empty') {
        const handle = await openSqliteHandle(path);
        handle.exec('DELETE FROM registration');
        handle.close();
      }
      const result = await cli(npm, 'verify', path);
      expect(result.code, result.output).toBe(state === 'initialized' ? 0 : 1);
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

  it.each(['npm', 'mcpb'])(
    'initializes and refreshes the %s fixture with visible ingest progress',
    async (artifact) => {
      const cwd = artifact === 'npm' ? npm : mcpb;
      let nNumber = '10000';
      const server = createServer((_request, response) => {
        const files = {
          'MASTER.txt': `N-NUMBER,MFR MDL CODE,ENG MFR MDL,NAME,STATUS CODE\n${nNumber},2072714,41514,FIXTURE OWNER,V\n`,
          'ACFTREF.txt': 'CODE,MFR,MODEL\n2072714,CESSNA,172S\n',
          'ENGINE.txt': 'CODE,MFR,MODEL\n41514,LYCOMING,IO-360\n',
          'DEREG.txt': 'N-NUMBER\n',
          'RESERVED.txt': 'N-NUMBER\n',
        };
        response.end(
          makeZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) }))),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected loopback fixture listener');
      const url = `http://127.0.0.1:${address.port}/fixture.zip`;
      const path = join(scratch, `${artifact}-ingested.db`);
      try {
        for (const command of ['init', 'refresh']) {
          const result = await cli(cwd, command, path, 'node', url);
          expect(result.code, result.output).toBe(0);
          expect(result.output).toContain(`FAA registry mirror ${command} complete`);
          expect(result.output).toContain('Ingested 1 aircraft reference rows');
          const handle = await openSqliteHandle(path);
          expect(handle.prepare('SELECT n_number FROM registration').all()).toEqual([
            { n_number: nNumber },
          ]);
          handle.close();
          nNumber = '20000';
        }
        expect((await cli(cwd, 'verify', path)).code).toBe(0);
        expect((await cli(cwd, 'verify', path, 'bun')).code).toBe(0);
        await withStdioServer('node', cwd, environment(path), async (call) => {
          const result = await call('faa_lookup_registration', { nNumber: 'N20000' });
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({
            nNumber: '20000',
            nNumberDisplay: 'N20000',
            make: 'CESSNA',
            ownerRedacted: true,
          });
          expect(text(result)).toContain('CESSNA');
          expect(text(result)).not.toContain('FIXTURE OWNER');
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe('cleaned Node MCPB', () => {
  it('stays below the 25 MiB bundle ceiling with all native prebuilts', async () => {
    expect(
      (await stat(join(root, 'dist/faa-aircraft-registry-mcp-server.mcpb'))).size,
    ).toBeLessThan(25 * 1024 * 1024);
  });
  it("runs Node probes with real Node rather than Bun's node shim", async () => {
    const result = await exec(
      'node',
      ['-p', 'JSON.stringify({version:process.version,bun:!!process.versions.bun})'],
      { env: environment(join(scratch, 'unused.db')) },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ bun: false });
  });

  it('retains every supplied cross-platform N-API prebuild', async () => {
    const platforms = ['darwin', 'linux', 'linuxmusl', 'win32'];
    const expected = platforms
      .flatMap((platform) => ['arm64', 'x64'].map((arch) => `${platform}-${arch}.node`))
      .sort();
    expect((await readdir(join(mcpb, 'node_modules/better-sqlite3/prebuilds'))).sort()).toEqual(
      expected,
    );
  });

  it('selects an existing prebuild for each supported OS, architecture and libc', async () => {
    const directory = join(mcpb, 'node_modules/better-sqlite3/lib');
    const source = await readFile(join(directory, 'binding.js'), 'utf8');
    for (const platform of ['darwin', 'linux', 'linuxmusl', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        const selected: string = runInNewContext(`${source}\nexports.getPrebuildPath()`, {
          exports: {},
          module: {},
          __dirname: directory,
          require: (name: string) => {
            if (name === 'fs') return { existsSync: () => true };
            if (name === 'path') return { join };
            throw new Error(`Unexpected binding import: ${name}`);
          },
          process: {
            platform: platform === 'linuxmusl' ? 'linux' : platform,
            arch,
            report: {
              getReport: () => ({
                header: platform === 'linux' ? { glibcVersionRuntime: '2.36' } : {},
              }),
            },
          },
        });
        expect(basename(selected)).toBe(`${platform}-${arch}.node`);
        const original = join(root, 'node_modules/better-sqlite3/prebuilds', basename(selected));
        expect((await readFile(selected)).equals(await readFile(original)), selected).toBe(true);
      }
    }
  });

  it.each(['node', 'bun'])(
    'queries the initialized artifact with %s on both response surfaces',
    async (runtime) => {
      const path = join(scratch, `${runtime}-wire.db`);
      await buildFixtureDb(path);
      await withStdioServer(runtime, mcpb, environment(path), async (call) => {
        const result = await call('faa_get_aircraft_type', { code: '2072714' });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          code: '2072714',
          manufacturer: 'CESSNA',
          model: '172S',
        });
        expect(JSON.stringify(result.content)).toContain('CESSNA');
        expect(JSON.stringify(result.content)).toContain('2072714');
        const first = await call('faa_search_aircraft_types', { query: 'cessna', limit: 1 });
        expect(first.structuredContent).toMatchObject({
          totalCount: 3,
          nextOffset: 1,
          truncated: true,
          shown: 1,
          cap: 1,
        });
        expect(text(first)).toContain('2072714');
        expect(text(first)).toContain('offset: 1');
        const second = await call('faa_search_aircraft_types', {
          query: 'cessna',
          limit: 1,
          offset: 1,
        });
        expect(second.structuredContent).toMatchObject({
          nextOffset: 2,
          aircraftTypes: [{ code: '2072715' }],
        });
        expect(text(second)).toContain('2072715');
        const last = await call('faa_search_aircraft_types', {
          query: 'cessna',
          limit: 1,
          offset: 2,
        });
        expect(last.structuredContent).toMatchObject({
          totalCount: 3,
          aircraftTypes: [{ code: '2072716' }],
        });
        expect(last.structuredContent).not.toHaveProperty('nextOffset');
        expect(text(last)).toContain('2072716');
        const past = await call('faa_search_aircraft_types', { query: 'cessna', offset: 50 });
        expect(past.structuredContent).toMatchObject({ aircraftTypes: [], totalCount: 3 });
        expect(text(past)).toContain('past the end');
        const empty = await call('faa_search_aircraft_types', { query: 'NONEXISTENT' });
        expect(empty.structuredContent).toMatchObject({ aircraftTypes: [], totalCount: 0 });
        expect(text(empty)).toContain('No aircraft types matched');
        for (const [code, reason, errorCode] of [
          ['ABC', 'invalid_code', JsonRpcErrorCode.ValidationError],
          ['9999999', 'not_found', JsonRpcErrorCode.NotFound],
        ] as const) {
          const error = await call('faa_get_aircraft_type', { code });
          expect(error.isError).toBe(true);
          expect(error.structuredContent).toMatchObject({
            error: {
              code: errorCode,
              data: {
                reason,
                recovery: { hint: expect.stringContaining('faa_search_aircraft_types') },
              },
            },
          });
          expect(text(error)).toContain(reason);
          expect(text(error)).toContain('faa_search_aircraft_types');
        }
      });
    },
  );

  it.each(['cold', 'ready-empty'] as const)(
    'returns actionable %s errors through real Node',
    async (state) => {
      const path = join(scratch, `${state}-wire.db`);
      if (state === 'ready-empty') {
        await buildFixtureDb(path);
        const handle = await openSqliteHandle(path);
        handle.exec('DELETE FROM registration');
        handle.close();
      }
      await withStdioServer('node', mcpb, environment(path), async (call) => {
        const result = await call('faa_get_aircraft_type', { code: '2072714' });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: { reason: state === 'cold' ? 'mirror_not_ready' : 'mirror_empty' },
          },
        });
        expect(text(result)).toContain('mirror:init');
      });
      const verify = await cli(mcpb, 'verify', path);
      expect(verify.code).toBe(1);
      expect(verify.output).toContain(
        state === 'cold' ? 'Mirror is NOT ready' : 'registration table is EMPTY',
      );
    },
  );
});

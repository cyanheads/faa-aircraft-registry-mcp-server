/**
 * @fileoverview End-to-end regression guard for the FAA ingester over a small,
 * synthetic ZIP at the download boundary. It
 * exercises the whole rebuild path the memory fix touches: lazy per-entry
 * decompression, streaming line parsing straight from the entry buffers, the
 * chunked auxiliary inserts, and the MASTER → ACFTREF/ENGINE join. The MASTER and
 * DEREG fixtures deliberately exceed the ingester's 5000-row page/batch size so
 * the multi-page and multi-transaction paths run, and a row referencing an unknown
 * type code proves the join fabricates nothing for a missing reference.
 * @module tests/services/ingest.test
 */

import { type Mirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRegistryMirror } from '@/services/registry/registry-mirror.js';
import { withRegistrySnapshot } from '@/services/registry/registry-snapshot.js';
import { registrationStoreSpec } from '@/services/registry/schema.js';
import { buildFixtureDb, tempDbPath } from '../fixtures/build-fixture-db.js';
import { makeZip, type ZipInput } from '../fixtures/make-zip.js';

/** Rows beyond one page — forces the MASTER paging / DEREG batching to loop. */
const OVER_ONE_PAGE = 5003;

const engineTxt = 'CODE,MFR,MODEL,TYPE,HORSEPOWER\n41514,LYCOMING,IO-360,1,180\n';
const acftrefTxt =
  'CODE,MFR,MODEL,TYPE-ACFT,TYPE-ENG,NO-ENG,NO-SEATS\n2072714,CESSNA,172S,4,1,1,4\n';

/** MASTER with a known-good row, an unknown-type-code row, then filler past a page. */
function masterTxt(): string {
  const header = 'N-NUMBER,MFR MDL CODE,ENG MFR MDL,NAME,STATUS CODE,MODE S CODE HEX,YEAR MFR';
  const rows = [
    '10000,2072714,41514,OWNER GOOD,V,A00000,2010', // joins CESSNA/172S/LYCOMING
    '10001,9999999,41514,OWNER ORPHAN,V,A00001,2011', // unknown aircraft code → make null
  ];
  for (let i = rows.length; i < OVER_ONE_PAGE; i++) {
    rows.push(`${20000 + i},2072714,41514,FILLER ${i},V,B${String(i).padStart(5, '0')},2000`);
  }
  return `${header}\n${rows.join('\n')}\n`;
}

/** DEREG with a known row, then filler past a batch. */
function deregTxt(): string {
  const header =
    'N-NUMBER,SERIAL NUMBER,MFR MDL CODE,STATUS CODE,CANCEL DATE,MODE S CODE HEX,NAME,CITY,STATE';
  const rows = ['90001,DSN1,2072714,22,20200615,DEAD01,FORMER OWNER,RENTON,WA'];
  for (let i = rows.length; i < OVER_ONE_PAGE - 1; i++) {
    rows.push(
      `${90000 + i},DSN${i},2072714,22,20200615,C${String(i).padStart(5, '0')},GONE ${i},KENT,WA`,
    );
  }
  return `${header}\n${rows.join('\n')}\n`;
}

const reservedTxt =
  'N-NUMBER,REGISTRANT,CITY,STATE,TR,RSV DATE\n70001,RESERVER LLC,TACOMA,WA,FP,20260101\n70002,SKY HOLD,OLYMPIA,WA,FP,20260201\n';

let restoreFetch: () => void;
let mirror: Mirror;

beforeAll(async () => {
  const zip = makeZip([
    { name: 'ENGINE.txt', data: Buffer.from(engineTxt, 'latin1') },
    { name: 'ACFTREF.txt', data: Buffer.from(acftrefTxt, 'latin1') },
    { name: 'MASTER.txt', data: Buffer.from(masterTxt(), 'latin1') },
    { name: 'DEREG.txt', data: Buffer.from(deregTxt(), 'latin1') },
    { name: 'RESERVED.txt', data: Buffer.from(reservedTxt, 'latin1') },
    { name: 'DEALER.txt', data: Buffer.from('X,Y\n1,2\n', 'latin1') }, // present but never read
  ]);

  const fetchZip = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(zip));
  restoreFetch = () => fetchZip.mockRestore();
  const url = 'https://example.invalid/ReleasableAircraft.zip';

  mirror = createRegistryMirror({ mirrorPath: tempDbPath(), databaseUrl: url });
  await mirror.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
}, 60_000);

afterAll(async () => {
  await mirror?.close();
  restoreFetch?.();
});

describe('FAA mirror rebuild', () => {
  async function count(table: string): Promise<number> {
    const handle = await mirror.raw();
    return handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
  }

  it('ingests every table across page/batch boundaries', async () => {
    expect(await count('registration')).toBe(OVER_ONE_PAGE);
    expect(await count('dereg')).toBe(OVER_ONE_PAGE - 1);
    expect(await count('reserved')).toBe(2);
    expect(await count('aircraft_ref')).toBe(1);
    expect(await count('engine_ref')).toBe(1);
  });

  it('joins MASTER → ACFTREF/ENGINE with decoded make/model/engine', async () => {
    const [row] = await mirror.getByIds(['10000']);
    expect(row?.make).toBe('CESSNA');
    expect(row?.model).toBe('172S');
    expect(row?.engine_make).toBe('LYCOMING');
    expect(row?.aircraft_type_code).toBe('4');
    expect(row?.mode_s_code_hex).toBe('A00000');
    expect(row?.year_mfr).toBe(2010);
  });

  it('fabricates nothing when a MASTER row references an unknown type code', async () => {
    const [row] = await mirror.getByIds(['10001']);
    expect(row?.make).toBeNull();
    expect(row?.model).toBeNull();
    // The engine code is known, so the engine join still resolves.
    expect(row?.engine_make).toBe('LYCOMING');
  });

  it('populates the dereg table with parsed + normalized fields', async () => {
    const handle = await mirror.raw();
    const row = handle
      .prepare<{ cancel_date: string; owner_name: string }>(
        'SELECT cancel_date, owner_name FROM dereg WHERE n_number = ?',
      )
      .get('90001');
    expect(row?.owner_name).toBe('FORMER OWNER');
    expect(row?.cancel_date).toBe('2020-06-15'); // FAA YYYYMMDD → ISO
  });
});

/** Run the real ingest generator against a private seeded store and synthetic ZIP. */
async function manifestProbe(
  entries: ZipInput[],
  expectedError?: string,
  corruptFirst = false,
  dataAsOf?: string,
): Promise<void> {
  const path = tempDbPath();
  await buildFixtureDb(path);
  const mirror = createRegistryMirror({
    mirrorPath: path,
    databaseUrl: 'https://example.invalid/fixture.zip',
  });
  const handle = await mirror.raw();
  const zip = makeZip(entries);
  if (corruptFirst) zip.writeUInt32LE(0, 0);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(zip));
  try {
    const run = mirror.runSync({ mode: 'init', signal: AbortSignal.timeout(5000) });
    if (expectedError) {
      await expect(run).rejects.toThrow(new RegExp(expectedError, 'i'));
      expect(withRegistrySnapshot(handle, (snapshot) => snapshot)).toEqual({});
      for (const [table, total] of [
        ['registration', 4],
        ['aircraft_ref', 6],
        ['engine_ref', 1],
        ['dereg', 1],
        ['reserved', 1],
      ] as const) {
        expect(handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(
          total,
        );
      }
      expect(
        handle.prepare('SELECT * FROM registration WHERE n_number = ?').get('12345'),
      ).toBeDefined();
    } else {
      await run;
      expect(handle.prepare('SELECT n_number FROM registration').all()).toEqual([
        { n_number: '10000' },
      ]);
      expect(withRegistrySnapshot(handle, (snapshot) => snapshot.dataAsOf)).toBe(dataAsOf);
    }
  } finally {
    fetch.mockRestore();
    await mirror.close();
  }
}

const auxiliaryEntries: ZipInput[] = [
  { name: 'ENGINE.txt', data: Buffer.from(engineTxt) },
  { name: 'ACFTREF.txt', data: Buffer.from(acftrefTxt) },
  { name: 'DEREG.txt', data: Buffer.from(deregTxt()) },
  { name: 'RESERVED.txt', data: Buffer.from(reservedTxt) },
];
const oneMaster = Buffer.from('N-NUMBER,MFR MDL CODE\n10000,2072714\n');
const nov9 = ((2026 - 1980) << 9) | (11 << 5) | 9;

describe('archive manifest', () => {
  it.each(['ENGINE.txt', 'ACFTREF.txt', 'DEREG.txt', 'RESERVED.txt'])(
    'rejects missing %s without wiping any table',
    async (missing) => {
      await manifestProbe(
        [
          ...auxiliaryEntries.filter((entry) => entry.name !== missing),
          { name: 'MASTER.txt', data: oneMaster },
        ],
        missing,
      );
    },
  );

  it('rejects a partial split even when a legacy MASTER is present', async () => {
    await manifestProbe(
      [
        ...auxiliaryEntries,
        { name: 'MASTER-1.txt', data: oneMaster },
        { name: 'MASTER.txt', data: oneMaster },
      ],
      'MASTER-2.txt',
    );
  });

  it.each(['MASTER-0.txt', 'MASTER-10.txt', 'MASTER-01.txt'])(
    'rejects unexpected %s without falling back to legacy',
    async (name) => {
      await manifestProbe(
        [...auxiliaryEntries, { name: 'MASTER.txt', data: oneMaster }, { name, data: oneMaster }],
        name.toUpperCase(),
      );
    },
  );

  it('rejects an archive with no MASTER without wiping', async () => {
    await manifestProbe(auxiliaryEntries, 'MASTER.txt');
  });

  it('rejects a sole MASTER part before inflating its corrupt body', async () => {
    const entry = { name: 'MASTER-1.txt', data: oneMaster };
    await manifestProbe([entry], 'ACFTREF.txt', true);
  });

  it('accepts all nine split parts and ignores legacy when parts are present', async () => {
    await manifestProbe(
      [
        ...auxiliaryEntries,
        ...Array.from({ length: 9 }, (_, i) => ({
          name: `folder/MASTER-${i + 1}.TXT`,
          data: i === 0 ? oneMaster : Buffer.from('N-NUMBER\n'),
          dosDate: nov9 + i,
        })),
        { name: 'MASTER.txt', data: Buffer.from('N-NUMBER\n90000\n'), dosDate: nov9 + 1 },
      ],
      undefined,
      false,
      '2026-11-09',
    );
  });
  it('accepts complete legacy archives using case-insensitive nested basenames', async () => {
    await manifestProbe(
      [...auxiliaryEntries, { name: 'MASTER.txt', data: oneMaster, dosDate: nov9 }].map(
        (entry) => ({
          ...entry,
          name: `folder/nested/${entry.name.toLowerCase()}`,
        }),
      ),
      undefined,
      false,
      '2026-11-09',
    );
  });
});

describe('generation publication', () => {
  const databaseUrl = 'https://example.invalid/registry.zip';
  const smallAuxiliaryEntries: ZipInput[] = auxiliaryEntries.map((entry) =>
    entry.name === 'DEREG.txt' ? { ...entry, data: Buffer.from('N-NUMBER\n') } : entry,
  );
  const fixtureArchive = (number: string, dosDate: number): Buffer =>
    makeZip([
      ...smallAuxiliaryEntries,
      { name: 'MASTER.txt', dosDate, data: Buffer.from(`N-NUMBER\n${number}\n`) },
    ]);

  it('blocks a separate reader during and after an abort that leaves one page committed', async () => {
    const mirrorPath = tempDbPath();
    const mirror = createRegistryMirror({ mirrorPath, databaseUrl });
    const reader = sqliteMirrorStore(registrationStoreSpec(mirrorPath));
    const stop = new AbortController();
    const abortedArchive = makeZip([
      ...smallAuxiliaryEntries,
      {
        name: 'MASTER.txt',
        dosDate: nov9 + 1,
        data: Buffer.from(
          `N-NUMBER\n${Array.from({ length: 5001 }, (_, i) => 10000 + i).join('\n')}\n`,
        ),
      },
    ]);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(fixtureArchive('99991', nov9)))
      .mockImplementationOnce(async () => new Response(abortedArchive))
      .mockImplementationOnce(async () => new Response(fixtureArchive('99992', nov9 + 2)));
    try {
      await mirror.runSync({ mode: 'init' });
      const handle = await reader.raw();
      const readDate = () => withRegistrySnapshot(handle, (snapshot) => snapshot.dataAsOf);
      const loading = expect.objectContaining({
        data: { reason: 'mirror_loading', retryable: true },
      });
      expect(readDate()).toBe('2026-11-09');
      await expect(
        mirror.runSync({
          mode: 'refresh',
          signal: stop.signal,
          onProgress(progress) {
            expect(progress.records).toBe(5000);
            expect(readDate).toThrow(loading);
            stop.abort(new Error('Stopped after first page'));
          },
        }),
      ).rejects.toThrow('Stopped after first page');
      expect(await reader.count()).toBe(5000);
      expect(readDate).toThrow(loading);
      await mirror.runSync({ mode: 'refresh' });
      expect(readDate()).toBe('2026-11-11');
      expect(await reader.count()).toBe(1);
    } finally {
      fetch.mockRestore();
      await Promise.all([mirror.close(), reader.close()]);
    }
  });

  it('keeps the old date and data when the download fails before the wipe', async () => {
    const mirror = createRegistryMirror({ mirrorPath: tempDbPath(), databaseUrl });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(fixtureArchive('12345', nov9)))
      .mockImplementationOnce(async () => new Response(null, { status: 503 }));
    try {
      await mirror.runSync({ mode: 'init' });
      await expect(mirror.runSync({ mode: 'refresh' })).rejects.toThrow('HTTP 503');
      const handle = await mirror.raw();
      expect(
        withRegistrySnapshot(handle, (snapshot) => ({
          ...snapshot,
          rows: handle.prepare('SELECT n_number FROM registration').all(),
        })),
      ).toEqual({ dataAsOf: '2026-11-09', rows: [{ n_number: '12345' }] });
    } finally {
      fetch.mockRestore();
      await mirror.close();
    }
  });

  it('rejects an expired writer before it can wipe the takeover generation', async () => {
    const mirrorPath = tempDbPath();
    const stale = createRegistryMirror({ mirrorPath, databaseUrl });
    const fresh = createRegistryMirror({ mirrorPath, databaseUrl });
    const entered = Promise.withResolvers<void>();
    const first = Promise.withResolvers<Response>();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => {
        entered.resolve();
        return first.promise;
      })
      .mockImplementationOnce(async () => new Response(fixtureArchive('20002', nov9 + 1)));
    const staleRun = stale.runSync({ mode: 'refresh' });
    // Attach the rejection assertion before unblocking the async download.
    const rejected = expect(staleRun).rejects.toMatchObject({
      data: { reason: 'sync_lease_lost' },
    });
    try {
      await entered.promise;
      await expect(stale.runSync({ mode: 'refresh' })).rejects.toMatchObject({
        data: { reason: 'sync_locked' },
      });
      const handle = await fresh.raw();
      handle.exec('UPDATE mirror_sync_lease SET expires_at = 0');
      await fresh.runSync({ mode: 'refresh' });
      first.resolve(new Response(fixtureArchive('10001', nov9)));
      await rejected;
      expect(
        withRegistrySnapshot(handle, (snapshot) => ({
          ...snapshot,
          rows: handle.prepare('SELECT n_number FROM registration').all(),
        })),
      ).toEqual({ dataAsOf: '2026-11-10', rows: [{ n_number: '20002' }] });
    } finally {
      first.resolve(new Response(null, { status: 503 }));
      await Promise.allSettled([staleRun, rejected]);
      fetch.mockRestore();
      await Promise.all([stale.close(), fresh.close()]);
    }
  });

  it('keeps the generation loading when the terminal state transaction fails', async () => {
    const mirror = createRegistryMirror({ mirrorPath: tempDbPath(), databaseUrl });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(fixtureArchive('12345', nov9)));
    try {
      const handle = await mirror.raw();
      handle.exec(`
        CREATE TRIGGER reject_terminal BEFORE UPDATE OF status ON mirror_sync_state
        WHEN NEW.status = 'complete'
        BEGIN SELECT RAISE(ABORT, 'terminal commit failed'); END;
      `);
      await expect(mirror.runSync({ mode: 'init' })).rejects.toThrow('terminal commit failed');
      expect(await mirror.store.count()).toBe(1);
      expect(() => withRegistrySnapshot(handle, () => undefined)).toThrow(
        expect.objectContaining({ data: { reason: 'mirror_loading', retryable: true } }),
      );
      handle.exec('DROP TRIGGER reject_terminal');
      await mirror.runSync({ mode: 'refresh' });
      expect(withRegistrySnapshot(handle, (snapshot) => snapshot)).toEqual({
        dataAsOf: '2026-11-09',
      });
    } finally {
      fetch.mockRestore();
      await mirror.close();
    }
  });
});

describe('manufacturer classification and cancellation fields', () => {
  it('considers primary and co-owners in both files, preferring MASTER organizations', async () => {
    const mirror = createRegistryMirror({
      mirrorPath: tempDbPath(),
      databaseUrl: 'https://example.invalid/registry.zip',
    });
    const zip = makeZip([
      { name: 'ENGINE.txt', data: Buffer.from(engineTxt) },
      { name: 'RESERVED.txt', data: Buffer.from(reservedTxt) },
      {
        name: 'ACFTREF.txt',
        data: Buffer.from(
          [
            'CODE,MFR,MODEL,BUILD-CERT-IND',
            '1000001,MASTER PRIMARY,MX,1',
            '1000002,MASTER OTHER,MX,2',
            '1000003,DEREG PRIMARY,MX,1',
            '1000004,DEREG OTHER,MX,2',
            '1000005,ORGANIZATION,MX,2',
            '1000006,CERTIFIED,MX,0',
            '1000007,UNMATCHED,MX,1',
            '1000008,UNKNOWN,MX,',
          ].join('\n'),
        ),
      },
      {
        name: 'DEREG.txt',
        data: Buffer.from(
          [
            'N-NUMBER,MFR-MDL-CODE,NAME,OTHER-NAMES(5),EXP-COUNTRY,YEAR-MFR',
            '44441,1000003, dereg primary ,,CANADA,1987',
            '44442,1000004,OTHER OWNER,DEREG OTHER,,',
            '44443,1000005,ORGANIZATION,,,',
          ].join('\n'),
        ),
      },
      {
        name: 'MASTER.txt',
        data: Buffer.from(
          [
            'N-NUMBER,MFR MDL CODE,NAME,OTHER NAMES(5),TYPE REGISTRANT,CERTIFICATION',
            '11111,1000001, master primary ,,1,6  A  ',
            '22222,1000002,OTHER OWNER,MASTER OTHER,1,',
            '33333,1000005,ORGANIZATION,,7,',
            '44444,1000006,CERTIFIED,,1,',
          ].join('\n'),
        ),
      },
    ]);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(zip));
    try {
      await mirror.runSync({ mode: 'init' });
      const handle = await mirror.raw();
      const flags = handle
        .prepare<{ manufacturer_redacted: number | null }>(
          'SELECT manufacturer_redacted FROM aircraft_ref ORDER BY code',
        )
        .all();
      expect(flags.map((row) => row.manufacturer_redacted)).toEqual([1, 1, 1, 1, 0, 0, 0, null]);
      expect(
        handle
          .prepare('SELECT export_country, year_mfr FROM dereg ORDER BY n_number LIMIT 2')
          .all(),
      ).toEqual([
        { export_country: 'CANADA', year_mfr: 1987 },
        { export_country: null, year_mfr: null },
      ]);
      expect(
        handle
          .prepare('SELECT approved_operations_raw FROM registration WHERE n_number = ?')
          .get('11111'),
      ).toEqual({
        approved_operations_raw: '  A',
      });
      const persistedDereg = handle.prepare('SELECT * FROM dereg WHERE n_number = ?').get('44442');
      expect(JSON.stringify(persistedDereg)).not.toContain('DEREG OTHER');
    } finally {
      fetch.mockRestore();
      await mirror.close();
    }
  });
});

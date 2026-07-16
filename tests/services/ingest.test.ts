/**
 * @fileoverview End-to-end regression guard for the FAA ingester over a small,
 * synthetic ZIP served from localhost — no multi-hundred-MB real archive. It
 * exercises the whole rebuild path the memory fix touches: lazy per-entry
 * decompression, streaming line parsing straight from the entry buffers, the
 * chunked auxiliary inserts, and the MASTER → ACFTREF/ENGINE join. The MASTER and
 * DEREG fixtures deliberately exceed the ingester's 5000-row page/batch size so
 * the multi-page and multi-transaction paths run, and a row referencing an unknown
 * type code proves the join fabricates nothing for a missing reference.
 * @module tests/services/ingest.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defineMirror, type Mirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFaaIngester } from '@/services/registry/ingest.js';
import { registrationStoreSpec } from '@/services/registry/schema.js';
import { tempDbPath } from '../fixtures/build-fixture-db.js';
import { makeZip } from '../fixtures/make-zip.js';

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

let server: Server;
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

  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    res.end(zip);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ReleasableAircraft.zip`;

  const store = sqliteMirrorStore(registrationStoreSpec(tempDbPath()));
  mirror = defineMirror({
    name: 'faa-registry-test',
    store,
    sync: createFaaIngester(() => store.raw(), url),
  });
  await mirror.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
}, 60_000);

afterAll(async () => {
  await mirror?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('createFaaIngester — end-to-end rebuild', () => {
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

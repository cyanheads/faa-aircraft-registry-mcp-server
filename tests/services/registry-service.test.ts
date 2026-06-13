/**
 * @fileoverview Behavior tests for the registry service over a synthetic fixture
 * DB — N-number normalization, the owner-PII redaction gate in both modes
 * (including owner-search disablement), the active/deregistered/reserved/unknown
 * status split, capped-search truncation disclosure, and sparse-record handling.
 * @module tests/services/registry-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RegistryService } from '@/services/registry/registry-service.js';
import { buildFixtureDb, tempDbPath } from '../fixtures/build-fixture-db.js';

const ctx = createMockContext();

/** Build a service pointed at a freshly-seeded fixture DB. */
async function makeService(redactOwnerPii: boolean): Promise<RegistryService> {
  const path = tempDbPath();
  await buildFixtureDb(path);
  return new RegistryService({
    redactOwnerPii,
    mirrorPath: path,
    databaseUrl: 'https://example.invalid/never-downloaded.zip',
  });
}

describe('RegistryService — N-number normalization', () => {
  let service: RegistryService;
  beforeEach(async () => {
    service = await makeService(false);
  });
  afterEach(async () => {
    await service.mirrorInstance.close();
  });

  it('resolves the same record for N12345, 12345, and n12345', async () => {
    const withN = await service.lookupRegistration('N12345', ctx);
    const without = await service.lookupRegistration('12345', ctx);
    const lower = await service.lookupRegistration('n12345', ctx);
    expect(withN?.nNumber).toBe('12345');
    expect(without?.nNumber).toBe('12345');
    expect(lower?.nNumber).toBe('12345');
    expect(withN?.nNumberDisplay).toBe('N12345');
  });

  it('joins MASTER → ACFTREF → ENGINE and decodes coded fields', async () => {
    const r = await service.lookupRegistration('N12345', ctx);
    expect(r?.make).toBe('CESSNA');
    expect(r?.model).toBe('172S');
    expect(r?.engineMake).toBe('LYCOMING');
    expect(r?.aircraftType).toEqual({ code: '4', label: 'Fixed-wing single-engine' });
    expect(r?.engineType).toEqual({ code: '1', label: 'Reciprocating' });
    expect(r?.status).toEqual({ code: 'V', label: 'Valid registration' });
    expect(r?.modeSCodeHex).toBe('A4E2D9');
    expect(r?.yearManufactured).toBe(2008);
  });

  it('returns undefined for a well-formed but unknown N-number', async () => {
    expect(await service.lookupRegistration('N00000', ctx)).toBeUndefined();
  });
});

describe('RegistryService — owner-PII redaction gate', () => {
  it('exposes owner detail when redaction is OFF', async () => {
    const service = await makeService(false);
    const r = await service.lookupRegistration('N12345', ctx);
    expect(r?.ownerRedacted).toBe(false);
    expect(r?.owner?.name).toBe('JOHN Q PUBLIC');
    expect(r?.owner?.street).toBe('123 RUNWAY RD');
    expect(r?.owner?.typeRegistrant).toEqual({ code: '1', label: 'Individual' });
    await service.mirrorInstance.close();
  });

  it('surfaces co-owner names when redaction is OFF', async () => {
    const service = await makeService(false);
    const r = await service.lookupRegistration('N5RP', ctx);
    expect(r?.owner?.otherNames).toEqual(['JANE ROE', 'RICHARD POE']);
    expect(r?.owner?.typeRegistrant).toEqual({ code: '7', label: 'LLC' });
    await service.mirrorInstance.close();
  });

  it('drops all owner fields and flags ownerRedacted when redaction is ON', async () => {
    const service = await makeService(true);
    const r = await service.lookupRegistration('N12345', ctx);
    expect(r?.ownerRedacted).toBe(true);
    expect(r?.owner).toBeUndefined();
    // Aircraft facts still flow.
    expect(r?.make).toBe('CESSNA');
    expect(r?.modeSCodeHex).toBe('A4E2D9');
    await service.mirrorInstance.close();
  });

  it('omits ownerName from search summaries when redaction is ON', async () => {
    const service = await makeService(true);
    const page = await service.searchRegistrations({ makeModel: 'cessna', limit: 25 }, ctx);
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.ownerRedacted).toBe(true);
      expect(item.ownerName).toBeUndefined();
    }
    await service.mirrorInstance.close();
  });

  it('reports owner-search disabled when redaction is ON, enabled when OFF', async () => {
    const redacted = await makeService(true);
    const open = await makeService(false);
    expect(redacted.ownerSearchEnabled).toBe(false);
    expect(open.ownerSearchEnabled).toBe(true);
    await redacted.mirrorInstance.close();
    await open.mirrorInstance.close();
  });

  it('ignores an ownerName filter under redaction (no owner-search leak via probing)', async () => {
    const service = await makeService(true);
    // The service drops the ownerName term when redaction is on; a probe for a
    // known owner must not narrow to that owner's aircraft.
    const probed = await service.searchRegistrations(
      { ownerName: 'JOHN Q PUBLIC', makeModel: 'cessna', limit: 25 },
      ctx,
    );
    const plain = await service.searchRegistrations({ makeModel: 'cessna', limit: 25 }, ctx);
    expect(probed.items.length).toBe(plain.items.length);
    await service.mirrorInstance.close();
  });
});

describe('RegistryService — registration status resolution', () => {
  let service: RegistryService;
  beforeEach(async () => {
    service = await makeService(true);
  });
  afterEach(async () => {
    await service.mirrorInstance.close();
  });

  it('resolves an active number to recordType active', async () => {
    const s = await service.getRegistrationStatus('N12345', ctx);
    expect(s.recordType).toBe('active');
    if (s.recordType === 'active') {
      expect(s.status).toEqual({ code: 'V', label: 'Valid registration' });
      expect(s.airworthinessClass).toEqual({ code: '1', label: 'Standard' });
    }
  });

  it('resolves a cancelled number to recordType deregistered', async () => {
    const s = await service.getRegistrationStatus('N404ER', ctx);
    expect(s.recordType).toBe('deregistered');
    if (s.recordType === 'deregistered') {
      expect(s.cancelDate).toBe('2020-06-15');
      expect(s.status).toEqual({ code: '22', label: 'Revoked-Canceled' });
      expect(s.modeSCodeHex).toBe('DEADBE');
    }
  });

  it('resolves a reserved number to recordType reserved', async () => {
    const s = await service.getRegistrationStatus('N777RZ', ctx);
    expect(s.recordType).toBe('reserved');
    if (s.recordType === 'reserved') {
      expect(s.typeReservation).toEqual({ code: 'FP', label: 'Fee paid' });
      expect(s.reserveDate).toBe('2026-01-01');
      expect(s.purgeDate).toBe('2026-07-01');
    }
  });

  it('resolves a never-issued number to recordType unknown (not an error)', async () => {
    const s = await service.getRegistrationStatus('N00000', ctx);
    expect(s.recordType).toBe('unknown');
    expect(s.nNumberDisplay).toBe('N00000');
  });
});

describe('RegistryService — search truncation disclosure', () => {
  let service: RegistryService;
  beforeEach(async () => {
    service = await makeService(true);
  });
  afterEach(async () => {
    await service.mirrorInstance.close();
  });

  it('flags truncated=true when the cap is hit', async () => {
    // Two Cessnas in the fixture; a limit of 1 must disclose truncation.
    const page = await service.searchRegistrations({ makeModel: 'cessna', limit: 1 }, ctx);
    expect(page.items).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(page.cap).toBe(1);
  });

  it('flags truncated=false when the result set fits under the cap', async () => {
    const page = await service.searchRegistrations({ makeModel: 'cessna', limit: 25 }, ctx);
    expect(page.truncated).toBe(false);
  });
});

describe('RegistryService — sparse records and aircraft types', () => {
  let service: RegistryService;
  beforeEach(async () => {
    service = await makeService(false);
  });
  afterEach(async () => {
    await service.mirrorInstance.close();
  });

  it('handles a sparse active record without fabricating blank fields', async () => {
    const r = await service.lookupRegistration('N99SP', ctx);
    expect(r).toBeDefined();
    expect(r?.yearManufactured).toBeUndefined();
    expect(r?.make).toBeUndefined();
    expect(r?.owner).toBeUndefined(); // no owner_name on the record
    expect(r?.status).toEqual({ code: 'V', label: 'Valid registration' });
    expect(r?.fractionalOwner).toBe(false);
  });

  it('decodes a full aircraft type record', async () => {
    const a = await service.getAircraftType('2072714', ctx);
    expect(a?.manufacturer).toBe('CESSNA');
    expect(a?.category).toEqual({ code: '1', label: 'Land' });
    expect(a?.builderCertification).toEqual({ code: '0', label: 'Type Certificated' });
    expect(a?.numberOfEngines).toBe(1);
    expect(a?.numberOfSeats).toBe(4);
    expect(a?.weightClass).toBe('CLASS 1');
    expect(a?.cruiseSpeedMph).toBe(124);
  });

  it('preserves blanks on a sparse aircraft type record', async () => {
    const a = await service.getAircraftType('1234567', ctx);
    expect(a?.manufacturer).toBe('SPARSE AERO');
    expect(a?.numberOfEngines).toBeUndefined();
    expect(a?.cruiseSpeedMph).toBeUndefined();
    expect(a?.category).toBeUndefined();
  });

  it('finds aircraft types by name via FTS', async () => {
    const page = await service.searchAircraftTypes({ query: 'cessna', limit: 25 }, ctx);
    expect(page.items.some((i) => i.code === '2072714')).toBe(true);
  });

  it('returns undefined for an unknown aircraft type code', async () => {
    expect(await service.getAircraftType('0000000', ctx)).toBeUndefined();
  });
});

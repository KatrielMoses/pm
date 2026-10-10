import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashEqual,
  isPrivateAddress,
  signPayload,
  signatureHeader,
  signaturesMatch,
  tokenHash,
} from '../../src/integrations/semantics.ts';

describe('webhook signatures and address checks', () => {
  it('signs the id, timestamp, and raw body and accepts a rotated secret', () => {
    const body = '{"type":"task.capture"}';
    const first = signPayload('secret-a', 'evt_1', '1700000000', body);
    const second = signPayload('secret-b', 'evt_1', '1700000000', body);
    const header = signatureHeader([first, second]);
    expect(signaturesMatch(['secret-b'], 'evt_1', '1700000000', body, header)).toBe(true);
    expect(signaturesMatch(['other'], 'evt_1', '1700000000', body, header)).toBe(false);
    expect(signaturesMatch(['secret-a'], 'evt_1', '1700000001', body, header)).toBe(false);
  });

  it('hashes a token without keeping the secret and rejects private addresses', () => {
    const hash = tokenHash('pm_abcdefghijklmnop');
    expect(hash).toHaveLength(32);
    expect(hashEqual(hash, tokenHash('pm_abcdefghijklmnop'))).toBe(true);
    expect(hashEqual(hash, tokenHash('pm_other'))).toBe(false);
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('192.168.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(createHmac('sha256', 'secret-a').update('evt_1.1700000000.{}').digest('base64')).toBe(
      signPayload('secret-a', 'evt_1', '1700000000', '{}'),
    );
  });
});

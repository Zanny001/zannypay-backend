import * as crypto from 'crypto';
import {
  RotationTarget,
  decryptWithKey,
  encryptWithKey,
  parseKey,
  rotateCiphertext,
  rotateTarget,
} from './key-rotation';

describe('encryption key rotation', () => {
  const oldKey = crypto.randomBytes(32);
  const newKey = crypto.randomBytes(32);

  it('validates 32-byte hex keys', () => {
    expect(parseKey(oldKey.toString('hex'), 'OLD_KEY')).toHaveLength(32);
    expect(() => parseKey('bad', 'OLD_KEY')).toThrow('64 hex characters');
  });

  it('rotates ciphertext and verifies it under the new key', () => {
    const result = rotateCiphertext(encryptWithKey('customer-secret', oldKey), oldKey, newKey);
    expect(result.status).toBe('rotated');
    expect(decryptWithKey((result as any).value, newKey)).toBe('customer-secret');
  });

  it('recognizes values already encrypted with the new key', () => {
    expect(rotateCiphertext(encryptWithKey('secret', newKey), oldKey, newKey).status)
      .toBe('already-rotated');
  });

  it('rejects an undecryptable payload without exposing its contents', () => {
    expect(rotateCiphertext('not-ciphertext', oldKey, newKey).status).toBe('failed');
  });

  it('dry-runs without writing and reports the planned count', async () => {
    const rows = [{ id: 'a', value: encryptWithKey('one', oldKey) }];
    const replaceIfUnchanged = jest.fn();
    const target: RotationTarget = {
      name: 'test',
      fetchBatch: async (after, take) => rows.filter((r) => !after || r.id > after).slice(0, take),
      replaceIfUnchanged,
    };
    const report = await rotateTarget(target, oldKey, newKey, { apply: false });
    expect(report.rotated).toBe(1);
    expect(replaceIfUnchanged).not.toHaveBeenCalled();
  });

  it('stops when a target repeats a page', async () => {
    const fetchBatch = jest.fn().mockResolvedValue([{ id: 'row-1', value: 'bad' }]);
    const target: RotationTarget = {
      name: 'stuck',
      fetchBatch,
      replaceIfUnchanged: jest.fn(),
    };
    await expect(rotateTarget(target, oldKey, newKey, { apply: false }))
      .rejects.toThrow('did not advance its pagination cursor');
    expect(fetchBatch).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe batch sizes', async () => {
    const fetchBatch = jest.fn();
    const target: RotationTarget = {
      name: 'test',
      fetchBatch,
      replaceIfUnchanged: jest.fn(),
    };
    await expect(rotateTarget(target, oldKey, newKey, { apply: false, batchSize: 0 }))
      .rejects.toThrow('batchSize must be an integer');
    expect(fetchBatch).not.toHaveBeenCalled();
  });
});

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export function parseKey(hex: string | undefined, name: string): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} must be exactly 64 hex characters (32 bytes).`);
  }
  return Buffer.from(hex, 'hex');
}

export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptWithKey(payload: string, key: Buffer): string {
  const [ivHex, tagHex, ciphertextHex] = payload.split(':');
  if (!ivHex || !tagHex || ciphertextHex === undefined) {
    throw new Error('Malformed encrypted payload.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

export type RotateOutcome =
  | { status: 'rotated'; value: string }
  | { status: 'already-rotated' }
  | { status: 'failed'; reason: string };

export function rotateCiphertext(payload: string, oldKey: Buffer, newKey: Buffer): RotateOutcome {
  let plaintext: string;
  try {
    plaintext = decryptWithKey(payload, oldKey);
  } catch {
    try {
      decryptWithKey(payload, newKey);
      return { status: 'already-rotated' };
    } catch {
      return { status: 'failed', reason: 'cannot be decrypted with the old OR the new key' };
    }
  }
  const value = encryptWithKey(plaintext, newKey);
  if (decryptWithKey(value, newKey) !== plaintext) {
    return { status: 'failed', reason: 're-encryption did not round-trip' };
  }
  return { status: 'rotated', value };
}

export interface RotationTarget {
  name: string;
  fetchBatch(afterId: string | null, take: number): Promise<Array<{ id: string; value: string }>>;
  replaceIfUnchanged(id: string, oldValue: string, newValue: string): Promise<boolean>;
}

export interface TargetReport {
  name: string;
  scanned: number;
  rotated: number;
  alreadyRotated: number;
  failed: string[];
  conflicts: string[];
}

export async function rotateTarget(
  target: RotationTarget,
  oldKey: Buffer,
  newKey: Buffer,
  options: { apply: boolean; batchSize?: number },
): Promise<TargetReport> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error('batchSize must be an integer between 1 and 5000.');
  }
  const report: TargetReport = {
    name: target.name, scanned: 0, rotated: 0, alreadyRotated: 0, failed: [], conflicts: [],
  };
  let cursor: string | null = null;
  for (;;) {
    const batch = await target.fetchBatch(cursor, batchSize);
    if (!Array.isArray(batch) || batch.length > batchSize) {
      throw new Error(`Rotation target ${target.name} returned an invalid batch.`);
    }
    if (batch.length === 0) break;
    for (const row of batch) {
      if (!row || typeof row.id !== 'string' || !row.id || typeof row.value !== 'string') {
        throw new Error(`Rotation target ${target.name} returned an invalid row.`);
      }
      report.scanned++;
      const outcome = rotateCiphertext(row.value, oldKey, newKey);
      if (outcome.status === 'failed') report.failed.push(row.id);
      else if (outcome.status === 'already-rotated') report.alreadyRotated++;
      else if (!options.apply) report.rotated++;
      else if (await target.replaceIfUnchanged(row.id, row.value, outcome.value)) report.rotated++;
      else report.conflicts.push(row.id);
    }
    const nextCursor = batch[batch.length - 1].id;
    if (nextCursor <= (cursor ?? '')) {
      throw new Error(`Rotation target ${target.name} did not advance its pagination cursor.`);
    }
    cursor = nextCursor;
  }
  return report;
}

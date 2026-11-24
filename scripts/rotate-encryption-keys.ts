import { PrismaClient } from '@prisma/client';
import { RotationTarget, TargetReport, parseKey, rotateTarget } from '../src/common/key-rotation';

const prisma = new PrismaClient();

function keysFor(domain: 'CUSTOMER_PII' | 'ADMIN_2FA') {
  return {
    oldKey: parseKey(process.env[`OLD_${domain}_ENCRYPTION_KEY`], `OLD_${domain}_ENCRYPTION_KEY`),
    newKey: parseKey(process.env[`NEW_${domain}_ENCRYPTION_KEY`], `NEW_${domain}_ENCRYPTION_KEY`),
  };
}

const userColumn = (column: 'bvnEncrypted' | 'ninEncrypted'): RotationTarget => ({
  name: `User.${column}`,
  async fetchBatch(afterId, take) {
    const rows = await prisma.user.findMany({
      where: { [column]: { not: null }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' }, take, select: { id: true, [column]: true },
    });
    return rows.map((row: any) => ({ id: row.id, value: row[column] as string }));
  },
  async replaceIfUnchanged(id, oldValue, newValue) {
    const result = await prisma.user.updateMany({
      where: { id, [column]: oldValue }, data: { [column]: newValue },
    });
    return result.count === 1;
  },
});

const adminTwoFactor: RotationTarget = {
  name: 'AdminUser.twoFactorSecret',
  async fetchBatch(afterId, take) {
    const rows = await prisma.adminUser.findMany({
      where: { twoFactorSecret: { not: null }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' }, take, select: { id: true, twoFactorSecret: true },
    });
    return rows.map((row) => ({ id: row.id, value: row.twoFactorSecret as string }));
  },
  async replaceIfUnchanged(id, oldValue, newValue) {
    const result = await prisma.adminUser.updateMany({
      where: { id, twoFactorSecret: oldValue }, data: { twoFactorSecret: newValue },
    });
    return result.count === 1;
  },
};

function printReport(report: TargetReport, apply: boolean) {
  console.log(`  ${report.name}: scanned ${report.scanned}, ${apply ? 'rotated' : 'would rotate'} ${report.rotated}, already rotated ${report.alreadyRotated}, failed ${report.failed.length}, conflicts ${report.conflicts.length}`);
  if (report.failed.length) console.log(`    failed row ids: ${report.failed.join(', ')}`);
  if (report.conflicts.length) console.log(`    conflict row ids: ${report.conflicts.join(', ')}`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const allowFailures = process.argv.includes('--allow-failures');
  const pii = keysFor('CUSTOMER_PII');
  const admin = keysFor('ADMIN_2FA');
  const plan: Array<[RotationTarget, Buffer, Buffer]> = [
    [userColumn('bvnEncrypted'), pii.oldKey, pii.newKey],
    [userColumn('ninEncrypted'), pii.oldKey, pii.newKey],
    [adminTwoFactor, admin.oldKey, admin.newKey],
  ];

  console.log('Running read-only preflight…');
  const preflight: TargetReport[] = [];
  for (const [target, oldKey, newKey] of plan) {
    const report = await rotateTarget(target, oldKey, newKey, { apply: false });
    preflight.push(report);
    printReport(report, false);
  }
  const failures = preflight.reduce((total, report) => total + report.failed.length, 0);
  if (!apply) {
    if (failures) process.exitCode = 1;
    console.log(failures ? 'Preflight found undecryptable values; investigate before applying.' : 'Preflight clean. Re-run with --apply to write.');
    return;
  }
  if (failures && !allowFailures) {
    process.exitCode = 1;
    throw new Error(`Aborting before writes: ${failures} undecryptable values. Use --allow-failures only after review.`);
  }

  console.log('Applying rotation…');
  for (const [target, oldKey, newKey] of plan) {
    printReport(await rotateTarget(target, oldKey, newKey, { apply: true }), true);
  }
  console.log('Rotation pass complete. Switch application secrets only after reviewing all counts and conflicts.');
}

main()
  .catch((error) => {
    console.error('Key rotation failed:', error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

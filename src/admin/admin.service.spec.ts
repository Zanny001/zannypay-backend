import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService external bank payout reversal safety', () => {
  it.each(['pending', 'completed'])(
    'blocks generic admin reversal when provider payout is %s',
    async (status) => {
      const wallet = { findUnique: jest.fn() };
      const prisma = {
        $transaction: jest.fn(async (callback) =>
          callback({
            transaction: {
              findUnique: jest.fn().mockResolvedValue({
                id: 'external-payout-1',
                userId: 'customer-1',
                category: 'external_bank_transfer',
                type: 'debit',
                amount: 500,
                status,
              }),
            },
            wallet,
          }),
        ),
      };
      const service = Object.create(AdminService.prototype) as AdminService;
      Object.assign(service, { prisma });

      await expect(
        service.reverseTransaction(
          'admin-1',
          'external-payout-1',
          'Manual refund request',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(wallet.findUnique).not.toHaveBeenCalled();
    },
  );
});

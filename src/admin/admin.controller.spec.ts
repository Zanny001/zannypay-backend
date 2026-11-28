import { AdminController } from './admin.controller';

describe('AdminController Paystack business OTP audit', () => {
  const makeController = (finalizeBusinessOtp: jest.Mock) => {
    const controller = Object.create(AdminController.prototype) as AdminController;
    const auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    Object.assign(controller, {
      auditLogService,
      paystackTransfers: { finalizeBusinessOtp },
    });
    return { controller, auditLogService };
  };

  it('records the attempt and a non-confirmed outcome without storing the OTP', async () => {
    const finalizeBusinessOtp = jest
      .fn()
      .mockResolvedValue({ success: false, status: 'pending' });
    const { controller, auditLogService } = makeController(finalizeBusinessOtp);

    const result = await controller.finalizePaystackTransfer(
      { user: { adminId: 'admin-1' }, ip: '127.0.0.1' },
      'zp-reference',
      { otp: '123456' },
    );

    expect(result).toEqual({ success: false, status: 'pending' });
    expect(auditLogService.record).toHaveBeenCalledTimes(2);
    expect(auditLogService.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: 'PAYSTACK_TRANSFER_BUSINESS_OTP_ATTEMPTED',
        targetId: 'zp-reference',
        metadata: { outcome: 'submitted' },
      }),
    );
    expect(auditLogService.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'PAYSTACK_TRANSFER_BUSINESS_OTP_NOT_CONFIRMED',
        metadata: {
          status: 'pending',
          success: false,
          outcome: 'pending_or_unconfirmed',
        },
      }),
    );
    expect(JSON.stringify(auditLogService.record.mock.calls)).not.toContain(
      '123456',
    );
  });

  it('audits provider errors without recording the OTP and rethrows the error', async () => {
    const providerError = new Error('Paystack approval was not confirmed');
    const finalizeBusinessOtp = jest.fn().mockRejectedValue(providerError);
    const { controller, auditLogService } = makeController(finalizeBusinessOtp);

    await expect(
      controller.finalizePaystackTransfer(
        { user: { adminId: 'admin-1' }, ip: '127.0.0.1' },
        'zp-reference',
        { otp: '654321' },
      ),
    ).rejects.toBe(providerError);

    expect(auditLogService.record).toHaveBeenCalledTimes(2);
    expect(auditLogService.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'PAYSTACK_TRANSFER_BUSINESS_OTP_NOT_CONFIRMED',
        metadata: { outcome: 'rejected_or_uncertain' },
      }),
    );
    expect(JSON.stringify(auditLogService.record.mock.calls)).not.toContain(
      '654321',
    );
  });
});

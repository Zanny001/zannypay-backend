import { Global, Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { ReconciliationService } from './reconciliation.service';
import { AdminSecurityModule } from '../admin-security/admin-security.module';

// @Global — TransactionsService, AdminService, SavingsService,
// LoansService, and RecurringTransfersService all need LedgerService;
// importing it once here avoids repeating that import five times.
@Global()
@Module({
  imports: [AdminSecurityModule], // for AdminIpAllowlistGuard on LedgerController
  controllers: [LedgerController],
  providers: [LedgerService, ReconciliationService],
  exports: [LedgerService, ReconciliationService],
})
export class LedgerModule {}

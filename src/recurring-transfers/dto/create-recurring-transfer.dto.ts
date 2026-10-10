import {
  IsString,
  IsNumber,
  Min,
  IsIn,
  IsOptional,
  MaxLength,
} from 'class-validator';

export class CreateRecurringTransferDto {
  @IsString()
  recipientAccount: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsIn(['daily', 'weekly', 'monthly'])
  frequency: 'daily' | 'weekly' | 'monthly';

  // Verified once, here, to prove genuine consent — never stored. See the
  // schema comment on RecurringTransfer for the full authorization model.
  @IsString()
  pin: string;
}

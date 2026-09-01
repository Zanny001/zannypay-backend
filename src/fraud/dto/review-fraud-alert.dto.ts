import { IsIn, IsOptional, IsString, IsBoolean } from 'class-validator';

export class ReviewFraudAlertDto {
  @IsIn(['confirmed', 'dismissed'])
  decision: 'confirmed' | 'dismissed';

  @IsOptional()
  @IsString()
  note?: string;

  // If this alert had auto-frozen the account and the reviewer confirms it
  // was a false positive, this unfreezes the account as part of the same
  // action rather than requiring a second call to /admin/users/:id/freeze.
  @IsOptional()
  @IsBoolean()
  unfreezeIfDismissed?: boolean;
}

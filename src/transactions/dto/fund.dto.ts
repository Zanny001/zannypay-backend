import { IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

export class FundDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(100)
  @Max(10000000)
  amount: number;

  // Stable across retries of one funding intent. This prevents an uncertain
  // network response from creating a second Paystack checkout/deposit.
  @IsOptional()
  @IsString()
  @Length(12, 128)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey?: string;
}

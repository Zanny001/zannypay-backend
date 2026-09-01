import { IsString, IsNumber, Min, IsOptional } from 'class-validator';

export class AirtimeDto {
  @IsString()
  phone: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsString()
  provider: string;

  @IsString()
  pin: string;

  @IsOptional()
  @IsString()
  type?: string;
  // Client-generated (e.g. a UUID created once per attempt, before the
  // first network call). Reusing the same value on a retry — whether the
  // app's own offline-sync queue replaying it, or a plain network retry —
  // makes the retry a safe no-op instead of a second debit. Optional so
  // older/unpatched clients don't break, but every client should send one.
  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  // Reward points to redeem toward this purchase — 10 points = ₦1 (see
  // POINTS_PER_NAIRA in transactions.service.ts). Must be a multiple of 10;
  // the service validates it against both the user's real point balance
  // and the purchase amount.
  @IsOptional()
  @IsNumber()
  @Min(0)
  pointsToRedeem?: number;
}

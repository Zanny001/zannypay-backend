import { IsString, IsNumber, Min, IsOptional } from 'class-validator';

export class TransferDto {
  @IsOptional()
  @IsString()
  recipientName?: string;

  @IsString()
  recipientAccount: string;

  @IsOptional()
  @IsString()
  bank?: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsString()
  pin: string;
  // Client-generated (e.g. a UUID created once per attempt, before the
  // first network call). Reusing the same value on a retry — whether the
  // app's own offline-sync queue replaying it, or a plain network retry —
  // makes the retry a safe no-op instead of a second debit. Optional so
  // older/unpatched clients don't break, but every client should send one.
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

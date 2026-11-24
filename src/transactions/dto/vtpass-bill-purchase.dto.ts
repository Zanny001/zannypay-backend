import {
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class VtpassBillPurchaseDto {
  @IsString()
  @Matches(/^[a-z0-9-]{2,80}$/i)
  serviceID: string;

  @IsString()
  @Matches(/^[a-z0-9_-]{1,80}$/i)
  variation_code: string;

  @IsString()
  @MinLength(3)
  @MaxLength(64)
  billersCode: string;

  // Amount is accepted only when it exactly matches the provider catalogue
  // fixed price. Client-supplied pricing is never trusted.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/)
  phone?: string;

  // Used for providers whose merchant verification distinguishes
  // prepaid/postpaid accounts (for example electricity).
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerType?: string;

  @IsString()
  @Matches(/^[0-9]{4,6}$/)
  pin: string;

  @IsString()
  @MinLength(16)
  @MaxLength(80)
  idempotencyKey: string;
}

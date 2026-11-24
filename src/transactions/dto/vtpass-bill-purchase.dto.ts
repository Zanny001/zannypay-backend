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
  // Identifier is the VTpass catalogue category (for example electricity,
  // data or airtime); serviceID must be present in that category's catalogue.
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{1,30}$/i)
  identifier: string;

  @IsString()
  @Matches(/^[a-z0-9-]{2,80}$/i)
  serviceID: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_-]{1,80}$/i)
  variation_code?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(64)
  billersCode: string;

  // Required for flexible products; for fixed variations it must match the
  // provider catalogue price exactly.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/)
  phone?: string;

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

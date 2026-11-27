import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class VtpassCustomerVerifyDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{1,30}$/i)
  serviceID: string;

  @IsString()
  @MinLength(3)
  @MaxLength(64)
  billersCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;
}

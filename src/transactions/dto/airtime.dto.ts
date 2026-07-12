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
}

import { IsString, IsNumber, Min } from 'class-validator';

export class AirtimeDto {
  @IsString()
  phone: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsString()
  provider: string;
}

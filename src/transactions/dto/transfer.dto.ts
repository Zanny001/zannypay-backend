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
}

import { IsString, IsNumber, Min } from 'class-validator';

export class TransferDto {
  @IsString()
  recipientAccount: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsString()
  pin: string;
}

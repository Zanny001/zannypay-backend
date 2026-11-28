import { IsString, Matches } from 'class-validator';

export class FinalizePaystackTransferDto {
  @IsString()
  @Matches(/^\d{4,8}$/, {
    message: 'Paystack approval code must contain 4 to 8 digits.',
  })
  otp: string;
}

import { IsIn, IsString, Length } from 'class-validator';
import { OTP_PURPOSES } from '../../otp/otp.service';
import type { OtpPurpose } from '../../otp/otp.service';

export class RequestOtpDto {
  @IsString()
  target: string; // phone number the code is sent to

  @IsIn([OTP_PURPOSES.SIGNUP_VERIFICATION, OTP_PURPOSES.PIN_RESET])
  purpose: OtpPurpose;
}

export class VerifyOtpDto {
  @IsString()
  target: string;

  @IsIn([OTP_PURPOSES.SIGNUP_VERIFICATION, OTP_PURPOSES.PIN_RESET])
  purpose: OtpPurpose;

  @IsString()
  @Length(6, 6)
  code: string;
}

export class ResetPinDto {
  @IsString()
  phone: string;

  @IsString()
  @Length(6, 6)
  code: string; // the OTP that proved control of the phone

  @IsString()
  @Length(4, 4)
  newPin: string;
}

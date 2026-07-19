import { IsString, IsEmail, Length, IsOptional } from 'class-validator';

export class SignupDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string; // Removed @IsOptional() to align with DB schema

  @IsString()
  phone: string;

  @IsString()
  @Length(4, 4)
  pin: string;

  // The referral code of whoever invited this user, if any. Invalid/unknown
  // codes are silently ignored rather than blocking signup.
  @IsOptional()
  @IsString()
  referredByCode?: string;
}

import { IsString, IsEmail, Length } from 'class-validator';

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
}

import { IsString, IsOptional, IsEmail, Length } from 'class-validator';

export class SignupDto {
  @IsString()
  name: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  phone: string;

  @IsString()
  @Length(4, 4)
  pin: string;
}


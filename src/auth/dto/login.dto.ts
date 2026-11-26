import { IsString, Length } from 'class-validator';

export class LoginDto {
  @IsString()
  @Length(5, 32)
  phone: string;

  @IsString()
  @Length(4, 4)
  pin: string;
}

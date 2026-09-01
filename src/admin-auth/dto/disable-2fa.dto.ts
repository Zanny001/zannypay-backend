import { IsString, Length } from 'class-validator';

export class Disable2faDto {
  @IsString()
  password: string;

  @IsString()
  @Length(4, 20)
  code: string;
}

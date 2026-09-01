import { IsString, Length } from 'class-validator';

export class RegenerateRecoveryCodesDto {
  @IsString()
  @Length(6, 6)
  code: string;
}

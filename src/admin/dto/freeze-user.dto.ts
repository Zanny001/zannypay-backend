import { IsString, IsBoolean } from 'class-validator';

export class FreezeUserDto {
  @IsBoolean()
  isFrozen: boolean;

  @IsString()
  reason: string;
}

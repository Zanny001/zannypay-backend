import { IsString, MinLength } from 'class-validator';

export class ChangeAdminPasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(10) // deliberately stricter than a typical customer password minimum — this credential guards money-moving/compliance actions
  newPassword: string;
}

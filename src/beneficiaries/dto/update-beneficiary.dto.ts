import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBeneficiaryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  nickname?: string;

  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;
}

import { IsString, MinLength, MaxLength } from 'class-validator';

export class ActivateBusinessDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  businessName: string;
}

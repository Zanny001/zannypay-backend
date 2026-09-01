import { IsIn, IsString, Length } from 'class-validator';

export class RevealKycFieldDto {
  @IsIn(['bvn', 'nin'])
  field: 'bvn' | 'nin';

  @IsString()
  @Length(4, 4)
  pin: string;
}

import { IsString, Length } from 'class-validator';

export class Verify2faDto {
  @IsString()
  mfaToken: string;

  // 6-digit TOTP code, or a recovery code in "XXXX-XXXX-XXXX" form —
  // service-side logic tries TOTP first, then falls back to recovery codes,
  // so this field intentionally accepts either shape.
  @IsString()
  @Length(4, 20)
  code: string;
}

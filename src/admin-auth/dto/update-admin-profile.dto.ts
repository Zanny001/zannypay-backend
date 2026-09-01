import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAdminProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  bio?: string;

  // A base64 data URI from the image picker, OR a URL if the client used
  // the presigned-upload flow directly (see storage/storage.service.ts).
  @IsOptional()
  @IsString()
  photo?: string;
}

import { IsString, IsEmail, IsOptional, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  // Base64 data URI (e.g. "data:image/jpeg;base64,...") from the device's
  // image picker. Kept as a plain string column rather than wiring up
  // multipart upload + cloud storage, since no object-storage credentials
  // (S3/Cloudinary/etc.) are configured for this project.
  @IsOptional()
  @IsString()
  @MaxLength(6_000_000)
  profileImage?: string;
}

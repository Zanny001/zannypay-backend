import { IsString, IsEmail, IsOptional, MaxLength, IsDateString, IsIn } from 'class-validator';

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

  // Premium profile / KYC-lite fields
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsIn(['Male', 'Female', 'Prefer not to say'])
  gender?: string;

  @IsOptional()
  @IsString()
  occupation?: string;

  @IsOptional()
  @IsString()
  nationality?: string;

  @IsOptional()
  @IsIn(['Single', 'Married', 'Divorced', 'Widowed', 'Prefer not to say'])
  maritalStatus?: string;

  @IsOptional()
  @IsString()
  nextOfKinName?: string;

  @IsOptional()
  @IsString()
  nextOfKinPhone?: string;

  // Client sends only the last 4 digits — never the full BVN — since there's
  // no real BVN verification provider wired up here; this is a display-only,
  // self-reported field, not a verified identity credential.
  @IsOptional()
  @IsString()
  @MaxLength(4)
  bvn?: string;
}

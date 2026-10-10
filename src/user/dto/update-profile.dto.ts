import {
  IsString,
  IsEmail,
  IsOptional,
  MaxLength,
  IsDateString,
  IsIn,
  Matches,
} from 'class-validator';

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

  // Full 11-digit BVN — encrypted at rest before storage (see
  // common/crypto.util.ts + user.service.ts). Never returned to any
  // client in this raw form once stored; only POST /user/kyc/reveal
  // (which requires the user's transaction PIN) can retrieve it.
  @IsOptional()
  @IsString()
  @Matches(/^\d{11}$/, { message: 'bvn must be exactly 11 digits' })
  bvn?: string;

  // Full 11-digit NIN — same encryption/reveal treatment as bvn above.
  @IsOptional()
  @IsString()
  @Matches(/^\d{11}$/, { message: 'nin must be exactly 11 digits' })
  nin?: string;
}

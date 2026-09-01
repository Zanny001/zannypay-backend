import { IsIn, IsString } from 'class-validator';

export const KYC_DOCUMENT_TYPES = ['id_front', 'id_back', 'selfie', 'proof_of_address'] as const;

export class SubmitKycDocumentDto {
  @IsIn(KYC_DOCUMENT_TYPES)
  type: (typeof KYC_DOCUMENT_TYPES)[number];

  // A base64 data URI from the camera/image picker — see
  // storage/storage.service.ts, which converts this to a durable URL
  // before it's ever written to the database.
  @IsString()
  file: string;
}

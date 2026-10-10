import { IsString, IsOptional, MaxLength, Matches } from 'class-validator';

export class SendMessageDto {
  // Optional now — a message can be attachment-only (a photo with no
  // caption). At least one of body/attachmentData is required, enforced
  // in SupportService rather than here (class-validator doesn't have a
  // clean built-in "at least one of these fields" check).
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  // Same base64 data-URI pattern already used for User.profileImage — no
  // object storage is configured for this app yet, so this is the pragmatic
  // "works today, no new infra needed" choice. The size cap keeps a single
  // chat image from bloating the ChatMessage table — 2MB base64 is roughly
  // a 1.5MB image, generous for a chat attachment, not for a photo album.
  @IsOptional()
  @IsString()
  @MaxLength(2_800_000, {
    message: 'Attachment is too large — please choose a smaller image.',
  })
  @Matches(/^data:image\/(jpeg|jpg|png|webp);base64,/, {
    message: 'attachmentData must be a base64 image data URI.',
  })
  attachmentData?: string;

  @IsOptional()
  @IsString()
  attachmentMimeType?: string;
}

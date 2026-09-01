import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export const INTERNAL_NOTE_TARGET_TYPES = ['User', 'Dispute', 'Transaction', 'FraudAlert'] as const;

export class CreateInternalNoteDto {
  @IsIn(INTERNAL_NOTE_TARGET_TYPES)
  targetType: (typeof INTERNAL_NOTE_TARGET_TYPES)[number];

  @IsString()
  targetId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body: string;
}

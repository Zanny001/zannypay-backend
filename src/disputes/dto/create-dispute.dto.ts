import { IsString, IsOptional } from 'class-validator';

export class CreateDisputeDto {
  @IsString()
  transactionId: string;

  @IsString()
  reason: string;

  @IsOptional()
  @IsString()
  details?: string;
}

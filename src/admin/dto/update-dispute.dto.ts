import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateDisputeDto {
  @IsIn(['open', 'under_review', 'resolved', 'rejected'])
  status: string;

  @IsOptional()
  @IsString()
  resolutionNote?: string;
}

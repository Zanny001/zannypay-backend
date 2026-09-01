import { IsIn, IsOptional, IsString } from 'class-validator';

export class KycDecisionDto {
  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  reason?: string; // required in practice for a rejection, enforced in the service
}

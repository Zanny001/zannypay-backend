import { IsOptional, IsBoolean, IsIn, IsObject } from 'class-validator';

export class UpdateFraudRuleDto {
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  severity?: string;

  // Rule-specific thresholds — shape depends on the rule (e.g.
  // { windowMinutes, maxDebitCount } for VELOCITY_COUNT). Validated loosely
  // here; the engine reads whichever keys it expects and falls back to its
  // own defaults for anything missing, so a partial update never crashes it.
  @IsOptional()
  @IsObject()
  config?: Record<string, any>;

  @IsOptional()
  @IsBoolean()
  autoFreeze?: boolean;
}

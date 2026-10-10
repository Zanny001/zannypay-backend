import { IsString, IsOptional, Matches } from 'class-validator';

export class CreateIpAllowlistEntryDto {
  // Accepts a bare IPv4/IPv6 address or a CIDR range (e.g. "203.0.113.10",
  // "203.0.113.0/24", "2001:db8::1"). Validated loosely here — the guard's
  // matcher is the real gatekeeper — this just blocks obviously garbage
  // input (empty strings, whitespace, script tags, etc.) at the door.
  @IsString()
  @Matches(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, {
    message:
      'cidr must look like an IPv4/IPv6 address or CIDR range, e.g. 203.0.113.10/32',
  })
  cidr: string;

  @IsOptional()
  @IsString()
  label?: string;
}

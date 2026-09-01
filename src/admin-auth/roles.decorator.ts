import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

// Usage: @Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER')
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

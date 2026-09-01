import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminAuthService } from './admin-auth.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminJwtStrategy } from './admin-jwt.strategy';
import { Require2faGuard } from './require-2fa.guard';
import { StepUpGuard } from './step-up.guard';
import { AdminSecurityModule } from '../admin-security/admin-security.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.ADMIN_JWT_SECRET,
      signOptions: { expiresIn: '8h' },
    }),
    AdminSecurityModule, // for AdminIpAllowlistGuard, used on this module's own controller
  ],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminJwtStrategy, Require2faGuard, StepUpGuard],
  exports: [AdminAuthService, Require2faGuard, StepUpGuard],
})
export class AdminAuthModule {}

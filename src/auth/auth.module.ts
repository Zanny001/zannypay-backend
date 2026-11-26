import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { WebAuthController } from './web-auth.controller';
import { WebSessionService } from './web-session.service';
import { WebSessionGuard } from './web-session.guard';
import { JwtStrategy } from './jwt.strategy';
import { OtpModule } from '../otp/otp.module';

@Module({
  imports: [
    PassportModule,
    OtpModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController, WebAuthController],
  providers: [
    AuthService,
    JwtStrategy,
    WebSessionService,
    { provide: APP_GUARD, useClass: WebSessionGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}

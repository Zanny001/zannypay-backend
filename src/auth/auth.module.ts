import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { WebAuthController } from './web-auth.controller';
import { WebSessionService } from './web-session.service';
import { WebSessionMiddleware } from './web-session.middleware';
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
  providers: [AuthService, JwtStrategy, WebSessionService, WebSessionMiddleware],
  exports: [AuthService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(WebSessionMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}

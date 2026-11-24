import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OtpService } from './otp.service';
import {
  ConfiguredOtpDeliveryProvider,
  MockOtpDeliveryProvider,
} from './otp-delivery.provider';
import { OTP_DELIVERY_PROVIDER } from './otp.tokens';

@Module({
  imports: [PrismaModule],
  providers: [
    OtpService,
    ConfiguredOtpDeliveryProvider,
    MockOtpDeliveryProvider,
    {
      provide: OTP_DELIVERY_PROVIDER,
      useFactory: (
        configured: ConfiguredOtpDeliveryProvider,
        mock: MockOtpDeliveryProvider,
      ) => {
        // Never allow a production deployment to silently log OTPs instead
        // of delivering them. Missing credentials now produce a safe 503.
        if (process.env.NODE_ENV === 'production') return configured;
        return process.env.OTP_DELIVERY_PROVIDER === 'termii'
          ? configured
          : mock;
      },
      inject: [ConfiguredOtpDeliveryProvider, MockOtpDeliveryProvider],
    },
  ],
  exports: [OtpService],
})
export class OtpModule {}

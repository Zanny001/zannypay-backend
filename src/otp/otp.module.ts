import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OtpService } from './otp.service';
import { MockOtpDeliveryProvider } from './otp-delivery.provider';
import { OTP_DELIVERY_PROVIDER } from './otp.tokens';

// Wires the delivery provider behind the OTP_DELIVERY_PROVIDER token.
// Only the mock exists today — there is no real SMS/email vendor
// credential configured — and the mock logs the code server-side instead
// of delivering it. That is a reasonable, honest stand-in for local
// development and CI, NOT something that should ship to production with
// real users' phones on the other end: set OTP_DELIVERY_PROVIDER and
// register a real vendor implementation (Termii, Africa's Talking, or
// Twilio are the common Nigerian-market choices) before that.
@Module({
  imports: [PrismaModule],
  providers: [
    OtpService,
    {
      provide: OTP_DELIVERY_PROVIDER,
      useClass: MockOtpDeliveryProvider,
    },
  ],
  exports: [OtpService],
})
export class OtpModule {}

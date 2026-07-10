import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { MailerModule } from '@nestjs-modules/mailer';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { TransactionsModule } from './transactions/transactions.module';
import { UserModule } from './user/user.module';
import { SavingsModule } from './savings/savings.module';
import { LoansModule } from './loans/loans.module';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    TransactionsModule,
    UserModule,
    // Enterprise Rate Limiting: Max 20 requests per 60 seconds per IP
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 20,
    }]),
    // Global Email Engine
    MailerModule.forRoot({
      transport: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com', // Replace with SendGrid/Mailgun if needed
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      },
      defaults: {
        from: '"ZannyPay Alerts" <noreply@zannypay.com>',
      },
    }),
    SavingsModule,
    LoansModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD, // Applies rate limiting to all endpoints automatically
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

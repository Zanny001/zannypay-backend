import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { RequestOtpDto, ResetPinDto, VerifyOtpDto } from './dto/otp.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Master audit, High-priority #4 — signup/login are exactly what a
  // credential-stuffing or account-enumeration script targets first;
  // 5/60s (vs. the API-wide default of 20/60s) is enough headroom for a
  // real user who mistypes a PIN twice without being useful to an attacker.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('signup')
  async signup(@Body() signupDto: SignupDto) {
    return this.authService.signup(signupDto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() body: { phone: string; pin: string }) {
    return this.authService.login(body.phone, body.pin);
  }

  // OTP endpoints — same 5/60s ceiling as login/signup, plus the
  // service-level 60s resend cooldown, so a script can neither
  // SMS-bomb a victim's phone nor brute-force a 6-digit code
  // (5 attempts per code, 5 requests/minute per IP).
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('otp/request')
  async requestOtp(@Body() dto: RequestOtpDto) {
    return this.authService.requestOtp(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('otp/verify')
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  // Forgot PIN: resetting the PIN on an account holding real money
  // requires proving control of the phone number on the account via a
  // verified PIN_RESET OTP — knowing the phone number alone is not enough.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('pin/reset')
  async resetPin(@Body() dto: ResetPinDto) {
    return this.authService.resetPin(dto);
  }
}

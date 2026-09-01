import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';

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
}

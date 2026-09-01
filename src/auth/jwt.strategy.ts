import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET, // Reads the secret from your .env
    });
  }

  // This automatically attaches { userId, phone } to `req.user` in your controllers
  async validate(payload: any) {
    return { userId: payload.sub, phone: payload.phone };
  }
}

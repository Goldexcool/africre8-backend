import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuthService } from './auth.service.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['BRAND', 'CREATOR']),
  phone: z.string().min(7).optional(),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(20) });

const strip = <T extends { refreshTokenId: string }>(t: T) => ({ ...t, refreshTokenId: undefined });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>) {
    return strip(await this.auth.register(body));
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    return strip(await this.auth.login(body.email, body.password));
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    return strip(await this.auth.refresh(body.refreshToken));
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    await this.auth.logout(body.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}

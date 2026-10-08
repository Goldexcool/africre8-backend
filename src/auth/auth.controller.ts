import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
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

const codeSchema = z.object({ code: z.string().regex(/^\d{4}$/) });
const forgotSchema = z.object({ email: z.string().email() });
const checkSchema = forgotSchema.extend({ code: z.string().regex(/^\d{4}$/) });
const resetSchema = checkSchema.extend({ password: z.string().min(8) });

const strip = <T extends { refreshTokenId: string }>(t: T) => ({ ...t, refreshTokenId: undefined });

@Controller('auth')
@UseGuards(ThrottlerGuard)
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

  @HttpCode(204)
  @Post('send-verification')
  async sendVerification(@CurrentUser() user: AuthUser) {
    await this.auth.sendVerification(user.id);
  }

  @HttpCode(204)
  @Post('verify-email')
  async verifyEmail(@CurrentUser() user: AuthUser, @Body(new ZodPipe(codeSchema)) b: z.infer<typeof codeSchema>) {
    await this.auth.verifyEmail(user.id, b.code);
  }

  @Public()
  @HttpCode(204)
  @Post('forgot-password')
  async forgot(@Body(new ZodPipe(forgotSchema)) b: z.infer<typeof forgotSchema>) {
    await this.auth.forgotPassword(b.email);
  }

  @Public()
  @HttpCode(204)
  @Post('verify-reset-code')
  async checkCode(@Body(new ZodPipe(checkSchema)) b: z.infer<typeof checkSchema>) {
    await this.auth.checkResetCode(b.email, b.code);
  }

  @Public()
  @HttpCode(204)
  @Post('reset-password')
  async reset(@Body(new ZodPipe(resetSchema)) b: z.infer<typeof resetSchema>) {
    await this.auth.resetPassword(b.email, b.code, b.password);
  }

  @SkipThrottle()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}

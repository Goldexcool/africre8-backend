import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, Public, Roles, type AuthUser } from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { NG_BANKS } from './banks.js';
import { checkoutPage } from './checkout-page.js';
import { PaymentsService } from './payments.service.js';

const fundSchema = z.object({ method: z.enum(['bank_transfer', 'card']).default('bank_transfer') });
const resolveSchema = z.object({ bankCode: z.string().min(3), accountNumber: z.string().regex(/^\d{10}$/) });

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Roles('BRAND')
  @UseGuards(OnboardedGuard)
  @Post('campaigns/:id/fund')
  fund(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(fundSchema)) b: z.infer<typeof fundSchema>) {
    return this.payments.fund(u.id, id, b.method);
  }

  @Roles('BRAND')
  @Post('campaigns/:id/fund/simulate')
  simulate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.simulateTransfer(u.id, id);
  }

  /** "I've paid" button: re-query Payaza now instead of waiting for the webhook. */
  @Post('transactions/:id/check')
  async check(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.payments.one(u.id, u.role, id);
    await this.payments.reconcile(id);
    return this.payments.one(u.id, u.role, id);
  }

  @Get('transactions')
  list(@CurrentUser() u: AuthUser) {
    return this.payments.forUser(u.id, u.role);
  }

  @Get('transactions/:id')
  one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.one(u.id, u.role, id);
  }

  @Get('payments/banks')
  banks() {
    return NG_BANKS;
  }

  @Roles('CREATOR')
  @Post('payments/resolve-account')
  resolve(@Body(new ZodPipe(resolveSchema)) b: z.infer<typeof resolveSchema>) {
    return this.payments.provider.resolveAccount(b.bankCode, b.accountNumber);
  }

  @Public()
  @HttpCode(200)
  @Post('webhooks/payaza')
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-payaza-signature') signature: string | undefined, @Body() body: unknown) {
    return this.payments.handleWebhook(req.rawBody ?? Buffer.from(JSON.stringify(body)), signature, body);
  }

  @Public()
  @Get('pay/:reference')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page(@Param('reference') reference: string) {
    const { t, brand } = await this.payments.checkoutData(reference);
    const [firstName, ...rest] = (brand.brandProfile?.contactName ?? 'AfiCre8 Brand').split(' ');
    return checkoutPage({
      publicKey: process.env.PAYAZA_PUBLIC_KEY ?? '',
      mode: process.env.PAYAZA_ENV === 'live' ? 'Live' : 'Test',
      reference,
      amountNgn: (t.amountKobo + t.feeKobo) / 100,
      title: t.campaign.title,
      email: brand.email,
      firstName,
      lastName: rest.join(' ') || 'Brand',
      returnUrl: `${process.env.APP_SCHEME ?? 'africre8'}://campaigns/${t.campaignId}`,
    });
  }

  @Public()
  @HttpCode(200)
  @Post('pay/:reference/check')
  async pageCheck(@Param('reference') reference: string) {
    const t = await this.payments.reconcileByReference(reference);
    return { status: t?.status ?? 'unknown' };
  }
}

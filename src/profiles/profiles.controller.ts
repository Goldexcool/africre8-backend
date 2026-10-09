import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { PaymentsService } from '../payments/payments.service.js';
import { ReviewService } from '../review/review.module.js';
import { ProfilesService } from './profiles.service.js';
import {
  brandSchema,
  creatorSchema,
  payoutSchema,
  type BrandInput,
  type CreatorInput,
  type PayoutInput,
} from './profiles.schemas.js';

@Controller()
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly payments: PaymentsService,
    private readonly review: ReviewService,
  ) {}

  @Roles('CREATOR')
  @Put('profiles/creator')
  creator(@CurrentUser() u: AuthUser, @Body(new ZodPipe(creatorSchema)) body: CreatorInput) {
    return this.profiles.upsertCreator(u.id, body);
  }

  @Roles('BRAND')
  @Put('profiles/brand')
  brand(@CurrentUser() u: AuthUser, @Body(new ZodPipe(brandSchema)) body: BrandInput) {
    return this.profiles.upsertBrand(u.id, body);
  }

  @Roles('CREATOR')
  @Put('profiles/payout-destination')
  async payout(@CurrentUser() u: AuthUser, @Body(new ZodPipe(payoutSchema)) body: PayoutInput) {
    const { accountName } = await this.payments.provider.resolveAccount(body.bankCode, body.accountNumber);
    const dest = await this.profiles.setPayoutDestination(u.id, { ...body, accountName });
    // Approved campaigns waiting on bank details get paid now.
    const waiting = await this.payments.approvedAwaitingPayout(u.id);
    for (const id of waiting) await this.review.releaseIfPossible(id, u.id);
    return dest;
  }

  /** Where a brand's money goes back to if a funded campaign is cancelled or lost in a dispute. */
  @Roles('BRAND')
  @Put('profiles/refund-account')
  async refundAccount(@CurrentUser() u: AuthUser, @Body(new ZodPipe(payoutSchema)) body: PayoutInput) {
    const { accountName } = await this.payments.provider.resolveAccount(body.bankCode, body.accountNumber);
    const dest = await this.profiles.setPayoutDestination(u.id, { ...body, accountName });
    for (const id of await this.payments.refundsOwed(u.id)) await this.payments.refund(id, u.id, 'Refund account saved').catch(() => undefined);
    return dest;
  }

  @Get('creators/:id')
  creatorById(@Param('id', ParseUUIDPipe) id: string) {
    return this.profiles.creatorCard(id);
  }

  @Get('brands/:id')
  brandById(@Param('id', ParseUUIDPipe) id: string) {
    return this.profiles.brand(id);
  }
}

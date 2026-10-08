import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
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
  constructor(private readonly profiles: ProfilesService) {}

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
  payout(@CurrentUser() u: AuthUser, @Body(new ZodPipe(payoutSchema)) body: PayoutInput) {
    return this.profiles.setPayoutDestination(u.id, body);
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

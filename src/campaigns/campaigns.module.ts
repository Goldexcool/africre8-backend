import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { CampaignStatus } from '../generated/prisma/client.js';
import { acceptSchema, createSchema, termsSchema, type CreateInput, type TermsInput } from './campaigns.schemas.js';
import { CampaignsService } from './campaigns.service.js';
import { CampaignStateMachine } from './state-machine.js';

@Controller('campaigns')
@UseGuards(OnboardedGuard)
class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Roles('BRAND')
  @Post()
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(createSchema)) b: CreateInput) {
    return this.campaigns.create(u.id, b);
  }

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('status') status?: CampaignStatus) {
    return this.campaigns.list(u, status);
  }

  @Get(':id')
  detail(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.detail(u, id);
  }

  @Roles('BRAND', 'CREATOR')
  @Put(':id/terms')
  edit(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(termsSchema)) b: TermsInput) {
    return this.campaigns.editTerms(u, id, b);
  }

  @Roles('BRAND', 'CREATOR')
  @Post(':id/accept')
  accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(acceptSchema)) b: z.infer<typeof acceptSchema>) {
    return this.campaigns.accept(u, id, b.termsVersion);
  }

  @Roles('CREATOR')
  @Post(':id/start')
  start(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.start(u, id);
  }
}

@Module({
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignStateMachine],
  exports: [CampaignsService, CampaignStateMachine],
})
export class CampaignsModule {}

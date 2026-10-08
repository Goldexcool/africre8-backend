import { Body, Controller, Module, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { VerificationService } from './verification.service.js';

const submitSchema = z.object({
  requirementId: z.string().uuid(),
  contentUrl: z.string().url().refine((u) => u.startsWith('https://'), 'Use an https link'),
  notes: z.string().max(2000).optional(),
  evidenceUrls: z.array(z.string().url()).max(10).optional(),
});

@Controller('campaigns/:id')
@UseGuards(OnboardedGuard)
class SubmissionsController {
  constructor(
    private readonly verification: VerificationService,
    private readonly campaigns: CampaignsService,
  ) {}

  @Roles('CREATOR')
  @Post('submissions')
  async submit(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(submitSchema)) b: z.infer<typeof submitSchema>) {
    await this.verification.submit(u.id, id, b);
    return this.campaigns.detail(u, id);
  }

  @Roles('BRAND', 'ADMIN')
  @Post('submissions/:submissionId/reverify')
  async reverify(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) sid: string) {
    await this.campaigns.owned(u, id);
    return this.verification.reverify(id, sid);
  }
}

@Module({
  imports: [CampaignsModule],
  controllers: [SubmissionsController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}

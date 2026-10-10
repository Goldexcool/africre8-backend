import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MlService } from './ml.service.js';
import {
  recommendationInputSchema,
  type RecommendationInput,
} from './ml.schemas.js';

@Controller()
@UseGuards(OnboardedGuard)
export class MlController {
  constructor(private readonly ml: MlService) {}

  @Roles('BRAND')
  @Post('opportunities/:id/recommendations')
  recommendations(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(recommendationInputSchema)) input: RecommendationInput,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.ml.recommend(user.id, id, input, requestId || randomUUID());
  }

  @Get('creators/:id/credibility')
  credibility(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.ml.credibility(user, id, requestId || randomUUID());
  }
}

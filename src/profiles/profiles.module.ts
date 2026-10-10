import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { MlModule } from '../ml/ml.module.js';
import { ReviewModule } from '../review/review.module.js';
import { ProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';

@Module({ imports: [PaymentsModule, ReviewModule, MlModule], controllers: [ProfilesController], providers: [ProfilesService], exports: [ProfilesService] })
export class ProfilesModule {}

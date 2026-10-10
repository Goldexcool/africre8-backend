import { Module } from '@nestjs/common';
import { MlClient } from './ml.client.js';
import { MlController } from './ml.controller.js';
import { MlService } from './ml.service.js';

@Module({ controllers: [MlController], providers: [MlClient, MlService] })
export class MlModule {}

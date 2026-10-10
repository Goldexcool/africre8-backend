import { Module } from '@nestjs/common';
import { MlClient } from './ml.client.js';
import { MlController } from './ml.controller.js';
import { MlService } from './ml.service.js';
import { MlSyncService } from './ml-sync.service.js';

@Module({ controllers: [MlController], providers: [MlClient, MlService, MlSyncService], exports: [MlSyncService, MlService] })
export class MlModule {}

import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { redisSocketEmitter } from './realtime/redis-emitter.js';

const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
// Worker has no sockets of its own; push events through Redis to the API instances.
app.get(NotificationsService).setEmitter(redisSocketEmitter());
Logger.log('Worker started', 'Worker');

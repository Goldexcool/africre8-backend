import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
Logger.log('Worker started', 'Worker');

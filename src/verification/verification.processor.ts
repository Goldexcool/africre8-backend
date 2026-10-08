import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUES } from '../queue/queue.module.js';
import { VerificationService } from './verification.service.js';

@Processor(QUEUES.verification, { concurrency: 2 })
export class VerificationProcessor extends WorkerHost {
  constructor(private readonly verification: VerificationService) {
    super();
  }

  process(job: Job<{ submissionId: string }>) {
    return this.verification.verify(job.data.submissionId);
  }
}

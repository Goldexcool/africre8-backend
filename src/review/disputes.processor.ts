import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../queue/queue.module.js';
import { ReviewService } from './review.module.js';

/** Worker-only: flags disputes nobody answered within 72 hours, and makes sure a split dispute's brand refund exists. */
@Processor(QUEUES.disputes)
export class DisputesProcessor extends WorkerHost implements OnModuleInit {
  private readonly log = new Logger(DisputesProcessor.name);

  constructor(
    private readonly review: ReviewService,
    @InjectQueue(QUEUES.disputes) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    await this.queue.upsertJobScheduler('disputes-tick', { every: 600_000 }, { name: 'disputes-tick' });
  }

  async process(job: Job) {
    if (job.name !== 'disputes-tick') return;
    const flagged = await this.review.flagOverdueDisputes();
    const refunds = await this.review.ensureSplitRefunds();
    if (flagged || refunds) this.log.log(`Flagged ${flagged} overdue dispute(s), created ${refunds} missing split refund(s)`);
    return { flagged, refunds };
  }
}

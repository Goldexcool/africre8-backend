import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../queue/queue.module.js';
import { PaymentsService } from './payments.service.js';

/** Worker-only: re-queries Payaza for anything still pending (so a missed webhook never strands money), refunds overdue work and retries refused payouts. */
@Processor(QUEUES.payments)
export class PaymentsProcessor extends WorkerHost implements OnModuleInit {
  private readonly log = new Logger(PaymentsProcessor.name);

  constructor(
    private readonly payments: PaymentsService,
    @InjectQueue(QUEUES.payments) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    await this.queue.upsertJobScheduler('reconcile', { every: 60_000 }, { name: 'reconcile' });
    await this.queue.upsertJobScheduler('expire', { every: 600_000 }, { name: 'expire' });
  }

  async process(job: Job) {
    if (job.name === 'expire') {
      const retried = await this.payments.retryFailedPayouts();
      if (retried) this.log.log(`Retried ${retried} refused payout(s)`);
      return this.payments.refundOverdue();
    }
    if (job.name === 'reconcile') {
      const n = await this.payments.reconcileAll();
      if (n) this.log.log(`Reconciled ${n} pending transaction(s)`);
      return n;
    }
  }
}

import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { MockProvider } from './mock.provider.js';
import { PayazaProvider } from './payaza.provider.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PAYMENT_PROVIDER } from './provider.js';

export const paymentProvider = {
  provide: PAYMENT_PROVIDER,
  useFactory: () => {
    const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:3000';
    if (process.env.PAYMENT_PROVIDER !== 'payaza') return new MockProvider(publicUrl);
    return new PayazaProvider({
      publicKey: process.env.PAYAZA_PUBLIC_KEY!,
      secretKey: process.env.PAYAZA_SECRET_KEY!,
      tenant: process.env.PAYAZA_ENV === 'live' ? 'live' : 'test',
      publicUrl,
      transactionPin: process.env.PAYAZA_TRANSACTION_PIN || undefined,
    });
  },
};

@Module({
  imports: [CampaignsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, paymentProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}

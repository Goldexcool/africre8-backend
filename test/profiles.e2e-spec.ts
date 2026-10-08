import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('Profiles (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(() => app.close());

  it('seeded creator demo can log in and is shown as a card', async () => {
    const login = await http.post('/auth/login').send({ email: 'creator.dev@africre8.app', password: 'CreatorDemo!2026' }).expect(200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const card = await http.get(`/creators/${login.body.user.id}`).set(auth).expect(200);
    expect(card.body.name).toBe('Amara Okoye');
    expect(card.body.platforms.length).toBeGreaterThan(0);
    // Creators cannot write a brand profile
    await http.put('/profiles/brand').set(auth).send({ businessName: 'Nope' }).expect(403);
  });

  it('new creator becomes onboarded after profile + social', async () => {
    const reg = await http
      .post('/auth/register')
      .send({ email: `creator_${Date.now()}@test.africre8.dev`, password: 'password123', role: 'CREATOR' })
      .expect(201);
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    await http
      .put('/profiles/creator')
      .set(auth)
      .send({
        displayName: 'Test Creator',
        category: 'Fashion & Lifestyle',
        location: 'Lagos, Nigeria',
        priceFromNgn: 100000,
        socials: [{ platform: 'tiktok', handle: '@test', followers: 1200, engagementRate: 5 }],
      })
      .expect(200);
    const me = await http.get('/auth/me').set(auth).expect(200);
    expect(me.body.onboardedAt).toBeTruthy();
    await http.put('/profiles/payout-destination').set(auth).send({ bankCode: '058', bankName: 'GTBank', accountNumber: '123' }).expect(400);
  });
});

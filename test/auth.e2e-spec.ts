import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const email = `brand_${Date.now()}@test.africre8.dev`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(() => app.close());

  it('registers, rotates, detects reuse, and logs out', async () => {
    const reg = await http.post('/auth/register').send({ email, password: 'password123', role: 'BRAND' }).expect(201);
    expect(reg.body.user.passwordHash).toBeUndefined();
    await http.post('/auth/register').send({ email, password: 'password123', role: 'BRAND' }).expect(409);

    await http.get('/auth/me').expect(401);
    const me = await http.get('/auth/me').set('Authorization', `Bearer ${reg.body.accessToken}`).expect(200);
    expect(me.body.role).toBe('BRAND');

    const r1 = await http.post('/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(reg.body.refreshToken);

    // Replaying the old token revokes the whole family, including r1's token.
    await http.post('/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(401);
    await http.post('/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);

    const login = await http.post('/auth/login').send({ email, password: 'password123' }).expect(200);
    await http.post('/auth/logout').send({ refreshToken: login.body.refreshToken }).expect(204);
    await http.post('/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
    await http.post('/auth/login').send({ email, password: 'wrong-pass' }).expect(401);
  });
});

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /health reports db up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.db).toBe('up');
  });
});

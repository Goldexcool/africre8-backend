import { io, type Socket } from 'socket.io-client';
import { RedisIoAdapter } from '../src/realtime/redis-io.adapter.js';
import { bootApp, cleanup, makeUser } from './helpers.js';

const once = <T>(s: Socket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));

describe('Realtime (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ctx = await bootApp((app) => app.useWebSocketAdapter(new RedisIoAdapter(app)));
    await ctx.app.listen(0);
    url = await ctx.app.getUrl();
  });

  afterAll(async () => {
    sockets.forEach((s) => s.close());
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  const connect = (token?: string) => {
    const s = io(url, { auth: { token }, transports: ['websocket'] });
    sockets.push(s);
    return s;
  };

  it('rejects sockets without a valid token', async () => {
    const s = connect('nope');
    await once(s, 'disconnect');
  });

  it('pushes interest, match and chat messages live', async () => {
    const { http } = ctx;
    const brand = await makeUser(http, 'BRAND');
    const creator = await makeUser(http, 'CREATOR');
    const bs = connect(brand.auth.Authorization.slice(7));
    const cs = connect(creator.auth.Authorization.slice(7));
    await Promise.all([once(bs, 'connect'), once(cs, 'connect')]);

    const gotInterest = once<{ kind: string }>(cs, 'notification');
    const swipe = await http.post('/swipes').set(brand.auth).send({ creatorId: creator.id, direction: 'LIKE' }).expect(201);
    expect((await gotInterest).kind).toBe('interest');

    const gotMatch = once<{ conversation: { id: string } }>(bs, 'match');
    await http.post(`/interests/${swipe.body.interest.id}/respond`).set(creator.auth).send({ accept: true }).expect(201);
    const conversationId = (await gotMatch).conversation.id;

    const gotMessage = once<{ text: string }>(cs, 'message');
    const ack = await bs.emitWithAck('chat:send', { conversationId, text: 'Hello from the brand' });
    expect(ack.text).toBe('Hello from the brand');
    expect((await gotMessage).text).toBe('Hello from the brand');
  });
});

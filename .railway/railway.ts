import { defineRailway, project, redis, service, volume } from "railway/iac";

const REGION = "us-east4-eqdc4a";
// Replaces railway.json. Code is uploaded with `railway up` (ml from services/ml with --path-as-root), so no repo source.
const docker = { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" } as const;
const restart = { restartPolicyMaxRetries: 5 } as const; // restart policy ON_FAILURE is Railway's default

export default defineRailway(() => {
  const Redis = redis("Redis", { region: REGION });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  Redis.networking = { privateNetworkEndpoint: "redis" };
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: REGION, sizeMB: 500 });

  // api and worker share one image; worker sets PROCESS=worker (a Railway variable, unmanaged here).
  const api = service("api", { build: docker, deploy: restart, healthcheck: "/health", replicas: { [REGION]: 1 } });
  const worker = service("worker", { build: docker, deploy: restart, replicas: { [REGION]: 1 } });
  const ml = service("ml", { build: docker, deploy: restart, healthcheck: "/health", replicas: { [REGION]: 1 } });

  return project("africre8-backend", {
    variables: { managed: false },
    resources: [api, worker, ml, Redis, redisVolume],
  });
});

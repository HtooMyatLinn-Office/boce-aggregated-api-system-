import app from './app';
import { config } from './config';
import { startNodeCacheAutoRefresh } from './services/boce';
import { startDetectWorker } from './services/queue/detectQueue';
import { migrate } from './services/db/migrate';
import { startBatchDomainWorker } from './services/queue/batchQueue';
import { bootstrapClient } from './services/db/clientAuthRepo';

const server = app.listen(config.port, () => {
  console.log(`Boce API listening on port ${config.port} (${config.nodeEnv})`);
});

// DB migrations (best-effort). If DB isn't configured, app can still run in no-storage mode.
migrate()
  .then(async () => {
    console.log('DB migrated');
    // Optional bootstrap for first commercial client credentials.
    if (
      config.auth.enabled &&
      !config.auth.staticMode &&
      config.auth.bootstrapClientId &&
      config.auth.bootstrapApiKey
    ) {
      await bootstrapClient({
        clientId: config.auth.bootstrapClientId,
        clientName: config.auth.bootstrapClientName,
        apiKey: config.auth.bootstrapApiKey,
      });
      console.log(`Client bootstrap ready: ${config.auth.bootstrapClientId}`);
    }
  })
  .catch((e) => console.warn('DB migration skipped/failed:', e?.message ?? e));

startNodeCacheAutoRefresh();
startDetectWorker();
startBatchDomainWorker();

export default server;

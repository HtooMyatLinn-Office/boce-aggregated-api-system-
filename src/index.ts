import app from './app';
import { config } from './config';
import { startNodeCacheAutoRefresh } from './services/boce';
import { startDetectWorker } from './services/queue/detectQueue';
import { migrate } from './services/db/migrate';

const server = app.listen(config.port, () => {
  console.log(`Boce API listening on port ${config.port} (${config.nodeEnv})`);
});

// DB migrations (best-effort). If DB isn't configured, app can still run in no-storage mode.
migrate()
  .then(() => console.log('DB migrated'))
  .catch((e) => console.warn('DB migration skipped/failed:', e?.message ?? e));

startNodeCacheAutoRefresh();
startDetectWorker();

export default server;

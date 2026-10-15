import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

// From src/config or dist/config, resolve to the repository root.
dotenv.config({
  path: path.resolve(currentDir, '../../../.env'),
});
import { createGatewayServer } from './server.js';
import { rootLogger } from './core/logger.js';

async function main() {
  try {
    const server = createGatewayServer();
    await server.start();
    rootLogger.info(
      `SIM7600EI Gateway service listening on http://${server.config.host}:${server.config.port}`
    );
    rootLogger.info(
      `Driver: ${server.modem.driverType.toUpperCase()} (Simulated: ${server.modem.isSimulated})`
    );
    if (server.modem.driverType === 'hardware') {
      rootLogger.info(`Physical AT Port: ${server.config.atPort} @ ${server.config.atBaudRate} baud`);
      rootLogger.info(`Physical Audio Port: ${server.config.audioPort} @ ${server.config.audioBaudRate} baud`);
    }

    const shutdown = async () => {
      rootLogger.info('Gracefully shutting down...');
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    rootLogger.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();

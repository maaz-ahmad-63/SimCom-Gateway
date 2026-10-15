import { createGatewayServer } from './server.js';

async function main() {
  try {
    const server = createGatewayServer();
    await server.start();
    console.log(
      `[Gateway] SIM7600EI Gateway service listening on http://${server.config.host}:${server.config.port}`
    );
    console.log(
      `[Gateway] Driver: ${server.modem.driverType.toUpperCase()} (Simulated: ${server.modem.isSimulated})`
    );
    if (server.modem.driverType === 'hardware') {
      console.log(`[Gateway] Physical AT Port: ${server.config.atPort} @ ${server.config.atBaudRate} baud`);
      console.log(`[Gateway] Physical Audio Port: ${server.config.audioPort} @ ${server.config.audioBaudRate} baud`);
    }

    const shutdown = async () => {
      console.log('\n[Gateway] Gracefully shutting down...');
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('[Gateway] Failed to start server:', err);
    process.exit(1);
  }
}

main();

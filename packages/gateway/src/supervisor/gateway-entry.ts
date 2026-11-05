/**
 * How the supervisor starts the gateway in the customer package.
 *
 * It runs the normal gateway entry unchanged, and adds one thing: it listens for a "shutdown" message from the supervisor and answers it
 * as if the process had been told to stop (SIGTERM), so the gateway's own graceful shutdown runs (calls cleaned up, ports and recordings
 * closed, database closed). On Windows a real signal sent from another process is an immediate kill, so this message is the only way to
 * let the gateway finish cleanly. The development gateway (`npm run dev`) does not use this file.
 */
import '../index.js';

process.on('message', (message) => {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'shutdown') return;
  // index.ts registers its SIGINT/SIGTERM handlers once the server is up. Before that there is nothing to clean up.
  if (process.listenerCount('SIGTERM') > 0) (process as unknown as NodeJS.EventEmitter).emit('SIGTERM');
  else process.exit(0);
});

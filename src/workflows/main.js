// Entry point for the Render Workflow service (start command: `node src/workflows/main.js`).
// Importing the definitions registers them; the SDK starts the task server automatically
// when Render provides RENDER_SDK_SOCKET_PATH.
import { log } from '../util/log.js';
import './tasks.js';

log.info('workflow.process.started', { node: process.version, pid: process.pid, logLevel: process.env.LOG_LEVEL || 'info' });
process.on('unhandledRejection', (err) => log.error('workflow.unhandled_rejection', { err }));

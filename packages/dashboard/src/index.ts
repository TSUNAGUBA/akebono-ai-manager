import { createPool, startServer } from '@ai-manager/shared';
import { createDashboardServer } from './server.js';

const pool = createPool();
startServer(createDashboardServer(pool), 'dashboard');

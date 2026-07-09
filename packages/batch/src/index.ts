import { createPool, startServer } from '@ai-manager/shared';
import { createBatchServer } from './server.js';

const pool = createPool();
startServer(createBatchServer(pool), 'batch');

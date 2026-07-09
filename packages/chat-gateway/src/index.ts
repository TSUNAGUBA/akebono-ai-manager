import { createPool, startServer } from '@ai-manager/shared';
import { createChatGatewayServer } from './server.js';

const pool = createPool();
startServer(createChatGatewayServer(pool), 'chat-gateway');

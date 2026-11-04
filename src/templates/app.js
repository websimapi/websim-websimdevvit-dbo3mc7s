import { dbHelpers } from './server/db.js';
import { coreRoutes } from './server/routes/core.js';
import { paymentRoutes } from './server/routes/payments.js';
import { commentRoutes } from './server/routes/comments.js';
import { assetRoutes } from './server/routes/assets.js';
import { internalRoutes } from './server/routes/internal.js';
import { websimBridgeImports, websimBridge } from './server/websim-bridge.js';
import { websimRoomBridge } from './server/websim-room.js';

// options.websimServer: the project has a WebSim server.js (copied to src/server/websim/)
export const getMainTs = (title, options = {}) => {
    const safeTitle = title.replace(/'/g, "\\'");
    return `
import express from 'express';
// Devvit Web server SDK. Permissions (Redis, realtime, Reddit API, payments)
// are declared in devvit.json; the deprecated @devvit/public-api is not used.
import {
    createServer,
    context,
    getServerPort,
    redis,
    reddit,
    realtime,
    payments,
    media,
    settings
} from '@devvit/web/server';
import { RichTextBuilder } from '@devvit/shared-types/richtext/RichTextBuilder.js';
${options.websimServer ? websimBridgeImports : ''}

const app = express();

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

const router = express.Router();

// 1. Database & Helper Functions
${dbHelpers}

// 2. Core Routes (Project, User, Storage)
${coreRoutes}

// 3. Payment Routes (Tips, Supporters)
${paymentRoutes}

// 4. Comment Routes
${commentRoutes}

// 5. Asset Routes (Avatars, JSON)
${assetRoutes}

// 6. Internal Routes (Triggers, Realtime)
${internalRoutes(safeTitle)}

app.use(router);

${options.websimServer ? websimBridge : ''}
${options.websimServer ? websimRoomBridge : ''}

const port = getServerPort();
const server = createServer(app);

server.on('error', (err) => console.error(\`server error; \${err.stack}\`));
server.listen(port, () => console.log(\`Server listening on \${port}\`));
`;
};


import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The shared modules are classic scripts that publish themselves on globalThis; load them in order.
export const core = require('../chess-core.js');
export const protocol = require('../shared/protocol.js');
export const facade = require('../shared/engine-facade.js');
export const rl = require('../shared/room-logic.js');
export const session = require('../shared/room-session.js');
export const rating = require('../shared/rating.js');
export const lobbyLogic = require('../shared/lobby-logic.js');
export const lobbySession = require('../shared/lobby-session.js');
export const accountApi = require('../shared/account-api.js');

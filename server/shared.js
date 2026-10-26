import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The shared modules are classic scripts that publish themselves on globalThis; load them in order.
export const core = require('../chess-core.js');
export const protocol = require('../shared/protocol.js');
export const facade = require('../shared/engine-facade.js');
export const rl = require('../shared/room-logic.js');
export const session = require('../shared/room-session.js');

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const protocol = require('../shared/protocol.js');

export const PROTOCOL_VERSION = protocol.PROTOCOL_VERSION;
export const TYPES = protocol.TYPES;
export const ERROR_CODES = protocol.ERROR_CODES;
export const ROOM_LESS_TYPES = protocol.ROOM_LESS_TYPES;
export const DRAW_REASON_ALIASES = protocol.DRAW_REASON_ALIASES;
export const createMessage = protocol.createMessage;
export const validateEnvelope = protocol.validateEnvelope;
export const createError = protocol.createError;

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

globalThis.ChessCore = globalThis.ChessCore || require('../chess-core.js');
globalThis.BlendChessProtocol = globalThis.BlendChessProtocol || require('../shared/protocol.js');
globalThis.BlendChessEngineFacade = globalThis.BlendChessEngineFacade || require('../shared/engine-facade.js');

const facade = globalThis.BlendChessEngineFacade;

export const evaluateMove = facade.evaluateMove;

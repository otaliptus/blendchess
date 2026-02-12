import './chess-core.js';
import { GameHub } from './room.js';

function isWebSocketUpgrade(request) {
  const upgrade = request.headers.get('Upgrade');
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (!isWebSocketUpgrade(request)) {
      return new Response('Blendchess multiplayer worker. Use WebSocket Upgrade.', { status: 200 });
    }

    const id = env.GAME_HUB.idFromName('global-hub');
    const stub = env.GAME_HUB.get(id);
    return stub.fetch(request);
  },
};

export { GameHub };

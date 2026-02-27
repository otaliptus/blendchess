import { createRequire } from 'node:module';
import { customAlphabet } from 'nanoid';

const require = createRequire(import.meta.url);

// Bridge CJS modules into globalThis so the shared IIFE modules can find them
globalThis.ChessCore = globalThis.ChessCore || require('../chess-core.js');
globalThis.BlendChessProtocol = globalThis.BlendChessProtocol || require('../shared/protocol.js');
globalThis.BlendChessEngineFacade = globalThis.BlendChessEngineFacade || require('../shared/engine-facade.js');
globalThis.BlendChessRoomLogic = globalThis.BlendChessRoomLogic || require('../shared/room-logic.js');

const rl = globalThis.BlendChessRoomLogic;

const makeResumeToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

export class Room {
  constructor(roomCode) {
    this.state = rl.createRoomState(roomCode);
  }

  resetGame(keepAssignments) {
    if (!keepAssignments) {
      this.state.players = {};
      this.state.playerOrder = [];
      this.state.spectators = {};
      this.state.spectatorOrder = [];
    }
    rl.resetGame(this.state);
  }

  get playerCount() {
    return this.state.playerOrder.length;
  }

  connectedPlayerCount() {
    return rl.connectedPlayerCount(this.state);
  }

  connectedSpectatorCount() {
    return rl.connectedSpectatorCount(this.state);
  }

  isColorConnected(color) {
    return rl.isColorConnected(this.state, color);
  }

  hasConnectedMembers() {
    return rl.hasConnectedMembers(this.state);
  }

  isFull() {
    return rl.isFull(this.state);
  }

  getPlayer(playerId) {
    return rl.getPlayer(this.state, playerId);
  }

  getPlayerByColor(color) {
    return rl.getPlayerByColor(this.state, color);
  }

  getSeatAssignments() {
    return rl.getSeatAssignments(this.state);
  }

  getSpectatorAssignments() {
    return rl.getSpectatorAssignments(this.state);
  }

  cleanupDisconnectedColor(color) {
    rl.cleanupDisconnectedColor(this.state, color);
  }

  assignPlayer(playerId, nickname, resumeToken) {
    var tokenFn = resumeToken ? function () { return resumeToken; } : makeResumeToken;
    return rl.assignPlayer(this.state, playerId, nickname, tokenFn);
  }

  assignSpectator(spectatorId, nickname) {
    return rl.assignSpectator(this.state, spectatorId, nickname);
  }

  removePlayer(playerId) {
    rl.removePlayer(this.state, playerId);
  }

  removeSpectator(spectatorId) {
    rl.removeSpectator(this.state, spectatorId);
  }

  createGameSnapshot() {
    return rl.createGameSnapshot(this.state);
  }

  isReady() {
    return rl.isReady(this.state);
  }

  claimDraw(playerId, payload) {
    var player = this.getPlayer(playerId);
    return rl.claimDraw(this.state, player, payload);
  }

  resign(playerId) {
    var player = this.getPlayer(playerId);
    return rl.resign(this.state, player);
  }

  setHardMode(enabled, actorLabel) {
    rl.setHardMode(this.state, enabled, actorLabel);
  }

  isResumeTokenValid(playerId, resumeToken) {
    var player = this.getPlayer(playerId);
    if (!player || !player.resumeToken) {
      return false;
    }
    return player.resumeToken === resumeToken;
  }

  applyMove(playerId, payload) {
    var player = this.getPlayer(playerId);
    return rl.applyMove(this.state, player, payload);
  }
}

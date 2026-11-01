// Called inside blockConcurrencyWhile, before either object's state/cache is loaded.
// Sleeping objects erase their old data when they next receive a request or alarm.
export async function prepareStorage(ctx, { room = false } = {}) {
  const version = globalThis.BlendChessProtocol.DATA_VERSION;
  const roomState = room ? await ctx.storage.get('room') : null;
  const stored = (await ctx.storage.get('dataVersion')) ?? (roomState && roomState.dataVersion);
  const previous = stored ?? 1;
  // Unknown room codes must remain storage-free. A real room records its version in persist().
  const hasData = stored != null || !room || Boolean(roomState);
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(previous) || previous > version) {
    throw new Error('Invalid data version or attempted rollback across a data reset. Keep DATA_VERSION at its latest value.');
  }
  if (hasData && previous < version) {
    // Explicitly remove the alarm: deleteAll does not remove it at our compatibility date.
    await ctx.storage.deleteAlarm();
    await ctx.storage.deleteAll();
  }
  if (hasData && stored !== version) await ctx.storage.put('dataVersion', version);

  // Also do this after a restart that happened between the storage reset and socket cleanup.
  for (const ws of ctx.getWebSockets()) {
    if (!socketIsCurrent(ws)) {
      try {
        ws.close(globalThis.BlendChessProtocol.DATA_RESET_CLOSE_CODE, 'Game data was reset. Reload to start again.');
      } catch {
        // already closed
      }
    }
  }
}

export function socketIsCurrent(ws) {
  return ((ws.deserializeAttachment() || {}).dataVersion ?? 1) === globalThis.BlendChessProtocol.DATA_VERSION;
}

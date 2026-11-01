(function installDataVersion() {
  const versionKey = (serverUrl) => `blendchess.dataVersion@${serverUrl}`;
  function read(storage, key, fallback) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  function current(storage, serverUrl) {
    const value = read(storage, versionKey(serverUrl), 1);
    return Number.isSafeInteger(value) && value >= 1 ? value : 1;
  }

  // Scope resets to the server that announced them. A link to somebody else's server must not
  // erase the main account, local games, preferences, or another server's saved room.
  function apply(storage, { version, serverUrl, defaultServerUrl, identityKey, keys }) {
    if (!Number.isSafeInteger(version) || version < 1 || version <= current(storage, serverUrl)) return false;
    storage.removeItem(identityKey);
    const savedRoom = read(storage, keys.session, null);
    if (savedRoom && (savedRoom.serverUrl || defaultServerUrl) === serverUrl) storage.removeItem(keys.session);
    const isDefault = serverUrl === defaultServerUrl;
    if (isDefault) storage.removeItem(keys.local);
    const archive = read(storage, keys.archive, []);
    if (Array.isArray(archive)) {
      const kept = archive.filter((entry) => entry.mode === 'local'
        ? !isDefault
        : (entry.serverUrl || defaultServerUrl) !== serverUrl);
      if (kept.length !== archive.length) storage.setItem(keys.archive, JSON.stringify(kept));
    }
    // Last: if storage fails halfway through, the next visit retries the cleanup.
    storage.setItem(versionKey(serverUrl), JSON.stringify(version));
    return true;
  }

  const api = { current, apply };
  globalThis.BlendChessDataVersion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

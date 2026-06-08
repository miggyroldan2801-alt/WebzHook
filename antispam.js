// ─── In-memory spam tracking ────────────────────────────────────────────────
const spamMap = new Map();      // userId -> [timestamps]
const duplicateMap = new Map(); // userId -> { content, count }
const raidMap = new Map();      // guildId -> [timestamps]

function trackSpam(userId, guildId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  if (!spamMap.has(key)) spamMap.set(key, []);
  const times = spamMap.get(key).filter(t => now - t < 4000);
  times.push(now);
  spamMap.set(key, times);
  return times.length;
}

function trackDuplicate(userId, guildId, content) {
  const key = `${guildId}:${userId}`;
  const entry = duplicateMap.get(key);
  if (entry && entry.content === content) {
    entry.count++;
    duplicateMap.set(key, entry);
    return entry.count;
  }
  duplicateMap.set(key, { content, count: 1 });
  return 1;
}

function trackRaid(guildId) {
  const now = Date.now();
  if (!raidMap.has(guildId)) raidMap.set(guildId, []);
  const times = raidMap.get(guildId).filter(t => now - t < 10000);
  times.push(now);
  raidMap.set(guildId, times);
  return times.length;
}

function clearUser(userId, guildId) {
  const key = `${guildId}:${userId}`;
  spamMap.delete(key);
  duplicateMap.delete(key);
}

module.exports = { trackSpam, trackDuplicate, trackRaid, clearUser };
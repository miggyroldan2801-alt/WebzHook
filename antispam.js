// In-memory maps for detection
const spamMap     = new Map(); // userId:guildId -> timestamps[]
const dupMap      = new Map(); // userId:guildId -> {content, count, ts}
const raidMap     = new Map(); // guildId        -> timestamps[]
const nukeMap     = new Map(); // userId:guildId -> timestamps[]
const linkMap     = new Map(); // userId:guildId -> count

function trackSpam(uid, gid, windowMs = 4000, limit = 5) {
  const key = `${uid}:${gid}`, now = Date.now();
  const times = (spamMap.get(key) || []).filter(t => now - t < windowMs);
  times.push(now);
  spamMap.set(key, times);
  return times.length;
}

function trackDuplicate(uid, gid, content, limit = 4) {
  const key = `${uid}:${gid}`;
  const e   = dupMap.get(key);
  if (e && e.content === content && Date.now() - e.ts < 30000) {
    e.count++;
    e.ts = Date.now();
    dupMap.set(key, e);
    return e.count;
  }
  dupMap.set(key, { content, count: 1, ts: Date.now() });
  return 1;
}

function trackRaid(gid, windowMs = 10000) {
  const now   = Date.now();
  const times = (raidMap.get(gid) || []).filter(t => now - t < windowMs);
  times.push(now);
  raidMap.set(gid, times);
  return times.length;
}

function trackNukeAction(uid, gid, windowMs = 10000) {
  const key   = `${uid}:${gid}`, now = Date.now();
  const times = (nukeMap.get(key) || []).filter(t => now - t < windowMs);
  times.push(now);
  nukeMap.set(key, times);
  return times.length;
}

function clearUser(uid, gid) {
  spamMap.delete(`${uid}:${gid}`);
  dupMap.delete(`${uid}:${gid}`);
}

module.exports = { trackSpam, trackDuplicate, trackRaid, trackNukeAction, clearUser };
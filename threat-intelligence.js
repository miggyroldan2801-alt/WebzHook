// ─────────────────────────────────────────────────────────────────────────────
//  THREAT INTELLIGENCE ENGINE
//  Detects compromised accounts, scam campaigns, and suspicious behaviour
// ─────────────────────────────────────────────────────────────────────────────

// ── Scam / phishing patterns ─────────────────────────────────────────────────
const SCAM_DOMAINS = [
  // Classic Discord phishing
  'discordapp.io','discordnitro.gift','discord-nitro.gift','discordgift.io',
  'steamcommunity.ru','steamcommunity.gift','steam-community.ru',
  // MrBeast / giveaway scams
  'mrbeast-giveaway','mrbeastgift','mrbeast.gift','mrbeastfree',
  'free-robux','freerobux','robux-generator',
  'nitro-generator','free-nitro','freepremium',
  // Generic phishing infra
  'grabify.link','iplogger.org','yip.su','2no.co','lovebird.io',
  'bc.ax','bstats.info','cdn-discords','discord-app.io',
  'dlscord','discrod','dicsord',
  // Crypto scams
  'bit.ly','tinyurl.com', // won't auto-block but flag when combined with scam keywords
];

const SCAM_KEYWORDS = [
  // Giveaway bait
  'free nitro','free discord nitro','free robux','free vbucks',
  'free steam','free gift card','win a gift','claim your prize',
  'you have been selected','congratulations you won',
  // MrBeast specific
  'mrbeast giveaway','mrbeast gift','mr beast free',
  'mrbeast picked you','mrbeast challenge',
  // Urgency / FOMO tactics
  'claim in 24 hours','expires soon','limited time offer',
  'first 100 people','only today','act fast',
  // Social engineering
  'click this link','verify your account','your account has been',
  'suspicious activity on your','unusual login','account suspended',
  // Crypto
  'crypto giveaway','elon musk giveaway','send btc receive',
  'double your crypto','send eth get back',
  // Generic scam
  'bit.ly/free','http://bit.ly','www.bit.ly',
];

const IMAGE_SPAM_PATTERNS = [
  // URLs ending in image extensions sent rapidly
  /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i,
  // CDN links that are commonly abused for image spam
  /cdn\d*\.(discordapp|discord)\.com\/attachments/i,
  // Image hosting sites used in spam campaigns
  /imgur\.com|imgbb\.com|ibb\.co|prntscr\.com|prnt\.sc/i,
];

const SUSPICIOUS_URL_REGEX = /https?:\/\/[^\s<>]+/gi;

// ── In-memory tracking ────────────────────────────────────────────────────────
const dmAttempts     = new Map(); // userId -> { count, guildIds[], lastSeen }
const imageSpamMap   = new Map(); // userId:guildId -> { count, timestamps[] }
const scamScoreMap   = new Map(); // userId:guildId -> { score, events[], firstSeen }
const suspectHistory = new Map(); // userId -> { flags[], firstSeen }

// ── Score thresholds ──────────────────────────────────────────────────────────
const SCORE_WARN       = 30;  // Warn the user
const SCORE_MUTE       = 55;  // Auto-mute
const SCORE_QUARANTINE = 75;  // Quarantine + notify mods
const SCORE_BAN        = 100; // Auto-ban (if server has it enabled)

// ── Scoring weights ───────────────────────────────────────────────────────────
const WEIGHTS = {
  SCAM_DOMAIN:         40,
  SCAM_KEYWORD_EXACT:  15,
  SCAM_KEYWORD_MULTI:  25, // 3+ keywords in one message
  IMAGE_SPAM_BURST:    20, // 5+ images in 30s
  IMAGE_SPAM_EXTREME:  45, // 10+ images in 60s
  MASS_DM_ATTEMPT:     35,
  NEW_ACCOUNT:         10, // account < 7 days old
  NO_AVATAR:            5, // no profile picture
  MENTION_COMBO:       15, // mass ping + link in same msg
  RAPID_JOIN_SEND:     20, // sent message within 10s of joining
  EXTERNAL_EMBED:      10, // embed from unknown domain
  SAME_MSG_MULTI_CH:   30, // exact same message in 3+ channels in 60s
  NITRO_BAIT:          35, // "free nitro" + link
};

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ANALYSIS FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
function analyseMessage(message, member) {
  const content  = message.content || '';
  const lower    = content.toLowerCase();
  const userId   = message.author.id;
  const guildId  = message.guild?.id;
  const key      = `${userId}:${guildId}`;
  const now      = Date.now();

  let score      = 0;
  const reasons  = [];
  const urls     = content.match(SUSPICIOUS_URL_REGEX) || [];

  // 1. Check scam domains in URLs
  for (const url of urls) {
    const urlLower = url.toLowerCase();
    for (const domain of SCAM_DOMAINS) {
      if (urlLower.includes(domain)) {
        score += WEIGHTS.SCAM_DOMAIN;
        reasons.push(`Scam domain detected: \`${domain}\``);
        break;
      }
    }
  }

  // 2. Check scam keywords
  let kwHits = 0;
  for (const kw of SCAM_KEYWORDS) {
    if (lower.includes(kw)) { kwHits++; }
  }
  if (kwHits >= 3) {
    score += WEIGHTS.SCAM_KEYWORD_MULTI;
    reasons.push(`Multiple scam keywords (${kwHits} matches)`);
  } else if (kwHits > 0) {
    score += WEIGHTS.SCAM_KEYWORD_EXACT * kwHits;
    reasons.push(`Scam keyword match (${kwHits}x)`);
  }

  // 3. Free Nitro + URL combo (very high confidence scam)
  if ((lower.includes('free nitro') || lower.includes('nitro gift')) && urls.length > 0) {
    score += WEIGHTS.NITRO_BAIT;
    reasons.push('Free Nitro bait with link');
  }

  // 4. Mass mention + URL combo
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (mentionCount >= 3 && urls.length > 0) {
    score += WEIGHTS.MENTION_COMBO;
    reasons.push(`Mass mention + link combo (${mentionCount} mentions)`);
  }

  // 5. Account age check
  const accountAgeMs   = now - message.author.createdTimestamp;
  const accountAgeDays = accountAgeMs / 86400000;
  if (accountAgeDays < 7) {
    score += WEIGHTS.NEW_ACCOUNT;
    reasons.push(`New account (${Math.floor(accountAgeDays)}d old)`);
  }

  // 6. No avatar
  if (!message.author.avatar) {
    score += WEIGHTS.NO_AVATAR;
    reasons.push('No profile picture');
  }

  // 7. Rapid join + send (sent message within 15s of joining)
  if (member?.joinedTimestamp && (now - member.joinedTimestamp) < 15000) {
    score += WEIGHTS.RAPID_JOIN_SEND;
    reasons.push('Message sent <15s after joining');
  }

  // 8. Same message multi-channel tracking
  trackMultiChannel(userId, guildId, content, now);
  const chCount = getMultiChannelCount(userId, guildId, content);
  if (chCount >= 3) {
    score += WEIGHTS.SAME_MSG_MULTI_CH;
    reasons.push(`Identical message in ${chCount} channels`);
  }

  // 9. Accumulate score in map
  const existing = scamScoreMap.get(key) || { score: 0, events: [], firstSeen: now };
  existing.score = Math.min(existing.score + score, 150); // cap at 150
  if (score > 0) existing.events.push({ score, reasons: [...reasons], ts: now });
  if (existing.events.length > 20) existing.events = existing.events.slice(-20);
  scamScoreMap.set(key, existing);

  return {
    score: existing.score,
    sessionScore: score,
    reasons,
    totalScore: existing.score,
    isCompromised: existing.score >= SCORE_BAN,
    needsQuarantine: existing.score >= SCORE_QUARANTINE,
    needsMute: existing.score >= SCORE_MUTE,
    needsWarn: existing.score >= SCORE_WARN,
    history: existing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMAGE SPAM DETECTION
// ─────────────────────────────────────────────────────────────────────────────
function trackImageSpam(userId, guildId) {
  const key = `${userId}:${guildId}`;
  const now = Date.now();
  const entry = imageSpamMap.get(key) || { timestamps: [] };
  entry.timestamps = entry.timestamps.filter(t => now - t < 60000); // 60s window
  entry.timestamps.push(now);
  imageSpamMap.set(key, entry);

  const count30s = entry.timestamps.filter(t => now - t < 30000).length;
  const count60s = entry.timestamps.length;

  let score = 0;
  const reasons = [];

  if (count60s >= 10) {
    score += WEIGHTS.IMAGE_SPAM_EXTREME;
    reasons.push(`Extreme image spam: ${count60s} images in 60s`);
  } else if (count30s >= 5) {
    score += WEIGHTS.IMAGE_SPAM_BURST;
    reasons.push(`Image spam burst: ${count30s} images in 30s`);
  }

  return { score, reasons, count30s, count60s };
}

function isImageAttachment(message) {
  if (message.attachments.size > 0) {
    return [...message.attachments.values()].some(a =>
      a.contentType?.startsWith('image/') || IMAGE_SPAM_PATTERNS[0].test(a.name || '')
    );
  }
  const urls = message.content.match(SUSPICIOUS_URL_REGEX) || [];
  return urls.some(u => IMAGE_SPAM_PATTERNS.some(p => p.test(u)));
}

// ─────────────────────────────────────────────────────────────────────────────
//  MULTI-CHANNEL TRACKING
// ─────────────────────────────────────────────────────────────────────────────
const multiChannelMap = new Map();

function trackMultiChannel(userId, guildId, content, now) {
  const userKey = `${userId}:${guildId}`;
  const msgKey  = content.trim().toLowerCase().slice(0, 100);
  if (!multiChannelMap.has(userKey)) multiChannelMap.set(userKey, new Map());
  const userMap = multiChannelMap.get(userKey);
  const entry   = userMap.get(msgKey) || { channels: new Set(), firstSeen: now };
  entry.channels.add(content); // track unique channel mentions
  if (now - entry.firstSeen > 60000) { entry.channels.clear(); entry.firstSeen = now; }
  userMap.set(msgKey, entry);
}

function getMultiChannelCount(userId, guildId, content) {
  const userKey = `${userId}:${guildId}`;
  const msgKey  = content.trim().toLowerCase().slice(0, 100);
  return multiChannelMap.get(userKey)?.get(msgKey)?.channels.size || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  DM SPAM DETECTION (cross-server — fires when same user DMs from multiple servers)
// ─────────────────────────────────────────────────────────────────────────────
function trackDMAttempt(userId, guildId) {
  const entry = dmAttempts.get(userId) || { count: 0, guildIds: [], lastSeen: 0 };
  const now   = Date.now();
  if (now - entry.lastSeen > 300000) { entry.count = 0; entry.guildIds = []; } // reset after 5m
  if (!entry.guildIds.includes(guildId)) entry.guildIds.push(guildId);
  entry.count++;
  entry.lastSeen = now;
  dmAttempts.set(userId, entry);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACCOUNT COMPROMISE SIGNALS
// ─────────────────────────────────────────────────────────────────────────────
function getCompromiseSignals(member) {
  const signals = [];
  const now     = Date.now();
  const user    = member.user;

  const ageDays = (now - user.createdTimestamp) / 86400000;
  if (ageDays < 3)  signals.push({ flag: 'VERY_NEW_ACCOUNT', severity: 'HIGH',   desc: `Account only ${Math.floor(ageDays * 24)}h old` });
  if (ageDays < 30) signals.push({ flag: 'NEW_ACCOUNT',      severity: 'MEDIUM', desc: `Account ${Math.floor(ageDays)}d old` });
  if (!user.avatar)  signals.push({ flag: 'NO_AVATAR',        severity: 'LOW',    desc: 'No profile picture set' });

  const joinAge = member.joinedTimestamp ? (now - member.joinedTimestamp) / 1000 : null;
  if (joinAge !== null && joinAge < 60) signals.push({ flag: 'JUST_JOINED', severity: 'MEDIUM', desc: `Joined ${Math.floor(joinAge)}s ago` });

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RESET
// ─────────────────────────────────────────────────────────────────────────────
function resetUserScore(userId, guildId) {
  scamScoreMap.delete(`${userId}:${guildId}`);
  imageSpamMap.delete(`${userId}:${guildId}`);
}

function getUserScore(userId, guildId) {
  return scamScoreMap.get(`${userId}:${guildId}`) || { score: 0, events: [] };
}

// ── Periodic cleanup (every 10 minutes) ──────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 600000; // 10 min
  for (const [k, v] of scamScoreMap) {
    if (v.firstSeen && v.firstSeen < cutoff && v.score < SCORE_MUTE) scamScoreMap.delete(k);
  }
  for (const [k, v] of imageSpamMap) {
    if (!v.timestamps.some(t => Date.now() - t < 300000)) imageSpamMap.delete(k);
  }
}, 600000);

module.exports = {
  analyseMessage,
  trackImageSpam,
  isImageAttachment,
  trackDMAttempt,
  getCompromiseSignals,
  resetUserScore,
  getUserScore,
  SCORE_WARN,
  SCORE_MUTE,
  SCORE_QUARANTINE,
  SCORE_BAN,
  SCAM_DOMAINS,
  SCAM_KEYWORDS,
};
module.exports = {
  PREFIX: '%',
  BOT_ACCESS_ROLE: 'Bot Manager',
  QUARANTINE_ROLE: 'Quarantined',
  MUTE_ROLE: 'Muted',
  MASS_PING_THRESHOLD: 5,
  BLOCK_ROLE_PINGS: true,

  // Anti-spam settings
  SPAM_MESSAGE_LIMIT: 5,       // messages
  SPAM_TIME_WINDOW: 4000,      // ms
  DUPLICATE_LIMIT: 4,          // same message repeated
  CAPS_PERCENT: 80,            // % caps to trigger
  CAPS_MIN_LENGTH: 10,         // min message length to check caps
  MENTION_LIMIT_USER: 5,       // max mentions per message (real users)
  RAID_JOIN_LIMIT: 10,         // joins within window = raid
  RAID_JOIN_WINDOW: 10000,     // ms

  COLOR: {
    RED:    0xED4245,
    GREEN:  0x57F287,
    YELLOW: 0xFEE75C,
    BLUE:   0x5865F2,
    ORANGE: 0xE67E22,
    GREY:   0x95A5A6,
    PURPLE: 0x9B59B6,
    DARK:   0x2C3E50,
  },
};
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  ActivityType
} = require("discord.js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MODMAIL_CATEGORY_ID = process.env.MODMAIL_CATEGORY_ID;
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const MANAGER_USER_ID = "1124685735384072213";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

const tickets = new Map();
const weeklyClaims = new Map();        // userId -> number
const twoWeekClaims = new Map();       // userId -> [lastWeek, thisWeek]

// -------------------- HELPERS --------------------
function getFirstImage(msg) {
  const a = msg.attachments.first();
  return a && a.contentType?.startsWith("image/") ? a.url : null;
}

async function closeTicket(ticket, reason) {
  const user = await client.users.fetch(ticket.userId).catch(() => null);
  const channel = await client.channels.fetch(ticket.channelId).catch(() => null);

  if (user) {
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Ticket Closed")
          .setDescription(reason)
          .setColor(0xFF0000)
      ]
    }).catch(() => {});
  }

  if (channel) await channel.delete().catch(() => {});
  tickets.delete(ticket.userId);
}

// -------------------- READY --------------------
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("for tickets", { type: ActivityType.Listening });
  client.user.setStatus("idle");
});

// -------------------- DM HANDLER (CRITICAL FIX) --------------------
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;

  // USER DM → STAFF CHANNEL
  if (!msg.guild) {
    const ticket = tickets.get(msg.author.id);
    if (!ticket) return;

    const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle("📩 New Message from User")
      .setDescription(msg.content || "*No text*")
      .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
      .setColor(0x00AE86)
      .setTimestamp();

    const img = getFirstImage(msg);
    if (img) embed.setImage(img);

    ticket.lastActivity = Date.now();
    return channel.send({ embeds: [embed] });
  }

  // GUILD MESSAGE BELOW
  const ticket = [...tickets.values()].find(t => t.channelId === msg.channel.id);
  if (!ticket) return;

  const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
  if (!member || !member.roles.cache.has(STAFF_ROLE_ID)) return;

  const content = msg.content.toLowerCase();

  if (content === "!claim") {
    if (ticket.claimed) return msg.reply("❌ Already claimed.");
    ticket.claimed = true;
    ticket.claimedBy = msg.author.id;

    weeklyClaims.set(msg.author.id, (weeklyClaims.get(msg.author.id) || 0) + 1);

    const twoWeeks = twoWeekClaims.get(msg.author.id) || [0, 0];
    twoWeeks[1]++;
    twoWeekClaims.set(msg.author.id, twoWeeks);

    return msg.reply("✅ Ticket claimed.");
  }

  if (!ticket.claimed) return msg.reply("❌ Claim the ticket first.");

  if (content === "!close") {
    await closeTicket(ticket, "Closed by staff.");
    return;
  }

  if (!content.startsWith("!")) {
    const user = await client.users.fetch(ticket.userId).catch(() => null);
    if (!user) return;

    const embed = new EmbedBuilder()
      .setTitle("📩 Message from Support Team")
      .setDescription(msg.content || "*No text*")
      .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
      .setColor(0xFFA500)
      .setTimestamp();

    const img = getFirstImage(msg);
    if (img) embed.setImage(img);

    ticket.lastActivity = Date.now();
    await user.send({ embeds: [embed] }).catch(() => {});
  }
});

// -------------------- AUTO CLOSE --------------------
setInterval(() => {
  const now = Date.now();
  for (const ticket of tickets.values()) {
    if (now - ticket.lastActivity > 24 * 60 * 60 * 1000) {
      closeTicket(ticket, "Closed due to inactivity.");
    }
  }
}, 60 * 60 * 1000);

// -------------------- WEEKLY QUOTA RESET --------------------
setInterval(async () => {
  for (const [userId, count] of weeklyClaims.entries()) {
    if (count < 3) {
      const user = await client.users.fetch(userId).catch(() => null);
      if (user) await sendQuotaApproval(user, "this week");
    }
  }

  for (const [userId, data] of twoWeekClaims.entries()) {
    twoWeekClaims.set(userId, [data[1], 0]);
  }

  weeklyClaims.clear();
}, 7 * 24 * 60 * 60 * 1000);

// -------------------- LOGIN --------------------
client.login(BOT_TOKEN);

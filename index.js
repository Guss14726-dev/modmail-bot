const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  EmbedBuilder,
  PermissionsBitField
} = require("discord.js");

// CONFIG
const BOT_TOKEN = process.env.BOT_TOKEN;
const MODMAIL_CATEGORY_ID = process.env.MODMAIL_CATEGORY_ID;
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const CHAIRMAN_ROLE_NAME = "Group Chairman";
const MANAGER_USER_ID = "1124685735384072213"; // your ID for DM approval

// CLIENT
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.User, Partials.Reaction]
});

// DATA
const tickets = new Map();
const blacklisted = new Set();
const weeklyClaims = new Map(); // userId => tickets claimed this week
const twoWeekClaims = new Map(); // userId => [week1, week2]

// HELPERS
function getFirstImage(message) {
  const a = message.attachments?.first();
  if (!a) return null;
  if (a.contentType?.startsWith("image/") || /\.(png|jpg|jpeg|gif)$/i.test(a.url)) return a.url;
  return null;
}

async function closeTicket(ticket, reason) {
  const user = await client.users.fetch(ticket.userId).catch(() => null);
  const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
  if (user) {
    await user.send({
      embeds: [new EmbedBuilder().setTitle("❌ Ticket Closed").setDescription(reason).setColor(0xFF0000)]
    }).catch(() => {});
  }
  if (channel) await channel.delete().catch(() => {});
  tickets.delete(ticket.userId);
}

async function forwardUserMessage(ticket, msg) {
  const ch = await client.channels.fetch(ticket.channelId).catch(() => null);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setTitle("📩 New Message from User")
    .setColor(0x00AE86)
    .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
    .setDescription(msg.content || "*No text*")
    .setTimestamp();
  const img = getFirstImage(msg);
  if (img) embed.setImage(img);
  await ch.send({ embeds: [embed] });
}

async function forwardStaffMessage(ticket, msg) {
  const user = await client.users.fetch(ticket.userId).catch(() => null);
  if (!user) return;
  const embed = new EmbedBuilder()
    .setTitle("📩 Message from Support Team")
    .setColor(0xFFA500)
    .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
    .setDescription(msg.content || "*No text*")
    .setTimestamp();
  const img = getFirstImage(msg);
  if (img) embed.setImage(img);
  await user.send({ embeds: [embed] }).catch(() => {});
}

// -------------------- QUOTA APPROVAL DM --------------------
async function sendQuotaApproval(user, type) {
  const manager = await client.users.fetch(MANAGER_USER_ID).catch(() => null);
  if (!manager) return;

  const draftEmbed = new EmbedBuilder()
    .setTitle("📌 Ticket Quota Notification (Draft)")
    .setDescription(`Dear User,\n\nYou have not completed your ticket quota ${type}. If you think this is a mistake, DM Gus14726 or reach out for support.`)
    .setColor(0xFFA500)
    .setFooter({ text: "React ✅ to send or ❌ to cancel" })
    .setTimestamp();

  const approvalMessage = await manager.send({ embeds: [draftEmbed] }).catch(() => null);
  if (!approvalMessage) return console.log("Cannot DM manager.");

  await approvalMessage.react("✅");
  await approvalMessage.react("❌");

  const filter = (reaction, userReacting) =>
    ["✅", "❌"].includes(reaction.emoji.name) && userReacting.id === MANAGER_USER_ID;

  const collector = approvalMessage.createReactionCollector({ filter, max: 1, time: 15 * 60 * 1000 });

  collector.on("collect", async (reaction) => {
    if (reaction.emoji.name === "✅") {
      await user.send({ embeds: [draftEmbed] }).catch(() => {});
      await manager.send(`✅ Sent ${type} ticket quota DM to <@${user.id}>`);
    } else {
      await manager.send(`❌ Did NOT send ${type} ticket quota DM to <@${user.id}>`);
    }
  });
}

// -------------------- READY --------------------
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("For Tickets", { type: "Listening" });
  client.user.setStatus("idle");
});

// -------------------- TICKET CREATION --------------------
client.on(Events.InteractionCreate, async i => {
  if (!i.isStringSelectMenu() || i.customId !== "ticket-category") return;
  if (blacklisted.has(i.user.id)) return i.update({ content: "❌ You cannot open tickets.", components: [] });
  const guild = client.guilds.cache.get(MAIN_GUILD_ID);
  if (!guild) return;

  const channel = await guild.channels.create({
    name: `ticket-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, ""),
    type: ChannelType.GuildText,
    parent: MODMAIL_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: STAFF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
    ]
  });

  tickets.set(i.user.id, { userId: i.user.id, channelId: channel.id, lastActivity: Date.now(), claimed: false, claimedBy: null });
  await channel.send({ embeds: [new EmbedBuilder().setTitle("🎫 Ticket Opened").setDescription(`Opened by <@${i.user.id}>`).setColor(0x00AE86)] });
  await i.update({ content: `✅ Ticket created: <#${channel.id}>`, components: [] });
});

// -------------------- MESSAGE HANDLER --------------------
client.on(Events.MessageCreate, async msg => {
  if (!msg.guild || msg.author.bot) return;
  const content = msg.content.toLowerCase();
  const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
  if (!member) return;

  // MANUAL !TICKETQUOTA
  if (content.startsWith("!ticketquota")) {
    if (!member.roles.cache.has(STAFF_ROLE_ID)) return msg.reply("❌ No permission.");
    const args = msg.content.split(" ");
    const userId = args[1]?.replace(/[<@!>]/g, "");
    if (!userId) return msg.reply("Usage: !ticketquota @user");
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return msg.reply("User not found.");
    const embed = new EmbedBuilder()
      .setTitle("📌 Ticket Quota Notification")
      .setDescription("Dear User,\n\nYou have not completed your ticket quota. If you think this is a mistake, DM Gus14726 or reach out for support.")
      .setColor(0xFFA500)
      .setFooter({ text: "Yours sincerely" })
      .setTimestamp();
    await user.send({ embeds: [embed] }).catch(() => {});
    return msg.reply(`✅ Ticket quota notification sent to <@${user.id}>.`);
  }

  // TICKET CHANNEL COMMANDS
  const ticket = [...tickets.values()].find(t => t.channelId === msg.channel.id);
  if (!ticket) return;

  // !claim
  if (content === "!claim") {
    if (ticket.claimed) return msg.reply("Already claimed.");
    ticket.claimed = true;
    ticket.claimedBy = msg.author.id;
    const userClaims = weeklyClaims.get(msg.author.id) || 0;
    weeklyClaims.set(msg.author.id, userClaims + 1);
    const userTwoWeeks = twoWeekClaims.get(msg.author.id) || [0, 0];
    userTwoWeeks[userTwoWeeks.length - 1] += 1;
    twoWeekClaims.set(msg.author.id, userTwoWeeks);
    return msg.reply("✅ Ticket claimed.");
  }

  if (!ticket.claimed) return msg.reply("Claim the ticket first.");

  // !close
  if (content === "!close") { await closeTicket(ticket, "Closed by staff."); return; }

  // !test
  if (content === "!test") { await closeTicket(ticket, "Closed via !test."); return; }

  // Forward staff message
  if (!content.startsWith("!")) { ticket.lastActivity = Date.now(); await forwardStaffMessage(ticket, msg); }
});

// -------------------- AUTO CLOSE --------------------
setInterval(async () => {
  const now = Date.now();
  for (const ticket of tickets.values()) {
    if (now - ticket.lastActivity >= 24 * 60 * 60 * 1000) await closeTicket(ticket, "Closed due to inactivity.");
  }
}, 60 * 60 * 1000);

// -------------------- AUTOMATIC QUOTA CHECK --------------------
setInterval(async () => {
  for (const [userId, weekly] of weeklyClaims.entries()) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    if (weekly < 3) await sendQuotaApproval(user, "this week");
    const twoWeeks = twoWeekClaims.get(userId) || [0, 0];
    if (twoWeeks[0] === 0 && twoWeeks[1] === 0) await sendQuotaApproval(user, "in the last 2 weeks");
  }
  for (const [userId, twoWeeks] of twoWeekClaims.entries()) twoWeekClaims.set(userId, [twoWeeks[1], 0]);
  weeklyClaims.clear();
}, 24 * 60 * 60 * 1000);

// -------------------- LOGIN --------------------
client.login(BOT_TOKEN);

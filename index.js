require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const Database = require("better-sqlite3");
const { createTranscript } = require("discord-html-transcripts");

/* -------------------- CONFIG -------------------- */
const {
  BOT_TOKEN,
  MAIN_GUILD_ID,
  MODMAIL_CATEGORY_ID,
  STAFF_ROLE_ID,
  MANAGER_USER_ID,
  LOG_CHANNEL_ID
} = process.env;

/* -------------------- CLIENT -------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

/* -------------------- DATABASE -------------------- */
const db = new Database("./bot.db");

db.prepare(`
CREATE TABLE IF NOT EXISTS tickets (
  userId TEXT PRIMARY KEY,
  channelId TEXT,
  claimedBy TEXT,
  lastActivity INTEGER
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS claims (
  staffId TEXT,
  week INTEGER
)`).run();

/* -------------------- HELPERS -------------------- */
const log = async (guild, embed) => {
  const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
  if (ch) ch.send({ embeds: [embed] });
};

/* -------------------- READY -------------------- */
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Support Tickets", { type: "LISTENING" });

  const guild = await client.guilds.fetch(MAIN_GUILD_ID);

  await guild.commands.set([
    new SlashCommandBuilder().setName("claim").setDescription("Claim a ticket"),
    new SlashCommandBuilder()
      .setName("close")
      .setDescription("Close ticket")
      .addStringOption(o => o.setName("reason").setRequired(true)),
    new SlashCommandBuilder()
      .setName("quota")
      .setDescription("View staff quota")
      .addUserOption(o => o.setName("user"))
  ]);
});

/* -------------------- TICKET CREATION -------------------- */
client.on(Events.InteractionCreate, async i => {
  if (!i.isStringSelectMenu()) return;
  if (i.customId !== "ticket-category") return;

  const existing = db.prepare(`SELECT * FROM tickets WHERE userId=?`).get(i.user.id);
  if (existing) {
    return i.reply({ content: "❌ You already have an open ticket.", ephemeral: true });
  }

  const guild = client.guilds.cache.get(MAIN_GUILD_ID);
  const channel = await guild.channels.create({
    name: `ticket-${i.user.username}`.toLowerCase(),
    type: ChannelType.GuildText,
    parent: MODMAIL_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: STAFF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
    ]
  });

  db.prepare(`INSERT INTO tickets VALUES (?,?,?,?)`)
    .run(i.user.id, channel.id, null, Date.now());

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("🎫 Ticket Opened")
        .setDescription(`Opened by <@${i.user.id}>`)
        .setColor(0x00AE86)
    ]
  });

  await log(guild, new EmbedBuilder()
    .setTitle("Ticket Opened")
    .setDescription(`<@${i.user.id}> → <#${channel.id}>`)
    .setColor(0x00AE86));

  await i.reply({ content: `✅ Ticket created: <#${channel.id}>`, ephemeral: true });
});

/* -------------------- MESSAGE FORWARDING -------------------- */
client.on(Events.MessageCreate, async msg => {
  if (!msg.guild || msg.author.bot) return;

  const ticket = db.prepare(`SELECT * FROM tickets WHERE channelId=?`).get(msg.channel.id);
  if (!ticket) return;

  const member = await msg.guild.members.fetch(msg.author.id);
  if (!member.roles.cache.has(STAFF_ROLE_ID)) return;

  if (ticket.claimedBy && ticket.claimedBy !== msg.author.id) {
    return msg.reply("❌ Only the claimer may respond.");
  }

  db.prepare(`UPDATE tickets SET lastActivity=? WHERE channelId=?`)
    .run(Date.now(), msg.channel.id);

  const user = await client.users.fetch(ticket.userId);
  await user.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("📩 Support Reply")
        .setDescription(msg.content || "*No text*")
        .setColor(0xFFA500)
    ]
  }).catch(() => {});
});

/* -------------------- SLASH COMMANDS -------------------- */
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;

  const ticket = db.prepare(`SELECT * FROM tickets WHERE channelId=?`).get(i.channel.id);
  const guild = i.guild;

  if (i.commandName === "claim") {
    if (!ticket) return i.reply({ content: "❌ Not a ticket.", ephemeral: true });
    if (ticket.claimedBy) return i.reply({ content: "Already claimed.", ephemeral: true });

    db.prepare(`UPDATE tickets SET claimedBy=? WHERE channelId=?`)
      .run(i.user.id, i.channel.id);

    db.prepare(`INSERT INTO claims VALUES (?,?)`).run(i.user.id, Date.now());

    await log(guild, new EmbedBuilder()
      .setTitle("Ticket Claimed")
      .setDescription(`<@${i.user.id}> → <#${i.channel.id}>`)
      .setColor(0x3498db));

    return i.reply("✅ Ticket claimed.");
  }

  if (i.commandName === "close") {
    if (!ticket) return i.reply({ content: "❌ Not a ticket.", ephemeral: true });

    const transcript = await createTranscript(i.channel);
    const user = await client.users.fetch(ticket.userId);

    await user.send({
      content: "Your ticket has been closed.",
      files: [transcript]
    }).catch(() => {});

    db.prepare(`DELETE FROM tickets WHERE channelId=?`).run(i.channel.id);

    await log(guild, new EmbedBuilder()
      .setTitle("Ticket Closed")
      .setDescription(`<#${i.channel.id}>`)
      .setColor(0xff0000));

    await i.channel.delete();
  }

  if (i.commandName === "quota") {
    const target = i.options.getUser("user") || i.user;
    const count = db.prepare(`SELECT COUNT(*) AS c FROM claims WHERE staffId=?`)
      .get(target.id).c;

    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("📊 Ticket Quota")
          .setDescription(`<@${target.id}> has claimed **${count}** tickets.`)
          .setColor(0x00AE86)
      ],
      ephemeral: true
    });
  }
});

/* -------------------- AUTO CLOSE -------------------- */
setInterval(() => {
  const now = Date.now();
  const tickets = db.prepare(`SELECT * FROM tickets`).all();

  for (const t of tickets) {
    if (now - t.lastActivity > 24 * 60 * 60 * 1000) {
      client.channels.fetch(t.channelId)
        .then(ch => ch.delete())
        .catch(() => {});
      db.prepare(`DELETE FROM tickets WHERE userId=?`).run(t.userId);
    }
  }
}, 60 * 60 * 1000);

/* -------------------- SAFETY -------------------- */
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

/* -------------------- LOGIN -------------------- */
client.login(BOT_TOKEN);

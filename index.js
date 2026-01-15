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
const ONCALL_ROLE_NAME = "On Call";

// CLIENT
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

// DATA
const tickets = new Map();
const blacklisted = new Set();

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await client.user.setActivity("For Tickets", { type: "Listening" });
  await client.user.setStatus("idle");
});

// IMAGE HELPER
function getFirstImage(message) {
  const a = message.attachments?.first();
  if (!a) return null;
  if (a.contentType?.startsWith("image/") || /\.(png|jpg|jpeg|gif)$/i.test(a.url)) {
    return a.url;
  }
  return null;
}

// FORWARD USER → STAFF
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

  let ping = "";
  if (!ticket.notifiedOnCall) {
    const role = ch.guild.roles.cache.find(r => r.name === ONCALL_ROLE_NAME);
    if (role) ping = `<@&${role.id}>`;
    ticket.notifiedOnCall = true;
  }

  await ch.send({ content: ping, embeds: [embed] });
}

// FORWARD STAFF → USER
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

  await user.send({ embeds: [embed] });
}

// DM HANDLING
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot || msg.guild) return;
  if (blacklisted.has(msg.author.id)) return;

  const ticket = tickets.get(msg.author.id);
  if (!ticket) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ticket-category")
      .setPlaceholder("Select a category")
      .addOptions(
        { label: "Product Support", value: "Product Support" },
        { label: "General Support", value: "General Support" },
        { label: "Giveaway Win", value: "Giveaway Win" }
      );

    return msg.channel.send({
      content: "Welcome! Please select a category:",
      components: [new ActionRowBuilder().addComponents(menu)]
    });
  }

  ticket.lastActivity = Date.now();
  await forwardUserMessage(ticket, msg);
});

// TICKET CREATION
client.on(Events.InteractionCreate, async i => {
  if (!i.isStringSelectMenu() || i.customId !== "ticket-category") return;
  if (blacklisted.has(i.user.id))
    return i.update({ content: "❌ You cannot open tickets.", components: [] });

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

  tickets.set(i.user.id, {
    userId: i.user.id,
    channelId: channel.id,
    lastActivity: Date.now(),
    claimed: false,
    claimedBy: null,
    notifiedOnCall: false,
    warningSent: false
  });

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("🎫 Ticket Opened")
        .setDescription(`Opened by <@${i.user.id}>`)
        .setColor(0x00AE86)
    ]
  });

  await i.update({ content: `✅ Ticket created: <#${channel.id}>`, components: [] });
});

// STAFF COMMANDS
client.on(Events.MessageCreate, async msg => {
  if (!msg.guild || msg.author.bot) return;

  const content = msg.content.toLowerCase();
  const member = await msg.guild.members.fetch(msg.author.id);
  const ticket = [...tickets.values()].find(t => t.channelId === msg.channel.id);

  // !cmds (case-insensitive)
  if (content === "!cmds") {
    return msg.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("📜 Commands")
          .setColor(0x00AE86)
          .addFields(
            { name: "General", value: "`!pong`" },
            {
              name: "Staff",
              value: "`!oncall`\n`!offcall`\n`!claim`\n`!close`\n`!b <user>`\n`!un <user>`"
            },
            { name: "Restricted", value: "`!say <text>` (Group Chairman)" }
          )
      ]
    });
  }

  if (content === "!pong") return msg.reply("🏓 Pong!");

  if (!member.roles.cache.has(STAFF_ROLE_ID)) return;
  if (!ticket) return;

  if (content === "!claim") {
    if (ticket.claimed) return msg.reply("❌ Already claimed.");
    ticket.claimed = true;
    ticket.claimedBy = msg.author.id;
    return msg.channel.send("✅ Ticket claimed.");
  }

  if (!ticket.claimed) return msg.reply("⚠️ Claim the ticket first.");

  if (content === "!close") {
    tickets.delete(ticket.userId);
    await msg.channel.delete().catch(() => {});
  }

  if (!content.startsWith("!")) {
    ticket.lastActivity = Date.now();
    await forwardStaffMessage(ticket, msg);
  }
});

// LOGIN
client.login(BOT_TOKEN);

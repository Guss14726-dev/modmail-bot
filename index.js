const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
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
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.User]
});

// DATA
const tickets = new Map();          // userId => ticket
const ticketsByChannel = new Map(); // channelId => ticket
const blacklisted = new Set();

// HELPERS
function isStaff(member) {
  return (
    member.roles.cache.has(STAFF_ROLE_ID) ||
    member.roles.cache.some(r => r.name === CHAIRMAN_ROLE_NAME)
  );
}

function getFirstImage(msg) {
  const a = msg.attachments?.first();
  if (!a) return null;
  if (a.contentType?.startsWith("image/") || /\.(png|jpe?g|gif)$/i.test(a.url))
    return a.url;
  return null;
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
          .setColor(0xff0000)
      ]
    }).catch(() => {});
  }

  if (channel) await channel.delete().catch(() => {});

  tickets.delete(ticket.userId);
  ticketsByChannel.delete(ticket.channelId);
}

async function forwardUserMessage(ticket, msg) {
  const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("📩 Message from User")
    .setAuthor({
      name: msg.author.tag,
      iconURL: msg.author.displayAvatarURL()
    })
    .setDescription(msg.content || "*No text*")
    .setColor(0x00ae86)
    .setTimestamp();

  const img = getFirstImage(msg);
  if (img) embed.setImage(img);

  await channel.send({ embeds: [embed] });
}

async function forwardStaffMessage(ticket, msg) {
  const user = await client.users.fetch(ticket.userId).catch(() => null);
  if (!user) return;

  const embed = new EmbedBuilder()
    .setTitle("📩 Message from Staff")
    .setAuthor({
      name: msg.author.tag,
      iconURL: msg.author.displayAvatarURL()
    })
    .setDescription(msg.content || "*No text*")
    .setColor(0x5865f2)
    .setTimestamp();

  const img = getFirstImage(msg);
  if (img) embed.setImage(img);

  // IMPORTANT: ONLY SEND MESSAGE — DO NOT CLOSE
  await user.send({ embeds: [embed] }).catch(() => {});
}

// READY
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity("For Tickets", { type: "Listening" });
});

// TICKET CREATION
client.on(Events.InteractionCreate, async i => {
  if (!i.isStringSelectMenu() || i.customId !== "ticket-category") return;
  if (blacklisted.has(i.user.id))
    return i.reply({ content: "❌ You cannot open tickets.", ephemeral: true });

  if (tickets.has(i.user.id))
    return i.reply({ content: "❌ You already have an open ticket.", ephemeral: true });

  const guild = await client.guilds.fetch(MAIN_GUILD_ID);

  const channel = await guild.channels.create({
    name: `ticket-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, ""),
    type: ChannelType.GuildText,
    parent: MODMAIL_CATEGORY_ID,
    permissionOverwrites: [
      {
        id: guild.roles.everyone,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: STAFF_ROLE_ID,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages
        ]
      }
    ]
  });

  const ticket = {
    userId: i.user.id,
    channelId: channel.id,
    lastActivity: Date.now()
  };

  tickets.set(i.user.id, ticket);
  ticketsByChannel.set(channel.id, ticket);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("🎫 Ticket Opened")
        .setDescription(`Opened by <@${i.user.id}>`)
        .setColor(0x00ae86)
    ]
  });

  await i.reply({
    content: `✅ Ticket created: <#${channel.id}>`,
    ephemeral: true
  });
});

// MESSAGE HANDLER
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;

  // USER DMs → STAFF
  if (!msg.guild) {
    const ticket = tickets.get(msg.author.id);
    if (!ticket) return;
    ticket.lastActivity = Date.now();
    return forwardUserMessage(ticket, msg);
  }

  // STAFF → USER
  const ticket = ticketsByChannel.get(msg.channel.id);
  if (!ticket) return;

  const member = await msg.guild.members.fetch(msg.author.id);
  if (!isStaff(member)) return;

  const content = msg.content.toLowerCase();

  if (content === "!close") {
    return closeTicket(ticket, "Closed by staff.");
  }

  if (!content.startsWith("!")) {
    ticket.lastActivity = Date.now();
    return forwardStaffMessage(ticket, msg);
  }
});

// AUTO CLOSE (24H ONLY)
setInterval(() => {
  const now = Date.now();
  for (const ticket of tickets.values()) {
    if (now - ticket.lastActivity >= 24 * 60 * 60 * 1000) {
      closeTicket(ticket, "Closed due to inactivity.");
    }
  }
}, 60 * 60 * 1000);

// LOGIN
client.login(BOT_TOKEN);

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
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID; // Main staff role
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

// IN-MEMORY DATA
const tickets = new Map();
const blacklisted = new Set();

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    // Set professional bot status
    await client.user.setActivity('For Tickets', { type: 'Listening' });
    await client.user.setStatus('idle');
    console.log('✅ Bot status set successfully');
  } catch (err) {
    console.error('❌ Failed to set bot status:', err);
  }

  console.log(`Current open tickets: ${tickets.size}`);
});

// Helper to safely get image
function getFirstImage(message) {
  if (!message.attachments) return null;
  const attachment = message.attachments.first();
  if (!attachment) return null;
  if (attachment.contentType?.startsWith("image/") || attachment.url.endsWith(".png") || attachment.url.endsWith(".jpg") || attachment.url.endsWith(".jpeg") || attachment.url.endsWith(".gif")) {
    return attachment.url;
  }
  return null;
}

// Forward user DM to staff
async function forwardUserMessage(ticket, userMessage) {
  const staffChannel = await client.channels.fetch(ticket.channelId).catch(() => null);
  if (!staffChannel) return;

  const embed = new EmbedBuilder()
    .setTitle("📩 New Message from User")
    .setColor(0x00AE86)
    .setAuthor({ name: userMessage.author.tag, iconURL: userMessage.author.displayAvatarURL() })
    .setDescription(userMessage.content || "*No text content*")
    .setTimestamp();

  const imageUrl = getFirstImage(userMessage);
  if (imageUrl) embed.setImage(imageUrl);

  let contentPing = "";
  if (!ticket.notifiedOnCall) {
    const onCallRole = staffChannel.guild.roles.cache.find(r => r.name === ONCALL_ROLE_NAME);
    if (onCallRole) contentPing = `<@&${onCallRole.id}>`;
    ticket.notifiedOnCall = true;
  }

  await staffChannel.send({ content: contentPing, embeds: [embed] });
}

// Forward staff message to user
async function forwardStaffMessage(ticket, staffMessage) {
  const user = await client.users.fetch(ticket.userId).catch(() => null);
  if (!user) return;

  const embed = new EmbedBuilder()
    .setTitle("📩 Message from Support Team")
    .setColor(0xFFA500)
    .setAuthor({ name: staffMessage.author.tag, iconURL: staffMessage.author.displayAvatarURL() })
    .setDescription(staffMessage.content || "*No text content*")
    .setTimestamp();

  const imageUrl = getFirstImage(staffMessage);
  if (imageUrl) embed.setImage(imageUrl);

  await user.send({ content: `<@${user.id}>`, embeds: [embed] });
}

// DM Handling
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || message.guild) return;

  if (blacklisted.has(message.author.id)) return;

  const ticket = tickets.get(message.author.id);
  if (!ticket) {
    const categories = new StringSelectMenuBuilder()
      .setCustomId("ticket-category")
      .setPlaceholder("Select a category")
      .addOptions([
        { label: "Product Support", value: "Product Support" },
        { label: "General Support", value: "General Support" },
        { label: "Giveaway Win", value: "Giveaway Win" }
      ]);
    const row = new ActionRowBuilder().addComponents(categories);

    return message.channel.send({
      content: "Welcome! Please select a category for your ticket:",
      components: [row]
    });
  }

  if (ticket.confirmed) {
    ticket.lastActivity = Date.now();
    await forwardUserMessage(ticket, message);
  }
});

// Ticket creation
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isStringSelectMenu() || interaction.customId !== "ticket-category") return;

  if (blacklisted.has(interaction.user.id)) {
    return interaction.update({ content: "❌ You are not allowed to open tickets.", components: [] });
  }

  const category = interaction.values[0];
  const guild = client.guilds.cache.get(MAIN_GUILD_ID);
  if (!guild) return interaction.update({ content: "Could not find main server.", components: [] });

  const channel = await guild.channels.create({
    name: `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, ""),
    type: ChannelType.GuildText,
    parent: MODMAIL_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: STAFF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
    ]
  });

  tickets.set(interaction.user.id, {
    userId: interaction.user.id,
    category,
    confirmed: true,
    channelId: channel.id,
    lastActivity: Date.now(),
    claimed: false,
    claimedBy: null,
    notifiedOnCall: false,
    warningSent: false
  });

  const ticketEmbed = new EmbedBuilder()
    .setTitle("🎫 Ticket Opened")
    .setDescription(`New ticket created by <@${interaction.user.id}>`)
    .setColor(0x00AE86)
    .addFields(
      { name: "User", value: interaction.user.tag, inline: true },
      { name: "User ID", value: interaction.user.id, inline: true },
      { name: "Category", value: category, inline: true },
      { name: "Opened At", value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true }
    )
    .setTimestamp();

  const onCallRole = guild.roles.cache.find(r => r.name === ONCALL_ROLE_NAME);
  await channel.send({ content: onCallRole ? `<@&${onCallRole.id}>` : "", embeds: [ticketEmbed] });
  tickets.get(interaction.user.id).notifiedOnCall = true;

  await interaction.update({ content: `✅ Your ticket has been created: <#${channel.id}>`, components: [] });
});

// Staff commands & forwarding
client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  const ticket = [...tickets.values()].find(t => t.channelId === message.channel.id);
  const content = message.content.toLowerCase();

  if (content === "!pong") return message.reply("🏓 Pong!");

  // On Call toggle
  if (member.roles.cache.has(STAFF_ROLE_ID)) {
    if (content === "!oncall") {
      let role = message.guild.roles.cache.find(r => r.name === ONCALL_ROLE_NAME);
      if (!role) role = await message.guild.roles.create({ name: ONCALL_ROLE_NAME, color: 0x00AE86 });
      if (!member.roles.cache.has(role.id)) await member.roles.add(role);
      return message.reply("✅ You are now On Call.");
    }
    if (content === "!offcall") {
      const role = message.guild.roles.cache.find(r => r.name === ONCALL_ROLE_NAME);
      if (role && member.roles.cache.has(role.id)) await member.roles.remove(role);
      return message.reply("✅ You are no longer On Call.");
    }
  }

  // Blacklist
  if (member.roles.cache.has(STAFF_ROLE_ID)) {
    if (content.startsWith("!b ")) {
      const userId = content.split(" ")[1].replace(/[<@!>]/g,"");
      blacklisted.add(userId);
      return message.reply(`✅ <@${userId}> is blacklisted.`);
    }
    if (content.startsWith("!un ")) {
      const userId = content.split(" ")[1].replace(/[<@!>]/g,"");
      blacklisted.delete(userId);
      return message.reply(`✅ <@${userId}> removed from blacklist.`);
    }
  }

  if (!ticket) return;
  ticket.lastActivity = Date.now();

  // Claim
  if (content === "!claim") {
    if (ticket.claimed) return message.reply(`❌ Already claimed by <@${ticket.claimedBy}>`);
    ticket.claimed = true;
    ticket.claimedBy = message.author.id;
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("✅ Ticket Claimed").setDescription(`Claimed by ${message.author.tag}`).setColor(0x00AE86)] });
  }

  if (!ticket.claimed) return message.reply("⚠️ Please claim the ticket first with !claim.");

  // Forward staff message
  if (!content.startsWith("!")) await forwardStaffMessage(ticket, message);

  // Close
  if (content === "!close") {
    const user = await client.users.fetch(ticket.userId).catch(() => null);
    if (user) await user.send({ embeds: [new EmbedBuilder().setTitle("❌ Ticket Closed").setDescription("Closed by support team.").setColor(0xFF0000)] });
    tickets.delete(ticket.userId);
    await message.channel.delete().catch(() => null);
  }

  // Say (Group Chairman)
  if (content.startsWith("!say ")) {
    const role = message.guild.roles.cache.find(r => r.name === "Group Chairman");
    if (!role || !member.roles.cache.has(role.id)) return message.reply("❌ No permission.");
    const text = message.content.slice(5).trim();
    if (!text) return message.reply("⚠️ Provide text.");
    await message.channel.send({ embeds: [new EmbedBuilder().setDescription(text).setColor(0x00AE86).setFooter({ text: message.author.tag, iconURL: message.author.displayAvatarURL() }).setTimestamp()] });
  }
});

// Inactivity
setInterval(async () => {
  const now = Date.now();
  for (const [userId, ticket] of tickets) {
    const inactive = now - ticket.lastActivity;
    if (!ticket.warningSent && inactive >= 18*60*60*1000) {
      ticket.warningSent = true;
      const user = await client.users.fetch(ticket.userId).catch(() => null);
      if (user) user.send(`⚠️ Dear <@${user.id}>, 6 hours from now your ticket will close if inactive.`);
    }
    if (inactive >= 24*60*60*1000) {
      const user = await client.users.fetch(ticket.userId).catch(()=>null);
      const channel = await client.channels.fetch(ticket.channelId).catch(()=>null);
      if (user) user.send({ embeds:[new EmbedBuilder().setTitle("❌ Ticket Closed").setDescription("Closed due to 24h inactivity.").setColor(0xFF0000)] });
      if (channel) await channel.delete().catch(()=>null);
      tickets.delete(userId);
    }
  }
}, 60*60*1000);

client.login(BOT_TOKEN);


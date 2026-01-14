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
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageAttachments
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

// IN-MEMORY DATA
const tickets = new Map();
const blacklisted = new Set();

client.once(Events.ClientReady, () => console.log(`Logged in as ${client.user.tag}`));

// ---------- Helper Functions ----------
async function forwardUserMessage(ticket, userMessage) {
  const staffChannel = await client.channels.fetch(ticket.channelId).catch(() => null);
  if (!staffChannel) return;

  const embed = new EmbedBuilder()
    .setTitle("📩 New Message from User")
    .setColor(0x00AE86)
    .setAuthor({ name: userMessage.author.tag, iconURL: userMessage.author.displayAvatarURL() })
    .setDescription(userMessage.content || "*No text content*")
    .setTimestamp();

  // Include first attachment if exists
  if (userMessage.attachments.size > 0) {
    const firstAttachment = userMessage.attachments.first();
    if (firstAttachment.contentType?.startsWith("image/")) {
      embed.setImage(firstAttachment.url);
    }
  }

  let contentPing = "";
  if (!ticket.notifiedOnCall) {
    const onCallRole = staffChannel.guild.roles.cache.find(r => r.name === ONCALL_ROLE_NAME);
    if (onCallRole) contentPing = `<@&${onCallRole.id}>`;
    ticket.notifiedOnCall = true;
  }

  await staffChannel.send({ content: contentPing, embeds: [embed] });
}

async function forwardStaffMessage(ticket, staffMessage) {
  const user = await client.users.fetch(ticket.userId).catch(() => null);
  if (!user) return;

  const embed = new EmbedBuilder()
    .setTitle("📩 Message from Support Team")
    .setColor(0xFFA500)
    .setAuthor({ name: staffMessage.author.tag, iconURL: staffMessage.author.displayAvatarURL() })
    .setDescription(staffMessage.content || "*No text content*")
    .setTimestamp();

  if (staffMessage.attachments.size > 0) {
    const firstAttachment = staffMessage.attachments.first();
    if (firstAttachment.contentType?.startsWith("image/")) {
      embed.setImage(firstAttachment.url);
    }
  }

  await user.send({ content: `<@${user.id}>`, embeds: [embed] });
}

// ---------- DM Handling ----------
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || message.guild) return;

  if (blacklisted.has(message.author.id)) return;

  let ticket = tickets.get(message.author.id);
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

// ---------- Category Selection / Ticket Creation ----------
client.on(Events.InteractionCreate, async interaction => {
  try {
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
      warningSent: false,
      claimed: false,
      claimedBy: null,
      notifiedOnCall: false
    });

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    const rolesText = member
      ? member.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).join(", ") || "N/A"
      : "N/A";

    const ticketEmbed = new EmbedBuilder()
      .setTitle(`🎫 Ticket Opened`)
      .setDescription(`New ticket created by <@${interaction.user.id}>`)
      .setColor(0x00AE86)
      .addFields(
        { name: "User", value: interaction.user.tag, inline: true },
        { name: "User ID", value: interaction.user.id, inline: true },
        { name: "Roles", value: rolesText, inline: false },
        { name: "Category", value: category, inline: true },
        { name: "Opened At", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
      )
      .setTimestamp();

    const onCallRole = guild.roles.cache.find(r => r.name === ONCALL_ROLE_NAME);
    await channel.send({ content: onCallRole ? `<@&${onCallRole.id}>` : "", embeds: [ticketEmbed] });
    tickets.get(interaction.user.id).notifiedOnCall = true;

    await interaction.update({
      content: `✅ Your ticket for **${category}** has been created! Staff will assist you shortly: <#${channel.id}>`,
      components: []
    });

  } catch (err) {
    console.error(err);
    if (!interaction.replied) interaction.reply({ content: "❌ Something went wrong.", ephemeral: true });
  }
});

// ---------- Staff Commands ----------
client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  const ticket = [...tickets.values()].find(t => t.channelId === message.channel.id);
  const content = message.content.toLowerCase();

  if (content === "!pong") return message.reply("🏓 Pong!");

  // ---------- On Call ----------
  if (member.roles.cache.has(STAFF_ROLE_ID)) {
    if (content === "!oncall") {
      let role = message.guild.roles.cache.find(r => r.name === ONCALL_ROLE_NAME);
      if (!role) role = await message.guild.roles.create({ name: ONCALL_ROLE_NAME, color: 0x00AE86, reason: "On-call role" });
      if (member.roles.cache.has(role.id)) return message.reply("You are already On Call.");
      await member.roles.add(role);
      return message.reply("✅ You are now On Call!");
    }
    if (content === "!offcall") {
      const role = message.guild.roles.cache.find(r => r.name === ONCALL_ROLE_NAME);
      if (!role || !member.roles.cache.has(role.id)) return message.reply("You are not currently On Call.");
      await member.roles.remove(role);
      return message.reply("✅ You are no longer On Call.");
    }
  }

  // ---------- Blacklist / Un-blacklist ----------
  if (member.roles.cache.has(STAFF_ROLE_ID)) {
    if (content.startsWith("!b ")) {
      const userId = content.split(" ")[1].replace(/[<@!>]/g, "");
      if (!userId) return message.reply("❌ Please provide a user ID or mention.");
      blacklisted.add(userId);
      return message.reply(`✅ <@${userId}> has been blacklisted from opening tickets.`);
    }
    if (content.startsWith("!un ")) {
      const userId = content.split(" ")[1].replace(/[<@!>]/g, "");
      if (!userId) return message.reply("❌ Please provide a user ID or mention.");
      if (!blacklisted.has(userId)) return message.reply("⚠️ This user is not blacklisted.");
      blacklisted.delete(userId);
      return message.reply(`✅ <@${userId}> has been removed from the blacklist and can now open tickets.`);
    }
  }

  if (!ticket) return;
  ticket.lastActivity = Date.now();

  // ---------- Ticket Claim ----------
  if (content === "!claim") {
    if (ticket.claimed) return message.reply(`❌ This ticket is already claimed by <@${ticket.claimedBy}>.`);
    ticket.claimed = true;
    ticket.claimedBy = message.author.id;
    const embed = new EmbedBuilder()
      .setTitle("✅ Ticket Claimed")
      .setColor(0x00AE86)
      .setDescription(`This ticket has been claimed by ${message.author.tag}. You can now reply to the user.`);
    await message.channel.send({ embeds: [embed] });
    return;
  }

  if (!ticket.claimed) return message.reply("⚠️ You have not claimed this ticket yet. Please run `!claim`.");

  // ---------- Forward Staff Message ----------
  if (!content.startsWith("!")) await forwardStaffMessage(ticket, message);

  // ---------- Close Ticket ----------
  if (content === "!close") {
    if (!member.roles.cache.has(STAFF_ROLE_ID)) return message.reply("❌ You do not have permission to close this ticket.");
    const user = await client.users.fetch(ticket.userId).catch(() => null);
    if (user) {
      const closeEmbed = new EmbedBuilder()
        .setTitle("❌ Ticket Closed")
        .setColor(0xFF0000)
        .setDescription("Your ticket has been closed by the support team. Thank you!");
      await user.send({ embeds: [closeEmbed] });
    }
    tickets.delete(ticket.userId);
    await message.channel.delete().catch(() => null);
  }

  // ---------- Say Command for Group Chairman ----------
  if (content.startsWith("!say ")) {
    const chairmanRole = message.guild.roles.cache.find(r => r.name === "Group Chairman");
    if (!chairmanRole || !member.roles.cache.has(chairmanRole.id)) {
      return message.reply("❌ You do not have permission to use this command.");
    }

    const sayText = message.content.slice(5).trim();
    if (!sayText) return message.reply("⚠️ Please provide text to say.");

    const embed = new EmbedBuilder()
      .setColor(0x00AE86)
      .setDescription(sayText)
      .setFooter({ text: `Sent by ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
      .setTimestamp();

    return message.channel.send({ embeds: [embed] });
  }
});

// ---------- Inactivity Check ----------
setInterval(async () => {
  const now = Date.now();
  for (const [userId, ticket] of tickets) {
    const inactiveTime = now - ticket.lastActivity;

    if (!ticket.warningSent && inactiveTime >= 18 * 60 * 60 * 1000) {
      ticket.warningSent = true;
      const user = await client.users.fetch(ticket.userId).catch(() => null);
      if (user) user.send(`⚠️ Dear <@${user.id}>, 6 hours from now your ticket will automatically close if no response is received.`);
    }

    if (inactiveTime >= 24 * 60 * 60 * 1000) {
      const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
      const user = await client.users.fetch(ticket.userId).catch(() => null);

      if (user) {
        const embed = new EmbedBuilder()
          .setTitle("❌ Ticket Closed")
          .setColor(0xFF0000)
          .setDescription("Your ticket has been closed due to 24 hours of inactivity.");
        await user.send({ embeds: [embed] });
      }

      if (channel) await channel.send("Ticket closed automatically due to inactivity.").catch(() => null);
      if (channel) await channel.delete().catch(() => null);
      tickets.delete(userId);
    }
  }
}, 60 * 60 * 1000);

// ---------- Login ----------
client.login(BOT_TOKEN);

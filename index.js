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
const MODMAIL_CATEGORY_ID = process.env.MODMAIL_CATEGORY_ID; // Ticket category
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;           // Log channel
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID;            // Main server
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;            // Staff role from env

// Create client
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

// In-memory ticket store
const tickets = new Map();

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Handle DMs from users
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || message.guild) return;

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

  // Forward user messages to staff as embed
  if (ticket.confirmed) {
    ticket.lastActivity = Date.now();
    const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle("📩 New Message from User")
      .setDescription(message.content || "*No text content*")
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setColor(0x00AE86)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  }
});

// Handle ticket category selection
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.isStringSelectMenu() || interaction.customId !== "ticket-category") return;

    const selected = interaction.values[0];
    const guild = client.guilds.cache.get(MAIN_GUILD_ID);
    if (!guild) return interaction.update({ content: "Could not find main server.", components: [] });

    // Create ticket channel with permissions
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
      category: selected,
      confirmed: true,
      channelId: channel.id,
      lastActivity: Date.now(),
      warningSent: false
    });

    // Fetch member info
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    const rolesText = member
      ? member.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).join(", ") || "N/A"
      : "N/A";

    // Initial embed in ticket channel for staff
    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`🎫 Ticket Opened by ${interaction.user.tag}`)
      .setDescription(`A new ticket has been opened.`)
      .addFields(
        { name: "User ID", value: interaction.user.id, inline: true },
        { name: "Roles", value: rolesText, inline: true },
        { name: "Opened At", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
      )
      .setColor(0x00AE86)
      .setTimestamp();
    await channel.send({ embeds: [welcomeEmbed] });

    // Log ticket creation with @here ping
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    const logEmbed = new EmbedBuilder()
      .setTitle("📩 New Ticket Created")
      .addFields(
        { name: "User", value: interaction.user.tag, inline: true },
        { name: "User ID", value: interaction.user.id, inline: true },
        { name: "Roles", value: rolesText },
        { name: "Category", value: selected }
      )
      .setColor(0x00AE86)
      .setTimestamp();
    await logChannel.send({ content: "@here", embeds: [logEmbed] });

    await interaction.update({
      content: `Your ticket for **${selected}** has been created! Staff will assist you shortly: <#${channel.id}>`,
      components: []
    });

  } catch (error) {
    console.error("Interaction error:", error);
    if (interaction.replied || interaction.deferred) {
      interaction.followUp({ content: `Something went wrong: ${error.message}`, ephemeral: true }).catch(() => {});
    } else {
      interaction.reply({ content: `Something went wrong: ${error.message}`, ephemeral: true }).catch(() => {});
    }
  }
});

// Handle staff messages
client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;

  const ticket = [...tickets.values()].find(t => t.channelId === message.channel.id);
  if (!ticket) return;

  ticket.lastActivity = Date.now();

  // Forward staff messages to user as embed
  if (!message.content.startsWith("!") && ticket) {
    const user = await client.users.fetch(ticket.userId).catch(() => null);
    if (!user) return;
    const staffEmbed = new EmbedBuilder()
      .setTitle("📩 Message from Staff")
      .setDescription(message.content || "*No text content*")
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setColor(0xFFA500)
      .setTimestamp();
    await user.send({ embeds: [staffEmbed] });
  }

  const content = message.content.toLowerCase();

  // Claim ticket
  if (content === "!claim") {
    const embed = new EmbedBuilder()
      .setTitle("✅ Ticket Claimed")
      .setDescription("You have successfully connected with our support team.\n\nPlease provide a clear explanation of your issue.\n\n**Thank you!**")
      .setColor(0x00AE86);
    await message.channel.send({ embeds: [embed] });
  }

  // Close ticket - only staff with role
  if (content === "!close") {
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member || !member.roles.cache.has(STAFF_ROLE_ID)) {
      return message.reply("You do not have permission to close this ticket.");
    }

    const user = await client.users.fetch(ticket.userId).catch(() => null);
    if (user) await user.send("Your ticket has been closed. Thank you!");

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    logChannel.send(`❌ Ticket closed by ${message.author.tag} | Channel: ${message.channel.name}`);

    tickets.delete(ticket.userId);
    await message.channel.delete().catch(() => null);
  }
});

// Periodic inactivity check
setInterval(async () => {
  const now = Date.now();
  for (const [userId, ticket] of tickets) {
    const inactiveTime = now - ticket.lastActivity;

    if (!ticket.warningSent && inactiveTime >= 18 * 60 * 60 * 1000) {
      ticket.warningSent = true;
      const user = await client.users.fetch(ticket.userId).catch(() => null);
      if (user) user.send(`Dear <@${user.id}>,\n\n6 hours from now your ticket will be automatically closed if no action is taken. Please respond to keep it open.`);
    }

    if (inactiveTime >= 24 * 60 * 60 * 1000) {
      const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
      const user = await client.users.fetch(ticket.userId).catch(() => null);

      if (user) await user.send("Your ticket has been closed due to inactivity. Thank you!");
      if (channel) await channel.send("Ticket closed automatically due to 24 hours of inactivity.").catch(() => null);
      if (channel) await channel.delete().catch(() => null);

      tickets.delete(userId);
    }
  }
}, 60 * 60 * 1000);

client.login(BOT_TOKEN);

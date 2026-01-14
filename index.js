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

// ---------- Helper Functions ----------

// Forward DM from user to staff as embed
async function forwardUserMessage(ticket, userMessage) {
  const staffChannel = await client.channels.fetch(ticket.channelId).catch(() => null);
  if (!staffChannel) return;

  const embed = new EmbedBuilder()
    .setTitle("📩 New Message from User")
    .setColor(0x00AE86)
    .setAuthor({ name: userMessage.author.tag, iconURL: userMessage.author.displayAvatarURL() })
    .setDescription(userMessage.content || "*No text content*")
    .setTimestamp();

  await staffChannel.send({ embeds: [embed] });
}

// Forward staff message to user as embed
async function forwardStaffMessage(ticket, staffMessage) {
  const user = await client.users.fetch(ticket.userId).catch(() => null);
  if (!user) return;

  const embed = new EmbedBuilder()
    .setTitle("📩 Message from Support Team")
    .setColor(0xFFA500)
    .setAuthor({ name: staffMessage.author.tag, iconURL: staffMessage.author.displayAvatarURL() })
    .setDescription(staffMessage.content || "*No text content*")
    .setTimestamp();

  await user.send({ embeds: [embed] });
}

// ---------- DM Handling ----------

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

  if (ticket.confirmed) {
    ticket.lastActivity = Date.now();
    await forwardUserMessage(ticket, message);
  }
});

// ---------- Category Selection / Ticket Creation ----------

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.isStringSelectMenu() || interaction.customId !== "ticket-category") return;

    const category = interaction.values[0];
    const guild = client.guilds.cache.get(MAIN_GUILD_ID);
    if (!guild) return interaction.update({ content: "Could not find main server.", components: [] });

    // Create ticket channel
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
      claimed: false // staff must claim before interacting
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
    await channel.send({ embeds: [ticketEmbed] });

    await interaction.update({
      content: `✅ Your ticket for **${category}** has been created! Staff will assist you shortly: <#${channel.id}>`,
      components: []
    });

  } catch (err) {
    console.error(err);
    if (!interaction.replied) interaction.reply({ content: "❌ Something went wrong.", ephemeral: true });
  }
});

// ---------- Staff & Ticket Commands ----------

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  const ticket = [...tickets.values()].find(t => t.channelId === message.channel.id);

  const content = message.content.toLowerCase();

  // ---------- On Call Commands (Staff Only) ----------
  if (member.roles.cache.has(STAFF_ROLE_ID)) {
    if (content === "!oncall") {
      let role = message.guild.roles.cache.find(r => r.name === "On Call");
      if (!role) {
        role = await message.guild.roles.create({ name: "On Call", color: 0x00AE86, reason: "On-call role" });
      }
      if (member.roles.cache.has(role.id)) return message.reply("You are already On Call.");
      await member.roles.add(role);
      return message.reply("✅ You are now On Call!");
    }

    if (content === "!offcall") {
      const role = message.guild.roles.cache.find(r => r.name === "On Call");
      if (!role || !member.roles.cache.has(role.id)) return message.reply("You are not currently On Call.");
      await member.roles.remove(role);
      return message.reply("✅ You are no longer On Call.");
    }
  }

  if (!ticket) return;

  ticket.lastActivity = Date.now();

  // ---------- Staff Interaction Check ----------
  if (!ticket.claimed && !content.startsWith("!claim")) {
    return message.reply("⚠️ You have not claimed this ticket yet. Please run `!claim`.");
  }

  // ---------- Forward Staff Message ----------
  if (!content.startsWith("!")) await forwardStaffMessage(ticket, message);

  // ---------- Claim Ticket ----------
  if (content === "!claim") {
    ticket.claimed = true;
    const embed = new EmbedBuilder()
      .setTitle("✅ Ticket Claimed")
      .setColor(0x00AE86)
      .setDescription(`This ticket has been claimed by ${message.author.tag}. You can now reply to the user.`);
    await message.channel.send({ embeds: [embed] });
  }

  // ---------- Close Ticket ----------
  if (content === "!close") {
    if (!member.roles.cache.has(STAFF_ROLE_ID))
      return message.reply("❌ You do not have permission to close this ticket.");

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
}, 60 * 60 * 1000); // every hour

// ---------- Login ----------
client.login(BOT_TOKEN);

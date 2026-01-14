const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder
} = require("discord.js");

// CONFIG
const BOT_TOKEN = process.env.BOT_TOKEN;
const MODMAIL_CHANNEL_ID = process.env.MODMAIL_CHANNEL_ID; // Staff-only channel
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;         // Log channel
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID;           // Your main server ID

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
  if (message.author.bot) return;
  if (message.guild) return; // Only handle DMs

  let ticket = tickets.get(message.author.id);

  // Start ticket creation
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

  // Forward DM if ticket is confirmed
  if (ticket.confirmed) {
    ticket.lastActivity = Date.now(); // update last activity
    const thread = await client.channels.fetch(ticket.threadId).catch(() => null);
    if (!thread) return;
    await thread.send({ content: `**${message.author.tag}:** ${message.content}` });
  }
});

// Handle select menu
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId === "ticket-category") {
      const selected = interaction.values[0];

      // Create ticket immediately
      const channel = await client.channels.fetch(MODMAIL_CHANNEL_ID);
      const thread = await channel.threads.create({
        name: `Ticket - ${interaction.user.username}`,
        type: ChannelType.PrivateThread,
        parent: MODMAIL_CHANNEL_ID
      });

      tickets.set(interaction.user.id, {
        userId: interaction.user.id,
        category: selected,
        confirmed: true,
        threadId: thread.id,
        lastActivity: Date.now(),
        warningSent: false
      });

      // Fetch guild member info
      const mainGuild = client.guilds.cache.get(MAIN_GUILD_ID);
      let memberData = null;
      if (mainGuild) {
        const member = await mainGuild.members.fetch(interaction.user.id).catch(() => null);
        if (member) {
          memberData = {
            id: member.id,
            username: member.user.tag,
            roles: member.roles.cache
              .filter(role => role.id !== mainGuild.id)
              .map(r => r.name)
          };
        }
      }

      // Log ticket creation with @here ping
      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
      const logEmbed = new EmbedBuilder()
        .setTitle("📩 New Ticket Created")
        .addFields(
          { name: "User", value: interaction.user.tag, inline: true },
          { name: "User ID", value: interaction.user.id, inline: true },
          { name: "Roles", value: memberData?.roles.join(", ") || "N/A" },
          { name: "Category", value: selected }
        )
        .setColor(0x00AE86)
        .setTimestamp();

      await logChannel.send({ content: "@here", embeds: [logEmbed] });

      // Confirm to user
      await interaction.update({
        content: `Your ticket for **${selected}** has been created! Staff will assist you shortly.`,
        components: []
      });
    }
  } catch (error) {
    console.error("Interaction error:", error);
    if (interaction.replied || interaction.deferred) {
      interaction.followUp({ content: "Something went wrong. Please try again.", ephemeral: true }).catch(() => {});
    } else {
      interaction.reply({ content: "Something went wrong. Please try again.", ephemeral: true }).catch(() => {});
    }
  }
});

// Handle staff messages in threads
client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;

  const ticket = [...tickets.values()].find(t => t.threadId === message.channel.id);
  if (!ticket) return;

  // Update last activity
  ticket.lastActivity = Date.now();

  // Forward staff messages to user
  if (!message.content.startsWith("!")) {
    const user = await client.users.fetch(ticket.userId).catch(() => null);
    if (user) await user.send(`**Staff:** ${message.content}`);
  }

  const content = message.content.toLowerCase();

  // Claim ticket
  if (content === "!claim") {
    const embed = new EmbedBuilder()
      .setTitle("✅ Ticket Claimed")
      .setDescription(
        "You have successfully connected with our support team.\n\n" +
        "Please provide a clear explanation of your issue so we can assist you efficiently.\n\n" +
        "**Thank you!**"
      )
      .setColor(0x00AE86);
    await message.channel.send({ embeds: [embed] });

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    logChannel.send(`✅ Ticket claimed by ${message.author.tag} | Thread: ${message.channel.name}`);
  }

  // Close ticket
  if (content === "!close") {
    const user = await client.users.fetch(ticket.userId).catch(() => null);
    if (user) await user.send("Your ticket has been closed. Thank you!");

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    logChannel.send(`❌ Ticket closed by ${message.author.tag} | Thread: ${message.channel.name}`);

    tickets.delete(ticket.userId);
    await message.channel.delete().catch(() => null);
  }
});

// Periodic check for inactivity
setInterval(async () => {
  const now = Date.now();
  for (const [userId, ticket] of tickets) {
    const inactiveTime = now - ticket.lastActivity;

    // 6-hour warning (after 18 hours)
    if (!ticket.warningSent && inactiveTime >= 18 * 60 * 60 * 1000) {
      ticket.warningSent = true;
      const user = await client.users.fetch(ticket.userId).catch(() => null);
      if (user) {
        user.send(`Dear <@${user.id}>,\n\n6 hours from now your ticket will be automatically closed if no action is taken. If you would like to keep it open, please respond.`);
      }
    }

    // Close after 24 hours
    if (inactiveTime >= 24 * 60 * 60 * 1000) {
      const thread = await client.channels.fetch(ticket.threadId).catch(() => null);
      const user = await client.users.fetch(ticket.userId).catch(() => null);

      if (user) await user.send("Your ticket has been closed due to inactivity. Thank you!");
      if (thread) await thread.send("Ticket closed automatically due to 24 hours of inactivity.").catch(() => null);
      if (thread) await thread.delete().catch(() => null);

      tickets.delete(userId);
    }
  }
}, 60 * 60 * 1000); // every hour

client.login(BOT_TOKEN);

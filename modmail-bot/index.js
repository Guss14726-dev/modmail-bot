const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// CONFIG
const MODMAIL_CHANNEL_ID = process.env.MODMAIL_CHANNEL_ID; // Staff-only channel
const MODMAIL_CATEGORY_ID = "1459850628976214221";         // Category for threads
const LOG_CHANNEL_ID = "1459850629513084990";              // Logs

// In-memory tickets: { userId, threadId, category, confirmed }
const tickets = new Map();

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Handle user DMs
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  if (!message.guild) {
    const ticket = tickets.get(message.author.id);

    if (!ticket) {
      // Start ticket creation: category select menu
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

    // If ticket exists and confirmed, forward DM to thread
    if (ticket.confirmed) {
      const thread = await client.channels.fetch(ticket.threadId).catch(() => null);
      if (!thread) return;
      await thread.send(`**${message.author.tag}:** ${message.content}`);
    }
  }
});

// Handle interactions (select menu & buttons)
client.on(Events.InteractionCreate, async interaction => {
  // Select menu for category
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "ticket-category") {
      const selected = interaction.values[0];
      tickets.set(interaction.user.id, { userId: interaction.user.id, category: selected, confirmed: false });

      const yesButton = new ButtonBuilder().setCustomId("confirm-yes").setLabel("Yes").setStyle(ButtonStyle.Success);
      const noButton = new ButtonBuilder().setCustomId("confirm-no").setLabel("No").setStyle(ButtonStyle.Danger);
      const row = new ActionRowBuilder().addComponents(yesButton, noButton);

      await interaction.update({ content: `You selected **${selected}**. Are you sure you want to open this ticket?`, components: [row] });
    }
  }

  // Buttons Yes/No
  if (interaction.isButton()) {
    const ticket = tickets.get(interaction.user.id);
    if (!ticket) return;

    if (interaction.customId === "confirm-no") {
      tickets.delete(interaction.user.id);
      await interaction.update({ content: "Ticket creation canceled.", components: [] });
      return;
    }

    if (interaction.customId === "confirm-yes") {
      ticket.confirmed = true;

      // Create thread in staff channel
      const channel = await client.channels.fetch(MODMAIL_CHANNEL_ID);
      const thread = await channel.threads.create({
        name: `Ticket - ${interaction.user.username}`,
        type: ChannelType.PrivateThread,
        parent: MODMAIL_CATEGORY_ID
      });
      ticket.threadId = thread.id;

      // Log ticket creation
      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
      logChannel.send(`📩 Ticket created by ${interaction.user.tag} | Category: ${ticket.category} | Thread: ${thread.name}`);

      await interaction.update({ content: `Your ticket has been created! Staff will assist you shortly.`, components: [] });

      return;
    }
  }
});

// Handle staff commands and forwarding messages
client.on(Events.MessageCreate, async message => {
  if (!message.guild) return;
  if (message.author.bot) return;

  // Check if message is inside a ModMail thread
  const ticket = [...tickets.values()].find(t => t.threadId === message.channel.id);
  if (!ticket) return;

  // Forward user messages
  if (!message.content.startsWith("!")) {
    const user = await client.users.fetch(ticket.userId);
    await user.send(`**Staff:** ${message.content}`);
  }

  // Commands
  const content = message.content.toLowerCase();

  // !claim
  if (content === "!claim") {
    const embed = new EmbedBuilder()
      .setTitle("**Thanks for contacting our team!**")
      .setDescription(
        "Thank you for contacting the VaultTech Support Team. We are pleased to inform you that you have been successfully connected with one of our support representatives, who is ready to assist you.\n\n" +
        "To ensure we can assist you with your inquiry as quickly as possible, we kindly ask that you provide a clear explanation of the reason for opening your ticket. This will help us better understand your needs and provide the support you require without delay.\n\n" +
        "**Best regards,**\n*VaultTech Support Team*"
      )
      .setColor(0x00AE86);

    await message.channel.send({ embeds: [embed] });

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    logChannel.send(`✅ Ticket claimed by ${message.author.tag} | Thread: ${message.channel.name}`);
  }

  // !close
  if (content === "!close") {
    const user = await client.users.fetch(ticket.userId).catch(() => null);
    if (user) await user.send("Your ticket has been closed. Thank you!");

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    logChannel.send(`❌ Ticket closed by ${message.author.tag} | Thread: ${message.channel.name}`);

    tickets.delete(ticket.userId);
    await message.channel.delete();
  }
});

client.login(process.env.BOT_TOKEN);

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  TextChannel,
  ChannelType,
  GuildMember
} from "discord.js";

/* ================= CONFIG ================= */
const LOG_CHANNEL_ID = "1463227300312256636";
const MODMAIL_CATEGORY_ID = "1463204751574437939";
const WELCOME_CHANNEL_NAME = "welcome";
const SUSPICIOUS_AGE_DAYS = 7;

/* ================= SAFETY HANDLERS ================= */
process.on("unhandledRejection", err => console.error("Unhandled promise rejection:", err));
process.on("uncaughtException", err => console.error("Uncaught exception:", err));

/* ================= SLASH COMMANDS ================= */
const commands = [
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Send a message")
    .addStringOption(o => o.setName("message").setRequired(true))
    .addChannelOption(o => o.setName("channel").setRequired(true))
    .addBooleanOption(o => o.setName("embed")),

  new SlashCommandBuilder()
    .setName("flight")
    .setDescription("Flight announcement")
    .addStringOption(o => o.setName("flight_number").setRequired(true))
    .addStringOption(o => o.setName("destination").setRequired(true))
    .addUserOption(o => o.setName("host").setRequired(true))
    .addChannelOption(o => o.setName("channel").setRequired(true)),

  new SlashCommandBuilder()
    .setName("fake_ban")
    .setDescription("Fake ban")
    .addUserOption(o => o.setName("user").setRequired(true)),

  new SlashCommandBuilder()
    .setName("test_welcome")
    .setDescription("Test welcome"),

  new SlashCommandBuilder()
    .setName("suspicious_test")
    .setDescription("Suspicious accounts")
    .addSubcommand(s => s.setName("user").addUserOption(o => o.setName("target").setRequired(true)))
    .addSubcommand(s => s.setName("all")),

  new SlashCommandBuilder()
    .setName("dm")
    .setDescription("DM a user via the bot")
    .addUserOption(o => o.setName("user").setRequired(true))
    .addStringOption(o => o.setName("message").setRequired(true))
].map(c => c.toJSON());

/* ================= BOT ================= */
export async function setupDiscordBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Message, Partials.Channel]
  });

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const tickets = new Map<string, string>();

  /* ================= LOG UTIL ================= */
  async function sendLog(embed: EmbedBuilder, pingHere = false) {
    try {
      const guild = await client.guilds.fetch(process.env.GUILD_ID!);
      const channel = await guild.channels.fetch(LOG_CHANNEL_ID) as TextChannel;
      if (!channel || !channel.isTextBased()) return;
      await channel.send({ content: pingHere ? "@here" : undefined, embeds: [embed] });
    } catch (err) { console.error("sendLog error:", err); }
  }

  /* ================= JOIN + SUSPICIOUS ================= */
  async function handleJoin(member: GuildMember) {
    try {
      const age = (Date.now() - member.user.createdTimestamp) / 86400000;
      const suspicious = age < SUSPICIOUS_AGE_DAYS;

      const embed = new EmbedBuilder()
        .setTitle("Member Joined")
        .setColor(suspicious ? 0xff9900 : 0x2ecc71)
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: "User", value: `${member.user.tag} (<@${member.id}>)` },
          { name: "Account Age", value: `${age.toFixed(1)} days` }
        )
        .setTimestamp();

      await sendLog(embed, suspicious);

      const welcome = member.guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.name === WELCOME_CHANNEL_NAME
      ) as TextChannel | undefined;

      if (welcome) await welcome.send(`Welcome <@${member.id}> 👋`);
    } catch (err) { console.error("handleJoin error:", err); }
  }

  client.on("guildMemberAdd", handleJoin);

  /* ================= MESSAGE DELETE ================= */
  client.on("messageDelete", async msg => {
    try {
      if (msg.partial) {
        try { msg = await msg.fetch(); } catch (err) { return; }
      }
      if (!msg.author) return;

      const embed = new EmbedBuilder()
        .setTitle("Message Deleted")
        .setColor(0xff9900)
        .setDescription(
          `**Author:** ${msg.author.tag}\n**Channel:** ${msg.channel}\n**Content:** ${msg.content || "[No text]"}`
        )
        .setTimestamp();

      if (msg.attachments.size)
        embed.addFields({ name: "Attachments", value: msg.attachments.map(a => a.url).join("\n") });

      await sendLog(embed);
    } catch (err) { console.error("messageDelete error:", err); }
  });

  /* ================= ROLE LOGS ================= */
  client.on("guildMemberUpdate", async (oldM, newM) => {
    try {
      for (const r of newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id))) {
        await sendLog(new EmbedBuilder()
          .setTitle("Role Added")
          .setDescription(`${r.name} → ${newM.user.tag}`)
          .setColor(0x2ecc71));
      }
      for (const r of oldM.roles.cache.filter(r => !newM.roles.cache.has(r.id))) {
        await sendLog(new EmbedBuilder()
          .setTitle("Role Removed")
          .setDescription(`${r.name} ← ${newM.user.tag}`)
          .setColor(0xe74c3c));
      }
    } catch (err) { console.error("guildMemberUpdate error:", err); }
  });

  /* ================= MODMAIL + STAFF DM ================= */
  client.on("messageCreate", async msg => {
    if (msg.author.bot) return;

    try {
      // USER DM → STAFF
      if (msg.channel.type === ChannelType.DM) {
        let channelId = tickets.get(msg.author.id);

        const guild = await client.guilds.fetch(process.env.GUILD_ID!);
        const category = await guild.channels.fetch(MODMAIL_CATEGORY_ID);
        if (!category || category.type !== ChannelType.GuildCategory) return;

        if (!channelId) {
          const channel = await guild.channels.create({
            name: `modmail-${msg.author.username}`,
            type: ChannelType.GuildText,
            parent: category.id
          });
          tickets.set(msg.author.id, channel.id);
          await channel.send({ content: "@here", embeds: [new EmbedBuilder().setTitle("New ModMail").setDescription(`User: ${msg.author.tag}`)] });
          await msg.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription("✅ Successfully connected to our Support team")] });
          channelId = channel.id;
        }

        const staffChannel = await client.channels.fetch(channelId) as TextChannel;
        if (!staffChannel) return;

        const sent = await staffChannel.send({ content: `**User:** ${msg.author.tag}`, files: [...msg.attachments.values()] });
        await sent.react("✅");
        return;
      }

      // STAFF → USER
      if (msg.channel.parentId === MODMAIL_CATEGORY_ID) {
        const userId = [...tickets.entries()].find(e => e[1] === msg.channel.id)?.[0];
        if (!userId) return;

        if (msg.content.startsWith("!close")) {
          tickets.delete(userId);
          await msg.channel.delete();
          return;
        }

        if (msg.content.startsWith("!r") || msg.content.startsWith("!R")) {
          const reply = msg.content.slice(2).trim();
          try {
            const user = await client.users.fetch(userId);
            const sent = await user.send({ content: reply, files: [...msg.attachments.values()] });
            await sent.react("✅");
            await msg.react("✅");
            await sendLog(new EmbedBuilder().setTitle("ModMail Reply Sent")
              .setDescription(`**To:** ${user.tag}\n**By:** ${msg.author.tag}\n**Message:** ${reply}`)
              .setColor(0x3498db));
          } catch {
            await msg.reply("❌ Could not deliver message (DMs closed).");
          }
        }
      }
    } catch (err) { console.error("modmail messageCreate error:", err); }
  });

  /* ================= SLASH COMMAND HANDLER ================= */
  client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand()) return;

    try {
      // DM command
      if (i.commandName === "dm") {
        if (!i.memberPermissions?.has(PermissionFlagsBits.ManageMessages))
          return i.reply({ content: "No permission.", ephemeral: true });

        const user = i.options.getUser("user", true);
        const message = i.options.getString("message", true);

        try {
          const dm = await user.send({ embeds: [new EmbedBuilder().setTitle("📩 Message from Staff").setDescription(message)] });
          await dm.react("✅");
          await sendLog(new EmbedBuilder().setTitle("DM Sent")
            .setDescription(`**To:** ${user.tag}\n**By:** ${i.user.tag}\n**Message:** ${message}`)
            .setColor(0x3498db));
          await i.reply({ content: "DM sent.", ephemeral: true });
        } catch {
          await i.reply({ content: "❌ Could not DM user (DMs may be closed).", ephemeral: true });
        }
      }

      // Suspicious test
      if (i.commandName === "suspicious_test") {
        await i.deferReply({ ephemeral: true });
        const sub = i.options.getSubcommand(false);
        if (!sub) return i.editReply("Invalid subcommand.");

        if (sub === "user") {
          const user = i.options.getUser("target", true);
          const member = await i.guild!.members.fetch(user.id);
          await handleJoin(member);
          return i.editReply("User checked.");
        }

        if (sub === "all") {
          const members = await i.guild!.members.fetch();
          for (const m of members.values()) {
            const age = (Date.now() - m.user.createdTimestamp) / 86400000;
            if (age < SUSPICIOUS_AGE_DAYS) await handleJoin(m);
          }
          return i.editReply("All members checked.");
        }
      }
    } catch (err) { console.error("interactionCreate error:", err); }
  });

  /* ================= READY ================= */
  client.once("ready", async () => {
    try {
      await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), { body: commands });
      console.log(`Logged in as ${client.user?.tag}`);
    } catch (err) { console.error("Command registration error:", err); }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

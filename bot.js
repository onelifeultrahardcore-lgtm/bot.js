const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require("discord.js")
const { createClient } = require("@supabase/supabase-js")

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
})

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// IDs
const GUILD_ID = "1477770296818925744"
const SERVER_CHAT_ID = "1507458566624247839"
const TRADE_LEDGER_ID = "1486001869481443441"
const LOG_CHANNEL_ID = "1508141267224100995"
const ROLE_HONORABLE = "1485996258350076005"
const ROLE_DISHONORABLE = "1485995794761781433"
const ROLE_ALIVE = "1508162809307857019"
const ROLE_DEAD = "1508162872012832778"

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("rep")
    .setDescription("Give a scam report to a user")
    .addSubcommand(sub =>
      sub.setName("scam")
        .setDescription("Report a scam (admin only)")
        .addUserOption(opt =>
          opt.setName("user")
            .setDescription("The Discord user to report")
            .setRequired(true)
        )
    )
].map(cmd => cmd.toJSON())

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN)

async function registerCommands() {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, GUILD_ID),
      { body: commands }
    )
    console.log("✅ Slash commands registered")
  } catch (err) {
    console.error("Failed to register commands:", err)
  }
}

// Helper: get minecraft username from discord id
async function getMinecraftUsername(discordId) {
  const { data } = await supabase
    .from("verification_logs")
    .select("minecraft_username")
    .eq("discord_id", discordId)
    .order("verified_at", { ascending: false })
    .limit(1)
    .single()
  return data?.minecraft_username || null
}

// Helper: get discord id from minecraft username
async function getDiscordId(minecraftUsername) {
  const { data } = await supabase
    .from("verification_logs")
    .select("discord_id, discord_username")
    .ilike("minecraft_username", minecraftUsername)
    .order("verified_at", { ascending: false })
    .limit(1)
    .single()
  return data || null
}

// Helper: send log embed
async function sendLog(title, color, fields) {
  const channel = await client.channels.fetch(LOG_CHANNEL_ID)
  if (!channel) return
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(fields)
    .setTimestamp()
  await channel.send({ embeds: [embed] })
}

// Helper: assign/remove roles
async function updateRoles(member, addRoles = [], removeRoles = []) {
  for (const roleId of addRoles) {
    await member.roles.add(roleId).catch(() => {})
  }
  for (const roleId of removeRoles) {
    await member.roles.remove(roleId).catch(() => {})
  }
}

// Handle reputation updates
async function updateReputation(discordId, type) {
  const column = type === "scam" ? "scam_points" : "rep_points"

  // Upsert player rep
  const { data: existing } = await supabase
    .from("player_reputation")
    .select("*")
    .eq("discord_id", discordId)
    .single()

  let newPoints = 1
  if (existing) {
    newPoints = (existing[column] || 0) + 1
    await supabase
      .from("player_reputation")
      .update({ [column]: newPoints })
      .eq("discord_id", discordId)
  } else {
    await supabase
      .from("player_reputation")
      .insert({ discord_id: discordId, [column]: 1 })
  }

  const guild = await client.guilds.fetch(GUILD_ID)
  const member = await guild.members.fetch(discordId).catch(() => null)
  if (!member) return newPoints

  if (type === "scam" && newPoints >= 5) {
    await updateRoles(member, [ROLE_DISHONORABLE], [ROLE_HONORABLE])
    await supabase
      .from("player_reputation")
      .update({ status: "dishonorable" })
      .eq("discord_id", discordId)
    await sendLog("🔴 Player Dishonored", 0xff0000, [
      { name: "Discord", value: `<@${discordId}>`, inline: true },
      { name: "Scam Points", value: `${newPoints}`, inline: true },
    ])
  }

  if (type === "rep" && newPoints >= 10) {
    await updateRoles(member, [ROLE_HONORABLE], [ROLE_DISHONORABLE])
    await supabase
      .from("player_reputation")
      .update({ status: "honorable" })
      .eq("discord_id", discordId)
    await sendLog("🟢 Player Honored", 0x00ff00, [
      { name: "Discord", value: `<@${discordId}>`, inline: true },
      { name: "Rep Points", value: `${newPoints}`, inline: true },
    ])
  }

  return newPoints
}

client.once("ready", async () => {
  console.log(`✅ ${client.user.tag} is online!`)
  client.user.setPresence({
    status: "online",
    activities: [{ name: "Trading Post | onelifeuhc.org", type: 3 }]
  })
  await registerCommands()
})

client.on("messageCreate", async (message) => {
  if (message.author.bot && message.channelId !== SERVER_CHAT_ID && message.channelId !== TRADE_LEDGER_ID) return

  // ---- DEATH TRACKING ----
  if (message.channelId === SERVER_CHAT_ID) {
    const deathMatch = message.content.match(/^(.+?) Has Been Sent To The After Life!$/)
    if (deathMatch) {
      const minecraftUsername = deathMatch[1].trim()
      const userData = await getDiscordId(minecraftUsername)

      if (userData) {
        const guild = await client.guilds.fetch(GUILD_ID)
        const member = await guild.members.fetch(userData.discord_id).catch(() => null)

        if (member) {
          await updateRoles(member, [ROLE_DEAD], [ROLE_ALIVE])
          await supabase
            .from("verification_logs")
            .update({ is_dead: true })
            .eq("discord_id", userData.discord_id)

          await sendLog("💀 Player Died", 0x888888, [
            { name: "Minecraft Username", value: minecraftUsername, inline: true },
            { name: "Discord", value: `<@${userData.discord_id}>`, inline: true },
          ])
        }
      } else {
        // Not verified — log it anyway
        await sendLog("💀 Unverified Player Died", 0x444444, [
          { name: "Minecraft Username", value: minecraftUsername, inline: true },
          { name: "Discord", value: "Not verified", inline: true },
        ])
      }
    }
  }

  // ---- TRADE LEDGER ----
  if (message.channelId === TRADE_LEDGER_ID) {
    const content = message.content

    const isFairTrade =
      content.toLowerCase().includes("fair trade") &&
      content.includes("Your Username") || content.includes("your username")

    if (isFairTrade) {
      // Parse usernames from the message
      const lines = content.split("\n").map(l => l.trim())

      let yourUsername = null
      let theirUsername = null

      for (const line of lines) {
        const lower = line.toLowerCase()
        if (lower.includes("your username")) {
          yourUsername = line.split(":").slice(1).join(":").replace(/[•\-]/g, "").trim()
        }
        if (lower.includes("their username")) {
          theirUsername = line.split(":").slice(1).join(":").replace(/[•\-]/g, "").trim()
        }
      }

      if (yourUsername && theirUsername) {
        const user1 = await getDiscordId(yourUsername)
        const user2 = await getDiscordId(theirUsername)

        if (user1) await updateReputation(user1.discord_id, "rep")
        if (user2) await updateReputation(user2.discord_id, "rep")

        await sendLog("🤝 Fair Trade Logged", 0x00aaff, [
          { name: "Player 1", value: yourUsername, inline: true },
          { name: "Player 2", value: theirUsername, inline: true },
          { name: "Rep Added", value: "+1 to each verified player", inline: false },
        ])
      }
    }
  }
})

// ---- SLASH COMMANDS ----
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return

  if (interaction.commandName === "rep" && interaction.options.getSubcommand() === "scam") {
    // Admin only
    if (!interaction.member.permissions.has("ManageRoles")) {
      return interaction.reply({ content: "❌ You don't have permission to use this command.", ephemeral: true })
    }

    const target = interaction.options.getUser("user")
    const newPoints = await updateReputation(target.id, "scam")
    const minecraftUsername = await getMinecraftUsername(target.id)

    await sendLog("⚠️ Scam Report Filed", 0xff6600, [
      { name: "Reported User", value: `<@${target.id}>`, inline: true },
      { name: "Minecraft Username", value: minecraftUsername || "Unknown", inline: true },
      { name: "Total Scam Points", value: `${newPoints}/5`, inline: true },
      { name: "Reported By", value: `<@${interaction.user.id}>`, inline: false },
    ])

    await interaction.reply({
      content: `⚠️ Scam report filed against <@${target.id}>. They now have **${newPoints}/5** scam points.${newPoints >= 5 ? " They have been marked **Dishonorable**." : ""}`,
      ephemeral: true
    })
  }
})

client.login(process.env.DISCORD_BOT_TOKEN)

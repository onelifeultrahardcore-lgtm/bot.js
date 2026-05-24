const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, PermissionFlagsBits } = require("discord.js")
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

const GUILD_ID = "1477770296818925744"
const SERVER_CHAT_ID = "1507458566624247839"
const TRADE_LEDGER_ID = "1486001869481443441"
const LOG_CHANNEL_ID = "1508141267224100995"
const ROLE_HONORABLE = "1485996258350076005"
const ROLE_DISHONORABLE = "1485995794761781433"
const ROLE_ALIVE = "1508162809307857019"
const ROLE_DEAD = "1508162872012832778"

const commands = [
  new SlashCommandBuilder()
    .setName("rep")
    .setDescription("Manage player reputation")
    .addSubcommand(sub =>
      sub.setName("scam")
        .setDescription("Report a scam (admin only)")
        .addUserOption(opt =>
          opt.setName("user")
            .setDescription("The Discord user to report")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName("add")
        .setDescription("Add a rep point to a user (admin only)")
        .addUserOption(opt =>
          opt.setName("user")
            .setDescription("The Discord user to give rep to")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName("clear")
        .setDescription("Clear all reputation points for a user (admin only)")
        .addUserOption(opt =>
          opt.setName("user")
            .setDescription("The Discord user to clear")
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

async function updateRoles(member, addRoles = [], removeRoles = []) {
  for (const roleId of addRoles) {
    await member.roles.add(roleId).catch(console.error)
  }
  for (const roleId of removeRoles) {
    await member.roles.remove(roleId).catch(console.error)
  }
}

async function updateReputation(discordId, type) {
  const column = type === "scam" ? "scam_points" : "rep_points"
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
    await supabase.from("player_reputation").update({ status: "dishonorable" }).eq("discord_id", discordId)
    await sendLog("🔴 Player Dishonored", 0xff0000, [
      { name: "Discord", value: `<@${discordId}>`, inline: true },
      { name: "Scam Points", value: `${newPoints}`, inline: true },
    ])
  }

  if (type === "rep" && newPoints >= 10) {
    await updateRoles(member, [ROLE_HONORABLE], [ROLE_DISHONORABLE])
    await supabase.from("player_reputation").update({ status: "honorable" }).eq("discord_id", discordId)
    await sendLog("🟢 Player Honored", 0x00ff00, [
      { name: "Discord", value: `<@${discordId}>`, inline: true },
      { name: "Rep Points", value: `${newPoints}`, inline: true },
    ])
  }

  return newPoints
}

async function syncExistingMembers() {
  console.log("🔄 Syncing existing member roles...")
  const guild = await client.guilds.fetch(GUILD_ID)
  await guild.members.fetch()

  const { data: verifiedUsers } = await supabase
    .from("verification_logs")
    .select("discord_id, minecraft_username")

  if (!verifiedUsers || verifiedUsers.length === 0) {
    console.log("No verified users to sync.")
    return
  }

  for (const user of verifiedUsers) {
    const member = guild.members.cache.get(user.discord_id)
    if (!member) continue

    const hasHonorable = member.roles.cache.has(ROLE_HONORABLE)
    const hasDishonorable = member.roles.cache.has(ROLE_DISHONORABLE)
    const hasAlive = member.roles.cache.has(ROLE_ALIVE)
    const hasDead = member.roles.cache.has(ROLE_DEAD)

    if (hasHonorable || hasDishonorable) {
      const status = hasHonorable ? "honorable" : "dishonorable"
      await supabase
        .from("player_reputation")
        .upsert({ discord_id: user.discord_id, status })
        .eq("discord_id", user.discord_id)
    }

    if (hasAlive || hasDead) {
      await supabase
        .from("verification_logs")
        .update({ is_alive: hasAlive, is_dead: hasDead })
        .eq("discord_id", user.discord_id)
    }
  }

  console.log(`✅ Synced ${verifiedUsers.length} verified members`)
}

client.once("ready", async () => {
  console.log(`✅ ${client.user.tag} is online!`)
  client.user.setPresence({
    status: "online",
    activities: [{ name: "Trading Post | onelifeuhc.org", type: 3 }]
  })
  await registerCommands()
  await syncExistingMembers()
})

client.on("messageCreate", async (message) => {
  if (message.author.bot) return

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
            .update({ is_dead: true, is_alive: false })
            .eq("discord_id", userData.discord_id)
          await sendLog("💀 Player Died", 0x888888, [
            { name: "Minecraft Username", value: minecraftUsername, inline: true },
            { name: "Discord", value: `<@${userData.discord_id}>`, inline: true },
          ])
        }
      } else {
        await sendLog("💀 Unverified Player Died", 0x444444, [
          { name: "Minecraft Username", value: minecraftUsername, inline: true },
          { name: "Discord", value: "Not verified", inline: true },
        ])
      }
    }
  }

  // ---- TRADE LEDGER ----
  if (message.channelId === TRADE_LEDGER_ID) {
    const lines = message.content.split("\n").map(l => l.trim()).filter(l => l.length > 0)

    // Must have exactly 3 lines
    if (lines.length === 3) {
      const yourUsername = lines[0]
      const theirUsername = lines[1]
      const whatTraded = lines[2]

      const user1 = await getDiscordId(yourUsername)
      const user2 = await getDiscordId(theirUsername)

      // Both players must be verified
      if (!user1 || !user2) {
        await message.delete().catch(() => {})
        await sendLog("❌ Invalid Trade Log", 0xff0000, [
          { name: "Posted By", value: `<@${message.author.id}>`, inline: true },
          { name: "Line 1 (Your Username)", value: yourUsername, inline: true },
          { name: "Line 2 (Their Username)", value: theirUsername, inline: true },
          { name: "Line 3 (What Traded)", value: whatTraded, inline: true },
          { name: "Reason", value: !user1 && !user2 ? "Neither player is verified" : !user1 ? "Your username not found" : "Their username not found", inline: false },
        ])
        await message.channel.send(
          `<@${message.author.id}> ❌ Your trade log was removed — one or both usernames are not verified. Make sure both players have linked their Discord at https://onelifeuhc.org/#honor`
        ).then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
        return
      }

      // Prevent self trading
      if (user1.discord_id === user2.discord_id) {
        await message.delete().catch(() => {})
        await sendLog("❌ Invalid Trade Log — Self Trade", 0xff0000, [
          { name: "Posted By", value: `<@${message.author.id}>`, inline: true },
          { name: "Reason", value: "Cannot trade with yourself", inline: false },
        ])
        await message.channel.send(
          `<@${message.author.id}> ❌ Your trade log was removed — you cannot log a trade with yourself.`
        ).then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
        return
      }

      // Line 1 must be the person posting
      if (user1.discord_id !== message.author.id) {
        await message.delete().catch(() => {})
        await sendLog("❌ Invalid Trade Log — Wrong Author", 0xff0000, [
          { name: "Posted By", value: `<@${message.author.id}>`, inline: true },
          { name: "Claimed Username", value: yourUsername, inline: true },
          { name: "Reason", value: "Line 1 must be YOUR Minecraft username", inline: false },
        ])
        await message.channel.send(
          `<@${message.author.id}> ❌ Your trade log was removed — the first line must be YOUR Minecraft username.`
        ).then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
        return
      }

      // Valid trade — process rep
      for (const userData of [user1, user2]) {
        const { data: rep } = await supabase
          .from("player_reputation")
          .select("*")
          .eq("discord_id", userData.discord_id)
          .single()

        if (rep?.status === "dishonorable" && rep.scam_points > 0) {
          const newScamPoints = rep.scam_points - 1
          const newStatus = newScamPoints < 5 ? "neutral" : "dishonorable"
          await supabase
            .from("player_reputation")
            .update({ scam_points: newScamPoints, status: newStatus })
            .eq("discord_id", userData.discord_id)

          if (newStatus === "neutral") {
            const guild = await client.guilds.fetch(GUILD_ID)
            const member = await guild.members.fetch(userData.discord_id).catch(() => null)
            if (member) await updateRoles(member, [], [ROLE_DISHONORABLE])
          }

          await sendLog("📉 Scam Point Removed (Fair Trade)", 0xffaa00, [
            { name: "Player", value: `<@${userData.discord_id}>`, inline: true },
            { name: "New Scam Points", value: `${newScamPoints}/5`, inline: true },
            { name: "Status", value: newStatus, inline: true },
          ])
        } else {
          await updateReputation(userData.discord_id, "rep")
        }
      }

      await sendLog("🤝 Fair Trade Logged", 0x00aaff, [
        { name: "Player 1", value: `${yourUsername} (<@${user1.discord_id}>)`, inline: true },
        { name: "Player 2", value: `${theirUsername} (<@${user2.discord_id}>)`, inline: true },
        { name: "What Was Traded", value: whatTraded, inline: false },
      ])

    } else {
      // Wrong format
      await message.delete().catch(() => {})
      await message.channel.send(
        `<@${message.author.id}> ❌ Incorrect trade format! Use exactly 3 lines:\n\`\`\`YourMinecraftUsername\nTheirMinecraftUsername\nWhat you traded\`\`\``
      ).then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
    }
  }
})

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return

  if (interaction.commandName === "rep") {
    if (!interaction.member.permissions.has("ManageRoles")) {
      return interaction.reply({ content: "❌ You don't have permission to use this command.", ephemeral: true })
    }

    const subcommand = interaction.options.getSubcommand()
    const target = interaction.options.getUser("user")
    const minecraftUsername = await getMinecraftUsername(target.id)

    // /rep scam
    if (subcommand === "scam") {
      const newPoints = await updateReputation(target.id, "scam")
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

    // /rep add
    if (subcommand === "add") {
      const newPoints = await updateReputation(target.id, "rep")
      await sendLog("➕ Rep Point Added", 0x00ff99, [
        { name: "User", value: `<@${target.id}>`, inline: true },
        { name: "Minecraft Username", value: minecraftUsername || "Unknown", inline: true },
        { name: "Total Rep Points", value: `${newPoints}/10`, inline: true },
        { name: "Added By", value: `<@${interaction.user.id}>`, inline: false },
      ])
      await interaction.reply({
        content: `➕ Rep point added to <@${target.id}>. They now have **${newPoints}/10** rep points.${newPoints >= 10 ? " They have been marked **Honorable**!" : ""}`,
        ephemeral: true
      })
    }

    // /rep clear
    if (subcommand === "clear") {
      await supabase
        .from("player_reputation")
        .update({ rep_points: 0, scam_points: 0, status: "neutral" })
        .eq("discord_id", target.id)

      const guild = await client.guilds.fetch(GUILD_ID)
      const member = await guild.members.fetch(target.id).catch(() => null)
      if (member) {
        await updateRoles(member, [], [ROLE_HONORABLE, ROLE_DISHONORABLE])
      }

      await sendLog("🔄 Reputation Cleared", 0xaaaaaa, [
        { name: "User", value: `<@${target.id}>`, inline: true },
        { name: "Minecraft Username", value: minecraftUsername || "Unknown", inline: true },
        { name: "Cleared By", value: `<@${interaction.user.id}>`, inline: false },
      ])
      await interaction.reply({
        content: `🔄 Reputation cleared for <@${target.id}>. They are now **Neutral**.`,
        ephemeral: true
      })
    }
  }
})

client.login(process.env.DISCORD_BOT_TOKEN)

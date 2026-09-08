const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js')
const questions = require('./questions')

const TOKEN = process.env.TOKEN
const CLIENT_ID = process.env.CLIENT_ID
const GUILD_ID = process.env.GUILD_ID
const QUIZ_CHANNEL_ID = process.env.QUIZ_CHANNEL_ID
const SCORES_CHANNEL_ID = process.env.SCORES_CHANNEL_ID

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
})

let quizRunning = false
const hasParticipated = new Set()
let globalScores = {}
let scoresMessageId = null

async function loadScores() {
  try {
    const channel = await client.channels.fetch(SCORES_CHANNEL_ID)
    const messages = await channel.messages.fetch({ limit: 10 })
    const scoresMsg = messages.find(m => m.author.id === client.user.id && m.content.startsWith('SCORES:'))
    if (scoresMsg) {
      globalScores = JSON.parse(scoresMsg.content.replace('SCORES:', ''))
      scoresMessageId = scoresMsg.id
      console.log('Scores chargés')
    }
  } catch (e) {
    console.log('Pas de scores existants:', e.message)
  }
}

async function saveScores() {
  try {
    const channel = await client.channels.fetch(SCORES_CHANNEL_ID)
    const content = 'SCORES:' + JSON.stringify(globalScores)
    if (scoresMessageId) {
      const msg = await channel.messages.fetch(scoresMessageId)
      await msg.edit(content)
    } else {
      const msg = await channel.send(content)
      scoresMessageId = msg.id
    }
  } catch (e) {
    console.error('Erreur sauvegarde scores:', e.message)
  }
}

async function sendQuizToMember(interaction) {
  const userId = interaction.user.id
  const username = interaction.user.username

  if (!globalScores[userId]) {
    globalScores[userId] = { username, score: 0, correct: 0, wrong: 0, quizzesPlayed: 0 }
  }

  let quizScore = 0
  let correct = 0
  let wrong = 0

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`q${i}_A_${userId}`).setLabel('A').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`q${i}_B_${userId}`).setLabel('B').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`q${i}_C_${userId}`).setLabel('C').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`q${i}_D_${userId}`).setLabel('D').setStyle(ButtonStyle.Primary),
    )

    await interaction.followUp({
      embeds: [new EmbedBuilder()
        .setTitle(`🧠 Question ${i + 1} / ${questions.length}`)
        .setDescription(q.question + '\n\n' + q.choices.join('\n'))
        .setColor('#3498DB')
        .setFooter({ text: '⏱️ 15 secondes pour répondre !' })],
      components: [row],
      ephemeral: true
    })

    const startTime = Date.now()
    let feedback = ''

    await new Promise(resolve => {
      const filter = i2 => i2.customId.startsWith(`q${i}_`) && i2.customId.endsWith(`_${userId}`) && i2.user.id === userId
      const collector = interaction.channel.createMessageComponentCollector({ filter, time: 15000, max: 1 })

      collector.on('collect', async i2 => {
        const choice = i2.customId.split('_')[1]
        const speed = Math.max(0, Math.round((15000 - (Date.now() - startTime)) / 1000))

        if (choice === q.answer) {
          const pts = 10 + speed
          quizScore += pts
          correct++
          feedback = `✅ Bonne réponse ! +${pts} pts (dont +${speed} pts rapidité)`
        } else {
          wrong++
          feedback = `❌ Mauvaise réponse ! La bonne réponse était ${q.answer} : ${q.choices.find(c => c.startsWith(q.answer))}`
        }

        await i2.deferUpdate()
        collector.stop()
      })

      collector.on('end', async collected => {
        if (collected.size === 0) {
          wrong++
          feedback = `⏱️ Temps écoulé ! La bonne réponse était ${q.answer} : ${q.choices.find(c => c.startsWith(q.answer))}`
        }
        await interaction.followUp({ content: feedback, ephemeral: true })
        setTimeout(resolve, 2000)
      })
    })
  }

  globalScores[userId].score += quizScore
  globalScores[userId].correct += correct
  globalScores[userId].wrong += wrong
  globalScores[userId].quizzesPlayed += 1
  globalScores[userId].username = username
  await saveScores()

  await interaction.followUp({
    embeds: [new EmbedBuilder()
      .setTitle('🏁 Quiz terminé !')
      .setDescription(`Score de ce quiz : **${quizScore} pts**\n✅ Bonnes réponses : ${correct}\n❌ Mauvaises réponses : ${wrong}\n\nMerci pour ta participation !`)
      .setColor('#3498DB')],
    ephemeral: true
  })
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('quiz')
      .setDescription('Lance le quiz rentrée étudiante'),
    new SlashCommandBuilder()
      .setName('classement')
      .setDescription('Affiche le classement général'),
    new SlashCommandBuilder()
      .setName('endquiz')
      .setDescription('Arrête le quiz en cours (admin)'),
  ].map(c => c.toJSON())

  const rest = new REST({ version: '10' }).setToken(TOKEN)
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
  console.log('Commandes enregistrées')
}

client.on('ready', async () => {
  console.log(`Bot connecté : ${client.user.tag}`)
  await registerCommands()
  await loadScores()
})

client.on('interactionCreate', async interaction => {

  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'quiz') {
      if (quizRunning) {
        return interaction.reply({ content: '⚠️ Un quiz est déjà en cours ! Utilise /endquiz pour l\'arrêter.', ephemeral: true })
      }

      quizRunning = true
      hasParticipated.clear()

      const channel = await client.channels.fetch(QUIZ_CHANNEL_ID)

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('start_quiz')
          .setLabel('🧠 Commencer le quiz')
          .setStyle(ButtonStyle.Primary)
      )

      await channel.send({
        embeds: [new EmbedBuilder()
          .setTitle('🧠 QUIZ RENTRÉE ÉTUDIANTE - GEN.EU FRANCE')
          .setDescription('Le quiz sur la rentrée étudiante est disponible !\n\n🔒 Les questions sont privées, personne ne voit tes réponses.\n\nClique sur le bouton ci-dessous pour commencer 👇\n\n⏱️ Tu as 15 secondes par question.')
          .setColor('#3498DB')
          .setFooter({ text: 'Gen.EU France' })],
        components: [row]
      })

      await interaction.reply({ content: '✅ Quiz lancé !', ephemeral: true })

      const filter = i => i.customId === 'start_quiz'
      const collector = channel.createMessageComponentCollector({ filter })

      collector.on('collect', async i => {
        const userId = i.user.id

        if (hasParticipated.has(userId)) {
          return i.reply({ content: '❌ Tu as déjà participé au quiz ! Reviens la prochaine fois.', ephemeral: true })
        }

        hasParticipated.add(userId)
        await i.reply({ content: '🧠 Le quiz commence ! Les questions arrivent...', ephemeral: true })
        sendQuizToMember(i)
      })
    }

    if (interaction.commandName === 'classement') {
      const top = Object.entries(globalScores)
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 10)

      const medals = ['🥇', '🥈', '🥉']
      const classement = top.length
        ? top.map(([id, data], i) => {
            const rank = medals[i] || (i + 1) + '.'
            return `${rank} **${data.username}** : ${data.score} pts`
          }).join('\n')
        : 'Aucun participant pour le moment.'

      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🧠 CLASSEMENT QUIZ RENTRÉE ÉTUDIANTE')
          .setDescription(classement)
          .setColor('#3498DB')],
        ephemeral: false
      })
    }

    if (interaction.commandName === 'endquiz') {
      quizRunning = false
      hasParticipated.clear()
      await interaction.reply({ content: '✅ Quiz arrêté.', ephemeral: true })
    }
  }
})

client.login(TOKEN)

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Events
} = require('discord.js');

const questions = require('./questions');

const {
  TOKEN,
  CLIENT_ID,
  GUILD_ID,
  QUIZ_CHANNEL_ID,
  SCORES_CHANNEL_ID
} = process.env;

for (const key of [
  'TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'QUIZ_CHANNEL_ID',
  'SCORES_CHANNEL_ID'
]) {
  if (!process.env[key]) {
    throw new Error(`Variable manquante : ${key}`);
  }
}

if (
  !Array.isArray(questions) ||
  !questions.length ||
  questions.some(question =>
    typeof question.question !== 'string' ||
    !Array.isArray(question.choices) ||
    question.choices.length !== 4 ||
    !question.choices.every(choice => typeof choice === 'string') ||
    !['A', 'B', 'C', 'D'].includes(question.answer)
  )
) {
  throw new Error('Format invalide dans questions.js.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let ready = false;
let currentSession = null;
let globalScores = {};
let scoresMessageId = null;
let scoresQueue = Promise.resolve();

async function loadScores() {
  const channel = await client.channels.fetch(SCORES_CHANNEL_ID);

  if (!channel?.messages) {
    throw new Error('Canal de scores invalide.');
  }

  let before;

  while (true) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    const message = messages.find(item =>
      item.author.id === client.user.id &&
      item.content.startsWith('SCORES:')
    );

    if (message) {
      globalScores = JSON.parse(
        message.content.slice('SCORES:'.length)
      );

      if (
        !globalScores ||
        typeof globalScores !== 'object' ||
        Array.isArray(globalScores)
      ) {
        throw new Error('Stockage des scores invalide.');
      }

      scoresMessageId = message.id;
      break;
    }

    if (messages.size < 100) break;
    before = messages.last().id;
  }

  console.log('Scores chargés.');
}

async function saveScores() {
  const channel = await client.channels.fetch(SCORES_CHANNEL_ID);
  const content = 'SCORES:' + JSON.stringify(globalScores);

  if (content.length > 2000) {
    throw new Error(
      'Stockage des scores plein : le message dépasse 2000 caractères.'
    );
  }

  if (scoresMessageId) {
    const message = await channel.messages.fetch(scoresMessageId);
    await message.edit(content);
  } else {
    const message = await channel.send({
      content,
      allowedMentions: { parse: [] }
    });

    scoresMessageId = message.id;
  }
}

function commitScore(user, score, correct, wrong) {
  const task = scoresQueue.then(async () => {
    const previous = globalScores[user.id];

    const old = previous || {
      score: 0,
      correct: 0,
      wrong: 0,
      quizzesPlayed: 0
    };

    globalScores[user.id] = {
      username: user.username,
      score: old.score + score,
      correct: old.correct + correct,
      wrong: old.wrong + wrong,
      quizzesPlayed: old.quizzesPlayed + 1
    };

    try {
      await saveScores();
    } catch (error) {
      if (previous) {
        globalScores[user.id] = previous;
      } else {
        delete globalScores[user.id];
      }

      throw error;
    }
  });

  scoresQueue = task.catch(() => {});
  return task;
}

async function sendQuizToMember(interaction, session) {
  const userId = interaction.user.id;

  let quizScore = 0;
  let correct = 0;
  let wrong = 0;

  for (let index = 0; index < questions.length; index++) {
    if (session.stopped) break;

    const question = questions[index];

    const row = new ActionRowBuilder().addComponents(
      ...['A', 'B', 'C', 'D'].map(letter =>
        new ButtonBuilder()
          .setCustomId(`q${index}_${letter}_${userId}`)
          .setLabel(letter)
          .setStyle(ButtonStyle.Primary)
      )
    );

    const message = await interaction.followUp({
      embeds: [
        new EmbedBuilder()
          .setTitle(`🧠 Question ${index + 1} / ${questions.length}`)
          .setDescription(
            question.question + '\n\n' + question.choices.join('\n')
          )
          .setColor('#3498DB')
          .setFooter({ text: '⏱️ 15 secondes pour répondre !' })
      ],
      components: [row],
      ephemeral: true
    });

    if (session.stopped) {
      await message.edit({ components: [] }).catch(() => {});
      break;
    }

    const startTime = Date.now();

    const collector = message.createMessageComponentCollector({
      filter: button =>
        button.user.id === userId &&
        ['A', 'B', 'C', 'D'].some(letter =>
          button.customId === `q${index}_${letter}_${userId}`
        ),
      time: 15000,
      max: 1
    });

    session.collectors.add(collector);

    const acknowledgementTasks = [];

    collector.on('collect', button => {
      acknowledgementTasks.push(
        button.deferUpdate().catch(() => {})
      );
    });

    const collected = await new Promise(resolve => {
      collector.once('end', resolve);
    });

    session.collectors.delete(collector);

    await Promise.all(acknowledgementTasks);
    await message.edit({ components: [] }).catch(() => {});

    if (session.stopped) break;

    const answer = collected.first();
    const rightChoice = question.choices[
      'ABCD'.indexOf(question.answer)
    ];

    let feedback;

    if (!answer) {
      wrong++;
      feedback = `⏱️ Temps écoulé ! La bonne réponse était : ${rightChoice}`;
    } else if (answer.customId.split('_')[1] === question.answer) {
      const speed = Math.max(
        0,
        Math.min(
          15,
          Math.round(
            (15000 - (answer.createdTimestamp - startTime)) / 1000
          )
        )
      );

      const points = 10 + speed;

      quizScore += points;
      correct++;

      feedback =
        `✅ Bonne réponse ! +${points} pts ` +
        `(dont +${speed} pts rapidité)`;
    } else {
      wrong++;
      feedback = `❌ Mauvaise réponse ! La bonne réponse était : ${rightChoice}`;
    }

    await interaction.followUp({
      content: feedback,
      ephemeral: true
    });

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (session.stopped) {
    return interaction.followUp({
      content:
        '⏹️ Le quiz a été arrêté. Cette participation ne compte pas dans le classement.',
      ephemeral: true
    });
  }

  await commitScore(
    interaction.user,
    quizScore,
    correct,
    wrong
  );

  await interaction.followUp({
    embeds: [
      new EmbedBuilder()
        .setTitle('🏁 Quiz terminé !')
        .setDescription(
          `Score de ce quiz : **${quizScore} pts**\n` +
          `✅ Bonnes réponses : ${correct}\n` +
          `❌ Mauvaises réponses : ${wrong}\n\n` +
          'Merci pour ta participation !'
        )
        .setColor('#3498DB')
    ],
    ephemeral: true
  });
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('quiz')
      .setDescription('Lance le quiz écologie')
      .setDefaultMemberPermissions(
        PermissionFlagsBits.Administrator
      ),

    new SlashCommandBuilder()
      .setName('classement')
      .setDescription('Affiche le classement général'),

    new SlashCommandBuilder()
      .setName('endquiz')
      .setDescription('Arrête le quiz en cours')
      .setDefaultMemberPermissions(
        PermissionFlagsBits.Administrator
      )
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log('Commandes enregistrées.');
}

client.once(Events.ClientReady, async () => {
  try {
    console.log(`Bot connecté : ${client.user.tag}`);

    await loadScores();
    await registerCommands();

    ready = true;
  } catch (error) {
    console.error('Erreur au démarrage :', error.message);

    client.destroy();
    process.exitCode = 1;
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.guildId !== GUILD_ID) return;

  try {
    if (
      !interaction.isChatInputCommand() &&
      !(
        interaction.isButton() &&
        interaction.customId === 'start_quiz'
      )
    ) {
      return;
    }

    if (!ready) {
      return interaction.reply({
        content:
          'Le bot démarre, réessaie dans quelques secondes.',
        ephemeral: true
      });
    }

    if (interaction.isButton()) {
      const session = currentSession;

      if (
        !session ||
        session.stopped ||
        interaction.message.id !== session.messageId
      ) {
        return interaction.reply({
          content: 'Ce quiz est terminé.',
          ephemeral: true
        });
      }

      if (session.participants.has(interaction.user.id)) {
        return interaction.reply({
          content:
            '❌ Tu as déjà participé au quiz ! Reviens la prochaine fois.',
          ephemeral: true
        });
      }

      session.participants.add(interaction.user.id);

      await interaction.reply({
        content:
          '🧠 Le quiz commence ! Les questions arrivent...',
        ephemeral: true
      });

      sendQuizToMember(interaction, session).catch(async error => {
        console.error(
          'Erreur pendant le quiz :',
          error.message
        );

        await interaction.followUp({
          content:
            '❌ Une erreur a interrompu ta participation. Contacte un administrateur.',
          ephemeral: true
        }).catch(() => {});
      });

      return;
    }

    if (
      ['quiz', 'endquiz'].includes(interaction.commandName) &&
      !interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      )
    ) {
      return interaction.reply({
        content:
          '❌ Cette commande est réservée aux administrateurs.',
        ephemeral: true
      });
    }

    if (interaction.commandName === 'quiz') {
      if (currentSession) {
        return interaction.reply({
          content:
            "⚠️ Un quiz est déjà en cours ! Utilise /endquiz pour l'arrêter.",
          ephemeral: true
        });
      }

      const session = {
        participants: new Set(),
        collectors: new Set(),
        stopped: false,
        messageId: null,
        message: null
      };

      currentSession = session;

      try {
        await interaction.deferReply({ ephemeral: true });

        const channel = await client.channels.fetch(
          QUIZ_CHANNEL_ID
        );

        const message = await channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                "🧠 QUIZ QUELLE PLACE POUR L'ÉCOLOGIE DANS TON QUOTIDIEN - GEN.EU FRANCE"
              )
              .setDescription(
                "Le quiz sur l'écologie dans ton quotidien est disponible !\n\n" +
                '🔒 Les questions sont privées, personne ne voit tes réponses.\n\n' +
                'Clique sur le bouton ci-dessous pour commencer 👇\n\n' +
                '⏱️ Tu as 15 secondes par question.'
              )
              .setColor('#3498DB')
              .setFooter({ text: 'Gen.EU France' })
          ],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('start_quiz')
                .setLabel('🧠 Commencer le quiz')
                .setStyle(ButtonStyle.Primary)
            )
          ]
        });

        session.message = message;
        session.messageId = message.id;

        if (session.stopped) {
          await message.edit({ components: [] });

          return interaction.editReply({
            content: 'Le lancement du quiz a été annulé.'
          });
        }

        return interaction.editReply({
          content: '✅ Quiz lancé !'
        });
      } catch (error) {
        session.stopped = true;

        if (currentSession === session) {
          currentSession = null;
        }

        throw error;
      }
    }

    if (interaction.commandName === 'classement') {
      const top = Object.entries(globalScores)
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 10);

      const medals = ['🥇', '🥈', '🥉'];

      const lines = top.map(([id, data], index) =>
        `${medals[index] || `${index + 1}.`} <@${id}> : ${data.score} pts`
      );

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🧠 CLASSEMENT QUIZ')
            .setDescription(
              lines.join('\n') ||
              'Aucun participant pour le moment.'
            )
            .setColor('#3498DB')
        ],
        allowedMentions: { parse: [] }
      });
    }

    if (interaction.commandName === 'endquiz') {
      const session = currentSession;

      if (!session) {
        return interaction.reply({
          content: 'Aucun quiz en cours.',
          ephemeral: true
        });
      }

      session.stopped = true;
      currentSession = null;

      for (const collector of session.collectors) {
        collector.stop('quiz_stopped');
      }

      await interaction.deferReply({ ephemeral: true });

      if (session.message) {
        await session.message.edit({ components: [] });
      }

      return interaction.editReply({
        content: '✅ Quiz arrêté.'
      });
    }
  } catch (error) {
    console.error('Erreur interaction :', error.message);

    const payload = {
      content:
        '❌ Une erreur est survenue. Vérifie les permissions du bot et ses logs.'
    };

    try {
      if (interaction.deferred) {
        await interaction.editReply(payload);
      } else if (interaction.replied) {
        await interaction.followUp({
          ...payload,
          ephemeral: true
        });
      } else {
        await interaction.reply({
          ...payload,
          ephemeral: true
        });
      }
    } catch (_) {}
  }
});

client.login(TOKEN).catch(() => {
  console.error('Connexion impossible. Vérifie TOKEN.');
  process.exitCode = 1;
});

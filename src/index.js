const {
	Client,
	Events,
	GatewayIntentBits,
	ChannelType,
	MessageFlags,
	InteractionContextType,
	ApplicationIntegrationType,
} = require('discord.js');
const config = require('./config');
const { GameSession } = require('./session');

const COMMAND = {
	name: 'boardy',
	description: 'Start the game session in a voice channel, or end it with a summary',
	description_localizations: { fr: 'Démarre la session de jeu dans un salon vocal, ou la termine avec un résumé' },
	contexts: [InteractionContextType.Guild],
	integration_types: [ApplicationIntegrationType.GuildInstall],
};

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const sessions = new Map(); // guildId → GameSession (Discord allows one voice channel per guild)

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

/**
 * /boardy joins the voice channel whose chat it is typed in, or else the user's
 * voice channel. Typed again in that channel, it ends the session.
 */
async function handleCommand(interaction) {
	const channel = interaction.channel?.type === ChannelType.GuildVoice ? interaction.channel : interaction.member?.voice?.channel;
	if (channel?.type !== ChannelType.GuildVoice) {
		return ephemeral(interaction, 'Lance `/boardy` depuis le chat d\'un salon vocal, ou en étant connecté à un salon vocal.');
	}
	const current = sessions.get(interaction.guildId);
	if (current) {
		if (current.channel.id !== channel.id) return ephemeral(interaction, `Je suis déjà en session dans ${current.channel}.`);
		if (!current.ready) return ephemeral(interaction, 'La session démarre, réessaie dans un instant.');
		await interaction.reply('-# Fin de session : je prépare le résumé…');
		current.end();
		return;
	}
	// Registered before any await: a concurrent /boardy sees it.
	const session = new GameSession(channel, ended => {
		if (sessions.get(ended.guildId) === ended) sessions.delete(ended.guildId);
	});
	sessions.set(interaction.guildId, session);
	try {
		await interaction.deferReply();
		await session.start();
	} catch (err) {
		if (sessions.get(interaction.guildId) === session) sessions.delete(interaction.guildId);
		throw err;
	}
	await interaction.editReply(`🎲 Session de **${channel.name}** lancée. Commencez une phrase par « ${session.botName} » pour me poser une question.`);
}

client.once(Events.ClientReady, async () => {
	await client.application.commands.set([COMMAND]);
	console.log(`[discord] ready as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
	if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND.name) return;
	try {
		await handleCommand(interaction);
	} catch (err) {
		console.error('[discord] command failed:', err);
		const reply = { content: `-# Erreur : ${err.message.slice(0, 300)}`, flags: MessageFlags.Ephemeral };
		(interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
	}
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => sessions.get(newState.guild.id)?.checkAlone());

process.on('unhandledRejection', err => console.error('[process] unhandled rejection:', err));

client.login(config.DISCORD_TOKEN);

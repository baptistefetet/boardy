const { MessageFlags } = require('discord.js');
const config = require('./config');

const MAX_LENGTH = 2000;
const HISTORY_PAGES = 20; // 100 messages each
// Bot messages that are not campaign context start with this (Discord small text).
const NOTICE = '-# ';

const time = date => date.toLocaleTimeString(config.LOCALE, { hour: '2-digit', minute: '2-digit' });
const day = date => date.toLocaleDateString(config.LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** Split on line boundaries, hard-cutting only lines longer than a message. */
function chunk(text) {
	const chunks = [];
	let current = '';
	for (const line of text.split('\n')) {
		for (let rest = line; ;) {
			const room = MAX_LENGTH - current.length - (current ? 1 : 0);
			if (rest.length <= room) {
				current += (current ? '\n' : '') + rest;
				break;
			}
			if (current) {
				chunks.push(current);
				current = '';
			} else {
				chunks.push(rest.slice(0, MAX_LENGTH));
				rest = rest.slice(MAX_LENGTH);
			}
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

async function send(channel, text, files) {
	const chunks = chunk(text);
	for (const [i, content] of chunks.entries()) {
		await channel.send({
			content,
			files: i === chunks.length - 1 ? files : undefined,
			flags: MessageFlags.SuppressEmbeds,
			allowedMentions: { parse: [] },
		});
	}
}

const notice = (channel, text, files) => send(channel, NOTICE + text, files);

/**
 * The bot's own messages in the channel, oldest first: campaign context.
 * Interaction replies and notices are excluded. Reading its own messages needs
 * no Message Content intent.
 */
async function fetchBotMessages(channel) {
	const botId = channel.client.user.id;
	const kept = [];
	let before;
	for (let page = 0; page < HISTORY_PAGES; page++) {
		const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
		for (const message of batch.values()) {
			if (message.author.id === botId && !message.interactionMetadata && message.content && !message.content.startsWith(NOTICE)) {
				kept.push({ at: message.createdAt, text: message.content });
			}
		}
		if (batch.size < 100) break;
		before = batch.lastKey();
	}
	return kept.reverse();
}

module.exports = { time, day, send, notice, fetchBotMessages };

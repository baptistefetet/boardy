const {
	joinVoiceChannel,
	entersState,
	createAudioPlayer,
	NoSubscriberBehavior,
	VoiceConnectionStatus,
	EndBehaviorType,
} = require('@discordjs/voice');
const config = require('./config');
const { CHIME_OPEN, CHIME_CLOSE, newOpus, msToBytes, bytesToMs, toMono24k, rms, wav, Speaker } = require('./audio');
const { transcribe, generate } = require('./openai');
const { Conversation } = require('./conversation');
const { Recap } = require('./recap');
const { time, day, send, notice, fetchBotMessages } = require('./discord');
const { SUMMARY_TITLE, summaryInstructions, summaryInput, transcriptionPrompt } = require('./prompts');

const DISCONNECTED_MS = 5_000; // voice connection stuck in Disconnected
const RECOVERY_MS = 30_000; // voice connection back to Ready
const RESUBSCRIBE_MS = 1000;
const REPLAY_MS = 60_000; // per-speaker audio kept to replay a question to GPT-Live
const PROMPT_TAIL_CHARS = 300;
const INTERJECTIONS = new Set(['dis', 'hey', 'he', 'eh', 'oh', 'ok', 'okay', 'alors', 'bon']);
// Word right after the name → transcription slips allowed. None on "tais" and "chut": "mais", "fais", "chat".
const STOP_WORDS = { stop: 1, arrete: 1, arretez: 1, taisez: 1, silence: 1, suffit: 1, tais: 0, chut: 0 };


const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function distance(a, b) {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length];
}

/**
 * When a sentence starts with the bot's name (transcription slips allowed), the
 * words after the name up to the end of the text; null otherwise.
 */
function addressed(text, botName) {
	const name = (normalize(botName).match(/[\p{L}\p{N}]+/u) || [''])[0];
	if (!name) return null;
	const tolerance = name.length >= 6 ? 2 : name.length >= 4 ? 1 : 0;
	const sentences = normalize(text).split(/[.!?…]+/).map(sentence => sentence.match(/[\p{L}\p{N}]+/gu) || []);
	for (const [i, words] of sentences.entries()) {
		const start = INTERJECTIONS.has(words[0]) ? 1 : 0;
		// "BoardyBot" may be transcribed as two words: try the first one, then the first two joined.
		for (const count of [1, 2]) {
			const candidate = words.slice(start, start + count);
			if (candidate.length === count && distance(candidate.join(''), name) <= tolerance) {
				return [...words.slice(start + count), ...sentences.slice(i + 1).flat()];
			}
		}
	}
	return null;
}

/** "<name>, stop", "<name>, ça suffit"…: a stop word right after the name. */
function asksToStop(rest) {
	const word = rest.find(w => !INTERJECTIONS.has(w) && w !== 'ca');
	return !!word && Object.entries(STOP_WORDS).some(([stop, tolerance]) => distance(word, stop) <= tolerance);
}

/**
 * One game session in a voice channel: transcribes every speaker in segments,
 * opens a GPT-Live conversation on the wake word, posts a summary at the end.
 * The transcript lives in memory only.
 */
class GameSession {
	constructor(channel, onEnded) {
		this.channel = channel;
		this.guildId = channel.guild.id;
		this.game = channel.name;
		this.botName = channel.guild.members.me.displayName;
		this.onEnded = onEnded;
		this.startedAt = new Date();
		this.transcript = []; // { at, name, text }, in arrival order
		this.history = []; // bot messages (summaries), campaign context
		this.listeners = new Map(); // userId → speaker state
		this.transcriptions = new Set();
		this.conversation = null;
		this.recap = null; // GPT-Live telling the previous summary
		this.closings = new Set(); // conversations still finalizing
		this.connection = null;
		this.player = null;
		this.speaker = null;
		this.aloneTimer = null;
		this.recoveryTimer = null;
		this.disconnectTimer = null;
		this.ready = false;
		this.ending = false;
	}

	async start() {
		this.connection = joinVoiceChannel({
			channelId: this.channel.id,
			guildId: this.guildId,
			adapterCreator: this.channel.guild.voiceAdapterCreator,
			selfDeaf: false,
			selfMute: false,
		});
		try {
			await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
		} catch (err) {
			this.connection.destroy();
			throw new Error(`could not join the voice channel (permissions?): ${err.message}`);
		}
		this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } });
		this.player.on('error', err => console.warn('[voice] player error:', err.message));
		this.connection.subscribe(this.player);
		this.speaker = new Speaker(this.player);
		// 'start' fires before the packet is dispatched: subscribing here loses nothing.
		this.connection.receiver.speaking.on('start', userId => this.listen(userId));
		this.connection.on('stateChange', (_, state) => this.watchConnection(state.status));
		this.connection.on(VoiceConnectionStatus.Destroyed, () => this.end('Connexion vocale perdue : fin de session.'));
		this.connection.on('error', err => console.warn('[voice] connection error:', err.message));
		try {
			this.history = await fetchBotMessages(this.channel);
		} catch (err) {
			console.warn('[session] history unavailable:', err.message);
		}
		console.log(`[session] started in "${this.game}" (${this.guildId})`);
		this.ready = true;
		this.checkAlone();
		this.narrate();
	}

	/** GPT-Live tells the previous session's summary, until the first wake word. */
	narrate() {
		const start = this.history.findLastIndex(({ text }) => text.startsWith(SUMMARY_TITLE));
		if (start < 0 || this.ending || this.conversation) return; // history loads while the session runs
		const summary = this.history.slice(start).map(({ text }) => text).join('\n'); // its Discord chunks
		const recap = this.recap = new Recap(this, summary);
		console.log(`[session] recap: ${summary.length} characters`);
		recap.open().catch(err => {
			console.warn('[session] recap failed:', err.message); // also when stopped during setup
			recap.close('failed');
		});
	}

	stopRecap(reason) {
		if (!this.recap || this.recap.closed) return;
		this.recap.close(reason);
		this.speaker.stop();
	}

	/**
	 * Short reconnections are routine. Disconnected for 5 s is a real loss (kicked,
	 * channel deleted), and so is not being Ready again 30 s after leaving it,
	 * whatever the intermediate states. Destroying the connection ends the session.
	 */
	watchConnection(status) {
		clearTimeout(this.disconnectTimer);
		if (status === VoiceConnectionStatus.Ready || status === VoiceConnectionStatus.Destroyed) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = null;
			return;
		}
		const destroy = () => {
			if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
		};
		this.recoveryTimer ??= setTimeout(destroy, RECOVERY_MS);
		if (status === VoiceConnectionStatus.Disconnected) this.disconnectTimer = setTimeout(destroy, DISCONNECTED_MS);
	}

	checkAlone() {
		if (this.ending) return;
		const alone = !this.channel.members.some(member => !member.user.bot);
		if (!alone) {
			clearTimeout(this.aloneTimer);
			this.aloneTimer = null;
		} else if (!this.aloneTimer) {
			this.aloneTimer = setTimeout(
				() => this.end(`Seul depuis ${config.ALONE_TIMEOUT_MS / 60_000} min : fin de session.`),
				config.ALONE_TIMEOUT_MS,
			);
		}
	}

	/* ------------------------------------------------------------ listening */

	listen(userId) {
		if (this.ending || this.listeners.has(userId)) return;
		const member = this.channel.guild.members.cache.get(userId);
		if (member?.user.bot) return;
		const listener = {
			userId,
			name: member?.displayName || 'Joueur',
			decoder: newOpus(),
			chunks: [],
			bytes: 0,
			startedAt: 0,
			gapTimer: null,
			recent: [], // last segments, { at, pcm }
		};
		this.listeners.set(userId, listener);
		const stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
		stream.on('data', packet => this.onPacket(listener, packet));
		stream.on('error', err => console.warn('[voice] receive error:', err.message));
		// A packet that fails to decrypt destroys the stream: subscribe again shortly.
		stream.on('close', () => {
			this.flush(listener);
			if (this.listeners.get(userId) === listener) this.listeners.delete(userId);
			if (!this.ending) setTimeout(() => this.listen(userId), RESUBSCRIBE_MS);
		});
	}

	onPacket(listener, packet) {
		let pcm;
		try {
			pcm = toMono24k(listener.decoder.decode(packet));
		} catch {
			return;
		}
		if (!listener.chunks.length) listener.startedAt = Date.now();
		listener.chunks.push(pcm);
		listener.bytes += pcm.length;
		if (this.conversation?.target === listener.userId) this.conversation.write(pcm);
		clearTimeout(listener.gapTimer);
		if (listener.bytes >= msToBytes(config.SEGMENT_MAX_MS)) this.flush(listener);
		else listener.gapTimer = setTimeout(() => this.flush(listener), config.SEGMENT_GAP_MS);
	}

	flush(listener) {
		clearTimeout(listener.gapTimer);
		if (!listener.chunks.length) return;
		const segment = { at: new Date(listener.startedAt), pcm: Buffer.concat(listener.chunks) };
		listener.chunks = [];
		listener.bytes = 0;
		listener.recent.push(segment);
		while (listener.recent.reduce((ms, s) => ms + bytesToMs(s.pcm.length), 0) > REPLAY_MS) listener.recent.shift();
		if (segment.pcm.length < msToBytes(config.SEGMENT_MIN_MS) || rms(segment.pcm) < config.SEGMENT_MIN_RMS) return;
		const job = this.transcribeSegment(listener, segment).finally(() => this.transcriptions.delete(job));
		this.transcriptions.add(job);
	}

	async transcribeSegment(listener, segment) {
		let text;
		try {
			const previous = this.transcript.length ? this.transcript[this.transcript.length - 1].text.slice(-PROMPT_TAIL_CHARS) : '';
			// No keywords: gpt-transcribe was seen writing them out on unclear audio, waking the bot.
			text = await transcribe(wav(segment.pcm), transcriptionPrompt(this.game, previous));
		} catch (err) {
			console.warn('[transcribe] failed:', err.message);
			return;
		}
		if (!text) return;
		this.transcript.push({ at: segment.at, name: listener.name, text });
		const rest = this.ending ? null : addressed(text, this.botName);
		if (!rest) return;
		if (asksToStop(rest)) this.silence(listener, text);
		else this.summon(listener, segment, text);
	}

	/* --------------------------------------------------------- conversation */

	/** "<name>, stop": end the recap or the conversation, without opening one. */
	silence(listener, text) {
		console.log(`[session] ${listener.name} stopped ${this.botName}: ${JSON.stringify(text)}`);
		this.stopRecap('stop');
		if (!this.conversation) return;
		this.speaker.stop(); // before closing: keeps the closing chime
		this.conversation.close();
	}

	/** Replay from the segment holding the wake word: GPT-Live must hear the question. */
	summon(listener, segment, text) {
		console.log(`[session] ${listener.name} summoned ${this.botName}: ${JSON.stringify(text)}`);
		const later = listener.recent.filter(s => s.at > segment.at).map(s => s.pcm);
		const replay = [segment.pcm, ...later, ...listener.chunks];
		if (this.conversation) return this.conversation.summon(listener.userId, replay);
		this.stopRecap('wake word');
		this.speaker.write(CHIME_OPEN); // opening GPT-Live takes seconds: the table knows it was heard
		const conversation = this.conversation = new Conversation(this, listener.userId, replay);
		conversation.open().catch(err => {
			if (conversation.closed) return; // closed on purpose during setup
			console.error('[live] open failed:', err.message);
			conversation.close();
			notice(this.channel, `Assistant vocal indisponible : ${err.message.slice(0, 300)}`).catch(() => {});
		});
	}

	onConversationClosing(conversation) {
		if (this.conversation === conversation) this.conversation = null;
		this.closings.add(conversation.closing);
		if (!this.ending) this.speaker.write(CHIME_CLOSE); // queued after its last words
	}

	onConversationClosed(conversation) {
		this.closings.delete(conversation.closing);
		const text = conversation.speech.trim();
		if (!text) return;
		console.log(`[live] said: ${JSON.stringify(text)}`);
		this.transcript.push({ at: conversation.openedAt, name: this.botName, text });
	}

	formatHistory(history = this.history) {
		return history.map(({ at, text }) => `[${at.toLocaleDateString(config.LOCALE)}]\n${text}`).join('\n\n');
	}

	formatTranscript() {
		return [...this.transcript]
			.sort((a, b) => a.at - b.at)
			.map(({ at, name, text }) => `[${time(at)}] ${name} : ${text}`)
			.join('\n');
	}

	/* ------------------------------------------------------------------ end */

	/** Leave at once, then summarize. `reason` is posted as a notice when given. */
	async end(reason) {
		if (this.ending) return;
		this.ending = true;
		clearTimeout(this.aloneTimer);
		clearTimeout(this.recoveryTimer);
		clearTimeout(this.disconnectTimer);
		for (const listener of this.listeners.values()) this.flush(listener);
		this.recap?.close('session end');
		this.speaker?.stop();
		if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
		this.onEnded(this);
		console.log(`[session] ended in "${this.game}" (${this.guildId})`);
		if (reason) await notice(this.channel, reason).catch(err => console.warn('[session] notice failed:', err.message));
		try {
			this.conversation?.close();
			await Promise.allSettled([...this.closings, ...this.transcriptions]);
			await this.summarize();
		} catch (err) {
			console.error('[session] end failed:', err.message);
		}
	}

	async summarize() {
		if (!this.transcript.length) return notice(this.channel, 'Rien n\'a été transcrit : pas de résumé.');
		const transcript = this.formatTranscript();
		try {
			const history = await fetchBotMessages(this.channel).catch(() => this.history);
			const date = day(this.startedAt);
			const summary = await generate(
				summaryInstructions(this.botName, this.game, date),
				summaryInput(this.botName, this.formatHistory(history), transcript),
			);
			if (!summary) throw new Error('empty summary');
			await send(this.channel, summary);
		} catch (err) {
			console.error('[summary] failed:', err.message);
			// Last copy of the session: attach the transcript rather than lose it.
			await notice(this.channel, `Résumé impossible (${err.message.slice(0, 200)}) : voici le transcript.`, [
				{ attachment: Buffer.from(transcript), name: 'transcript.txt' },
			]);
		}
	}
}

module.exports = { GameSession, addressed, asksToStop };

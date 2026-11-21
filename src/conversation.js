const { performance } = require('perf_hooks');
const config = require('./config');
const { LiveCall } = require('./live');
const { liveInstructions, liveContext, backendInstructions } = require('./prompts');
const { RATE, msToBytes } = require('./audio');

// Startup history is capped at 8,192 rendered tokens by default: at 3 characters
// per token at worst, these caps stay near 6,000.
const HISTORY_CHARS = 12_000;
const TRANSCRIPT_CHARS = 6_000;
const BACKEND_END = new Set(['response.completed', 'response.failed', 'response.incomplete']);

const FRAME_MS = 20;
const FRAME_BYTES = msToBytes(FRAME_MS);
const SILENCE = Buffer.alloc(FRAME_BYTES);
const JITTER_FRAMES = 2; // queued before speech resumes after silence
const BACKLOG_FRAMES = 10; // above: drain faster (replayed question)
const CATCH_UP_EVERY = 5; // with a backlog, one extra frame every 5 slots: 1.2× real time, GPT-Live's input cap
const MAX_LAG_FRAMES = 50; // after an event-loop stall, skip rather than flood

const tail = (text, max) => (text.length > max ? text.slice(-max) : text);

/**
 * One GPT-Live exchange, opened by the wake word and closed when idle.
 * GPT-Live hears a single Discord user, the `target`: the one who said the wake
 * word, starting with a replay of the question. Its input is a continuous stream
 * paced at the sample rate, silence included: Discord sends nothing while nobody
 * talks, and GPT-Live needs that silence to detect the end of a turn.
 * Rules searches run on OpenAI's side (Responses delegation); this class only
 * logs their answer.
 */
class Conversation {
	constructor(session, target, replay) {
		this.session = session;
		this.target = target;
		this.call = null;
		this.closed = false;
		this.closing = null;
		this.openedAt = new Date();
		this.speech = '';
		this.lastSummoned = 0; // last wake word
		this.lastActive = 0; // the same, or the end of a search holding the call
		this.delegations = new Map(); // id → { at, holdsOpen, texts }
		this.idleTimer = null;
		this.ticker = null;
		this.queue = []; // 20 ms frames
		this.partial = Buffer.alloc(0);
		this.primed = false;
		for (const pcm of replay) this.write(pcm);
	}

	async open() {
		const { session } = this;
		this.call = new LiveCall({
			model: config.LIVE_MODEL,
			instructions: liveInstructions(session.botName, session.game),
			input: [{
				type: 'message',
				role: 'developer',
				content: [{
					type: 'input_text',
					text: liveContext(session.botName, tail(session.formatHistory(), HISTORY_CHARS), tail(session.formatTranscript(), TRANSCRIPT_CHARS)),
				}],
			}],
			audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: config.LIVE_VOICE } },
			delegation: {
				type: 'responses',
				responses: {
					model: config.TEXT_MODEL,
					instructions: backendInstructions(session.game),
					tools: [{ type: 'web_search' }],
					tool_choice: 'auto',
					reasoning: { effort: config.REASONING_EFFORT },
					service_tier: config.SERVICE_TIER,
				},
			},
		});
		this.call.on('audio', pcm => {
			if (this.closed || session.ending) return;
			session.speaker.write(pcm); // not activity: GPT-Live streams near-silence while idle
		});
		this.call.on('speech', delta => { this.speech += delta; });
		this.call.on('delegation', id => this.onDelegation(id));
		this.call.on('backend', (id, event) => this.onBackend(id, event));
		this.call.on('closed', () => this.close());
		await this.call.open();
		if (this.closed) return;
		this.startInput();
		this.touch();
	}

	write(pcm) {
		if (this.closed) return;
		let data = this.partial.length ? Buffer.concat([this.partial, pcm]) : pcm;
		while (data.length >= FRAME_BYTES) {
			this.queue.push(data.subarray(0, FRAME_BYTES));
			data = data.subarray(FRAME_BYTES);
		}
		this.partial = data;
	}

	startInput() {
		const start = performance.now();
		let sent = 0;
		this.ticker = setInterval(() => {
			const due = Math.floor((performance.now() - start) / FRAME_MS);
			if (due - sent > MAX_LAG_FRAMES) sent = due - 1;
			for (; sent < due; sent++) this.call.appendAudio(this.nextFrames(sent));
		}, FRAME_MS);
	}

	nextFrames(slot) {
		if (!this.queue.length) this.primed = false;
		else if (this.queue.length >= JITTER_FRAMES) this.primed = true;
		if (!this.primed) return SILENCE;
		const extra = this.queue.length > BACKLOG_FRAMES && slot % CATCH_UP_EVERY === 0;
		return Buffer.concat(this.queue.splice(0, extra ? 2 : 1));
	}

	/** The wake word again: keep the call open, and listen to whoever said it. */
	summon(target, replay) {
		if (target !== this.target) {
			this.target = target;
			this.queue = [];
			this.partial = Buffer.alloc(0);
			for (const pcm of replay) this.write(pcm);
		}
		this.touch();
	}

	/** The wake word. */
	touch() {
		this.lastSummoned = this.lastActive = Date.now();
		this.schedule();
	}

	/**
	 * Close LIVE_IDLE_MS after the last wake word or end of a holding search. A
	 * search holds the call up to LIVE_DELEGATION_TIMEOUT_MS after its start, but
	 * only if it started within LIVE_IDLE_MS of the wake word: searches GPT-Live
	 * starts on table talk must not keep it awake, nor chain into each other.
	 */
	schedule() {
		if (this.closed) return;
		clearTimeout(this.idleTimer);
		let end = this.lastActive + config.LIVE_IDLE_MS;
		for (const { at, holdsOpen } of this.delegations.values()) {
			if (holdsOpen) end = Math.max(end, at + config.LIVE_DELEGATION_TIMEOUT_MS);
		}
		this.idleTimer = setTimeout(() => this.close(), Math.max(0, end - Date.now()));
	}

	onDelegation(id) {
		const at = Date.now();
		const holdsOpen = at - this.lastSummoned <= config.LIVE_IDLE_MS;
		console.log(`[live] search ${id} started${holdsOpen ? '' : ', not holding the call'}`);
		this.delegations.set(id, { at, holdsOpen, texts: [] });
		this.schedule();
	}

	onBackend(id, event) {
		if (!event?.type?.endsWith('.delta')) console.log(`[live] search ${id} event ${event?.type}`);
		const delegation = this.delegations.get(id);
		if (!delegation) return;
		if (event.type === 'response.output_item.done' && event.item?.type === 'message') {
			for (const part of event.item.content || []) {
				if (part.type === 'output_text') delegation.texts.push(part.text);
			}
		} else if (BACKEND_END.has(event.type)) {
			this.delegations.delete(id);
			if (event.type !== 'response.completed') console.warn(`[live] search ${event.type}`);
			// GPT-Live speaks the answer, which joins the transcript: nothing is posted.
			if (delegation.texts.length) console.log(`[live] search ${id} answer: ${JSON.stringify(delegation.texts.join('\n'))}`);
			if (delegation.holdsOpen) this.lastActive = Date.now(); // time to speak the result
			this.schedule();
		}
	}

	/** Resolves once GPT-Live has finalized, so its last transcript deltas are kept. */
	close() {
		if (!this.closing) {
			this.closed = true;
			clearTimeout(this.idleTimer);
			clearInterval(this.ticker);
			this.queue = [];
			this.closing = (this.call ? this.call.close() : Promise.resolve()).then(() => this.session.onConversationClosed(this));
			this.session.onConversationClosing(this);
		}
		return this.closing;
	}
}

module.exports = { Conversation };

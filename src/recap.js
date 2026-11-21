const config = require('./config');
const { LiveCall } = require('./live');
const { RATE, msToBytes, rms } = require('./audio');
const { recapInstructions, recapInput } = require('./prompts');

const FRAME_MS = 100;
const SILENCE = Buffer.alloc(msToBytes(FRAME_MS));
const QUIET_MS = 5000; // pauses within the story last up to ~2 s
const START_MS = 30_000; // no voice by then: give up
const MAX_MS = 10 * 60_000; // billing guard

/**
 * GPT-Live tells the previous session's summary at session start. Its audio
 * comes in real time and it keeps streaming near-silence once done, so the call
 * closes after QUIET_MS without voiced audio. It hears only silence: table talk
 * must not interrupt it; the wake word, seen in the transcript, stops it instead.
 */
class Recap {
	constructor(session, summary) {
		this.session = session;
		this.summary = summary;
		this.call = null;
		this.closed = false;
		this.ticker = null;
		this.quietTimer = null;
		this.maxTimer = null;
	}

	async open() {
		const { session } = this;
		this.call = new LiveCall({
			model: config.LIVE_MODEL,
			instructions: recapInstructions(session.botName, session.game),
			input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: recapInput(this.summary) }] }],
			audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: config.LIVE_VOICE } },
			delegation: { type: 'client' },
		});
		this.call.on('audio', pcm => {
			if (this.closed) return;
			session.speaker.write(pcm);
			if (rms(pcm) >= config.SEGMENT_MIN_RMS) this.arm(QUIET_MS, 'told');
		});
		this.call.on('closed', () => this.close('call closed'));
		await this.call.open();
		if (this.closed) return this.call.close();
		this.ticker = setInterval(() => this.call.appendAudio(SILENCE), FRAME_MS);
		this.arm(START_MS, 'no voice');
		this.maxTimer = setTimeout(() => this.close('too long'), MAX_MS);
	}

	arm(ms, reason) {
		clearTimeout(this.quietTimer);
		this.quietTimer = setTimeout(() => this.close(reason), ms);
	}

	close(reason) {
		if (this.closed) return;
		this.closed = true;
		console.log(`[recap] closed (${reason})`);
		clearInterval(this.ticker);
		clearTimeout(this.quietTimer);
		clearTimeout(this.maxTimer);
		this.call?.close();
	}
}

module.exports = { Recap };

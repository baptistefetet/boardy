const { Readable } = require('stream');
const { OpusEncoder } = require('@discordjs/opus');
const { createAudioResource, StreamType } = require('@discordjs/voice');

// Discord carries 20 ms Opus frames of 48 kHz stereo. GPT-Live and transcription use 24 kHz mono s16le.
const DISCORD_RATE = 48_000;
const RATE = 24_000;
const FRAME_BYTES = 3840; // 20 ms at 48 kHz stereo s16le
const BURST_END_MS = 1000;
const EMPTY = Buffer.alloc(0);

const newOpus = () => new OpusEncoder(DISCORD_RATE, 2);
const msToBytes = ms => Math.round(ms * RATE / 1000) * 2;
const bytesToMs = bytes => bytes / 2 / RATE * 1000;

/** Earcon, 24 kHz mono: [Hz, ms] notes, each fading out to silence. */
const chime = notes => Buffer.concat(notes.map(([freq, ms]) => {
	const samples = Math.round(RATE * ms / 1000);
	const out = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) {
		const envelope = Math.min(1, i / (RATE * 0.005)) * (1 - i / samples) ** 2;
		out.writeInt16LE(Math.round(8000 * envelope * Math.sin(2 * Math.PI * freq * i / RATE)), i * 2);
	}
	return out;
}));
const CHIME_OPEN = chime([[660, 90], [990, 180]]); // rising: GPT-Live opens
const CHIME_CLOSE = chime([[990, 90], [660, 180]]); // falling: it no longer listens

/** 48 kHz stereo → 24 kHz mono: average each pair of stereo frames. */
function toMono24k(pcm) {
	const out = Buffer.alloc((pcm.length >> 3) * 2);
	for (let i = 0, o = 0; o < out.length; i += 8, o += 2) {
		out.writeInt16LE((pcm.readInt16LE(i) + pcm.readInt16LE(i + 2) + pcm.readInt16LE(i + 4) + pcm.readInt16LE(i + 6)) >> 2, o);
	}
	return out;
}

function rms(pcm) {
	const samples = pcm.length >> 1;
	let sum = 0;
	for (let i = 0; i < samples; i++) sum += pcm.readInt16LE(i * 2) ** 2;
	return samples ? Math.sqrt(sum / samples) : 0;
}

function wav(pcm) {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write('WAVEfmt ', 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(RATE, 24);
	header.writeUInt32LE(RATE * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/**
 * Plays GPT-Live PCM on a Discord audio player, one resource per burst of speech.
 * The primary WebSocket gives no end-of-audio event: a burst ends once its queue
 * has drained and no audio came for BURST_END_MS.
 */
class Speaker {
	constructor(player) {
		this.player = player;
		this.encoder = newOpus();
		this.stream = null;
		this.resource = null;
		this.pending = EMPTY; // 48 kHz stereo, less than one frame once flushed
		this.odd = EMPTY; // trailing byte of an odd-sized chunk
		this.last = 0; // last 24 kHz sample, for interpolation across chunks
		this.endTimer = null;
	}

	write(chunk) {
		const data = this.odd.length ? Buffer.concat([this.odd, chunk]) : chunk;
		const even = data.length & ~1;
		this.odd = data.subarray(even);
		this.pending = Buffer.concat([this.pending, this.upsample(data.subarray(0, even))]);
		// The player drops a resource after too many missed frames: start a new one then.
		if (!this.stream || this.player.state.resource !== this.resource) this.open();
		while (this.pending.length >= FRAME_BYTES) {
			this.stream.push(this.encoder.encode(this.pending.subarray(0, FRAME_BYTES)));
			this.pending = this.pending.subarray(FRAME_BYTES);
		}
		clearTimeout(this.endTimer);
		this.endTimer = setTimeout(() => this.endWhenDrained(), BURST_END_MS);
	}

	stop() {
		clearTimeout(this.endTimer);
		this.stream?.destroy();
		this.stream = this.resource = null;
		this.pending = this.odd = EMPTY; // a leftover byte would misalign the next audio
		this.player.stop(true);
	}

	open() {
		this.stream?.destroy();
		this.stream = new Readable({ objectMode: true, read() {} });
		this.resource = createAudioResource(this.stream, { inputType: StreamType.Opus });
		this.player.play(this.resource);
	}

	endWhenDrained() {
		if (!this.stream) return;
		if (this.stream.readableLength) {
			this.endTimer = setTimeout(() => this.endWhenDrained(), BURST_END_MS);
			return;
		}
		if (this.pending.length) {
			this.stream.push(this.encoder.encode(Buffer.concat([this.pending, Buffer.alloc(FRAME_BYTES - this.pending.length)])));
			this.pending = EMPTY;
		}
		this.stream.push(null);
		this.stream = this.resource = null;
	}

	/** 24 kHz mono → 48 kHz stereo, linear interpolation. */
	upsample(pcm) {
		const out = Buffer.alloc(pcm.length * 4);
		for (let i = 0, o = 0; i < pcm.length; i += 2, o += 8) {
			const sample = pcm.readInt16LE(i);
			const middle = (this.last + sample) >> 1;
			out.writeInt16LE(middle, o);
			out.writeInt16LE(middle, o + 2);
			out.writeInt16LE(sample, o + 4);
			out.writeInt16LE(sample, o + 6);
			this.last = sample;
		}
		return out;
	}
}

module.exports = { RATE, CHIME_OPEN, CHIME_CLOSE, newOpus, msToBytes, bytesToMs, toMono24k, rms, wav, Speaker };

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const config = require('./config');

const URL = 'wss://api.openai.com/v1/live/sessions';
const OPEN_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 15_000;

/**
 * One GPT-Live session on its primary WebSocket, audio in the session's format.
 * Events: 'audio' (Buffer), 'speech' (output transcript delta), 'delegation' (id),
 * 'backend' (delegation id, nested Responses event), 'closed' (reason, emitted once).
 */
class LiveCall extends EventEmitter {
	constructor(session) {
		super();
		this.session = session;
		this.ws = null;
		this.started = false;
		this.ended = false;
		this.closing = null;
		this.seconds = 0;
	}

	open() {
		return new Promise((resolve, reject) => {
			const ws = this.ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` } });
			const fail = err => {
				clearTimeout(timer);
				reject(err);
				ws.terminate();
			};
			const timer = setTimeout(() => fail(new Error('GPT-Live did not start in time')), OPEN_TIMEOUT_MS);
			ws.on('open', () => this.send({ type: 'session.start', session: this.session }));
			ws.on('message', data => {
				let event;
				try {
					event = JSON.parse(data);
				} catch {
					return;
				}
				if (this.started) return this.handle(event);
				if (event.type === 'session.started') {
					this.started = true;
					clearTimeout(timer);
					resolve();
				} else if (event.type === 'error') {
					fail(new Error(`GPT-Live: ${event.error?.message}`));
				}
			});
			ws.on('error', err => {
				if (!this.started) fail(err);
				else console.warn('[live] socket error:', err.message);
			});
			ws.on('close', () => {
				if (!this.started) fail(new Error('GPT-Live closed during setup'));
				this.end('socket_closed');
			});
		});
	}

	appendAudio(pcm) {
		if (this.started && !this.closing && this.ws.readyState === WebSocket.OPEN) {
			this.send({ type: 'session.input_audio.append', audio: pcm.toString('base64') });
		}
	}

	/** Graceful close: wait for `session.closed`, which carries the final usage. */
	close() {
		if (this.ended) return Promise.resolve();
		this.closing ??= new Promise(resolve => {
			const timer = setTimeout(() => this.ws.terminate(), CLOSE_TIMEOUT_MS);
			this.once('closed', () => {
				clearTimeout(timer);
				resolve();
			});
			if (this.ws.readyState === WebSocket.OPEN) this.send({ type: 'session.close' });
			else this.ws.terminate();
		});
		return this.closing;
	}

	handle(event) {
		switch (event.type) {
			case 'session.output_audio.delta':
				this.emit('audio', Buffer.from(event.delta, 'base64'));
				break;
			case 'session.output_transcript.delta':
				this.emit('speech', event.delta);
				break;
			case 'session.delegation.created':
				this.emit('delegation', event.delegation.id);
				break;
			case 'response.event':
				this.emit('backend', event.delegation_id, event.event);
				break;
			case 'session.usage.updated':
				this.seconds = event.usage.seconds;
				break;
			case 'session.closed':
				this.seconds = event.usage?.seconds ?? this.seconds;
				this.ws.close();
				this.end(event.reason);
				break;
			case 'error':
				console.warn('[live] error:', event.error?.code, event.error?.message);
				break;
		}
	}

	send(event) {
		this.ws.send(JSON.stringify(event));
	}

	end(reason) {
		if (this.ended) return;
		this.ended = true;
		if (this.started) console.log(`[live] closed (${reason}) after ${this.seconds} s`);
		this.emit('closed', reason);
	}
}

module.exports = { LiveCall };

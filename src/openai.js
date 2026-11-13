const config = require('./config');

const API = 'https://api.openai.com/v1';
const POLL_MS = 3000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, init = {}) {
	const res = await fetch(API + path, {
		...init,
		headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}`, ...init.headers },
	});
	const body = await res.text();
	if (!res.ok) {
		const err = new Error(`OpenAI ${path} ${res.status}: ${body.slice(0, 300)}`);
		err.status = res.status;
		throw err;
	}
	return JSON.parse(body);
}

/** One retry, except for client errors that would fail again. */
async function withRetry(fn) {
	try {
		return await fn();
	} catch (err) {
		if (err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
		await sleep(2000);
		return fn();
	}
}

/** Transcribe a WAV buffer with gpt-transcribe. */
function transcribe(wav, { prompt, keywords }) {
	return withRetry(async () => {
		const form = new FormData();
		form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
		form.append('model', config.TRANSCRIBE_MODEL);
		form.append('prompt', prompt);
		form.append('languages[]', config.LANGUAGE);
		for (const keyword of keywords) form.append('keywords[]', keyword);
		const { text } = await request('/audio/transcriptions', { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
		return (text || '').trim();
	});
}

/**
 * One Responses call in background mode: xhigh reasoning can outlast an HTTP
 * request, so it is polled. With store=false the response is deleted after ~10 min.
 */
async function generate(instructions, input) {
	let response = await withRetry(() => request('/responses', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: config.TEXT_MODEL,
			reasoning: { effort: config.REASONING_EFFORT },
			service_tier: config.SERVICE_TIER,
			store: false,
			background: true,
			instructions,
			input,
		}),
	}));
	const deadline = Date.now() + config.SUMMARY_TIMEOUT_MS;
	while (response.status === 'queued' || response.status === 'in_progress') {
		if (Date.now() > deadline) throw new Error('the summary timed out');
		await sleep(POLL_MS);
		response = await withRetry(() => request(`/responses/${response.id}`));
	}
	if (response.status !== 'completed') {
		throw new Error(`the summary ended ${response.status}: ${JSON.stringify(response.error || response.incomplete_details)}`);
	}
	return response.output
		.filter(item => item.type === 'message')
		.flatMap(item => item.content)
		.filter(part => part.type === 'output_text')
		.map(part => part.text)
		.join('')
		.trim();
}

module.exports = { transcribe, generate };

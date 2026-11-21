const path = require('path');

try {
	process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
} catch (err) {
	if (err.code !== 'ENOENT') throw err;
}

for (const name of ['DISCORD_TOKEN', 'OPENAI_API_KEY']) {
	if (!process.env[name]) throw new Error(`${name} is missing (see .env.example)`);
}

module.exports = {
	DISCORD_TOKEN: process.env.DISCORD_TOKEN,
	OPENAI_API_KEY: process.env.OPENAI_API_KEY,

	// The prompts are French: change these together with src/prompts.js.
	LANGUAGE: 'fr',
	LOCALE: 'fr-FR',

	TRANSCRIBE_MODEL: 'gpt-transcribe',
	LIVE_MODEL: 'gpt-live-1',
	LIVE_VOICE: 'marin',
	// Rules searches (GPT-Live backend) and session summaries.
	TEXT_MODEL: 'gpt-6.2-sol',
	REASONING_EFFORT: 'xhigh',
	SERVICE_TIER: 'priority', // "Fast" mode

	// Transcription segments: cut after a pause in the speaker's packets, or at the max length.
	SEGMENT_GAP_MS: 700,
	SEGMENT_MAX_MS: 30_000,
	SEGMENT_MIN_MS: 400,
	SEGMENT_MIN_RMS: 100, // below: digital silence, never sent

	// GPT-Live is billed per second open: close it once the exchange is over.
	LIVE_IDLE_MS: 30_000,
	LIVE_DELEGATION_TIMEOUT_MS: 5 * 60_000,

	ALONE_TIMEOUT_MS: 30 * 60_000,
	SUMMARY_TIMEOUT_MS: 30 * 60_000,
};

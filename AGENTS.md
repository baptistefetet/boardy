# AGENTS.md — boardy

> Code, comments, docs and commit messages are in **English**. The model prompts (`src/prompts.js`) and the bot's Discord messages are in **French**, on purpose.

## What it is

Discord voice bot for long board game sessions played around one table, with a single phone in the voice channel. `/boardy` makes it join; it transcribes the whole session, answers rules questions by voice when a sentence starts with its name, and posts a summary in the voice channel's chat when `/boardy` is used again. See `README.md` for setup.

## Architecture

- **Stack**: CommonJS, Node ≥ 22 (`fetch`, `FormData`, `process.loadEnvFile`). Dependencies: `discord.js`, `@discordjs/voice` (DAVE end-to-end encryption through its `@snazzah/davey` dependency), `@discordjs/opus`, `ws`. No OpenAI SDK.
- **Everything goes through one OpenAI API key** (`OPENAI_API_KEY`); models and tiers are constants in `src/config.js`.

```
src/index.js         Discord client, /boardy command, one GameSession per guild
src/session.js       GameSession: voice connection, per-speaker segmentation, transcript, wake word, end + summary
src/conversation.js  One GPT-Live exchange: startup context, idle close, search results posted to chat
src/live.js          GPT-Live primary WebSocket client (session.start … session.closed)
src/audio.js         PCM conversions, WAV, Speaker (GPT-Live PCM → Opus resources on the Discord player)
src/openai.js        gpt-transcribe upload, background Responses call for summaries
src/discord.js       Message chunking, notices, bot message history
src/prompts.js       All French prompts
```

## Session flow

- **Audio in**: one Manual-end receive stream per speaker, subscribed on the first `speaking.start` (it fires before the packet is dispatched, so nothing is lost) and again 1 s after a stream dies (a packet failing to decrypt destroys it). Opus → 48 kHz stereo → 24 kHz mono. A segment ends after `SEGMENT_GAP_MS` without packets or at `SEGMENT_MAX_MS`; short or digitally silent segments are never sent.
- **Transcript**: in memory only, `{ at, name, text }` in arrival order (sorted on output). A crash loses the session: accepted. The name is the Discord member, often a whole table.
- **Wake word**: a sentence starting with the bot's server display name (fuzzy, see `addressesBot`). The name is read at session start, never configured.
- **GPT-Live** (`gpt-live-1`) is billed per second open, so a `Conversation` exists only around an exchange: opened on the wake word, closed after `LIVE_IDLE_MS` without output audio (`LIVE_DELEGATION_TIMEOUT_MS` while a search runs). It hears only the speaker who said the wake word, starting with a replay of the segment holding it (drained at up to 3× speed). Its input is a continuous stream paced at 20 ms, silence filled in: Discord sends nothing while nobody talks, and GPT-Live needs that silence to end a turn. The startup history is capped at 8,192 rendered tokens by default, hence the character caps in `conversation.js`. Its spoken text joins the transcript under the bot's name once the call has finalized (`session.closed`).
- **Rules searches** run on OpenAI's side (Responses delegation: `gpt-6.2-sol`, xhigh, `priority` tier, `web_search`). The client only reads the nested `response.output_item.done` / terminal events to post the answer and its `url_citation` sources.
- **Audio out**: the primary WebSocket has no end-of-audio or interruption event. `Speaker` opens one Opus resource per burst and ends it once drained and quiet; a resource the player dropped (too many missed frames) is replaced on the next chunk. Barge-in therefore cannot flush audio already queued.
- **End**: `/boardy` again, 30 min alone in the channel, or a lost voice connection (Disconnected for 5 s, any other non-Ready state for 30 s). The bot leaves at once, then waits for pending transcriptions and finalizing conversations, then summarizes. A failed summary posts the transcript as a file: it is the only copy.

## Discord messages

- Campaign context = the bot's own messages in the channel (summaries, search answers), read back without the Message Content intent. Interaction replies and messages starting with `-# ` (notices) are excluded: any bot message that is not campaign context must be one of those.
- All sends suppress embeds and mentions.
- Summaries use a Responses call in background mode with polling: xhigh reasoning can outlast an HTTP request.

## Config

`.env` (see `.env.example`): `DISCORD_TOKEN`, `OPENAI_API_KEY`. `.env` is gitignored — the repository is public.

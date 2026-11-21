# Boardy

A Discord voice bot for long, story-driven board games played around a table, sessions weeks apart.

- `/boardy` in a voice channel's chat (or while connected to one) brings the bot in. The channel name is the game.
- On joining, it reads the previous session's summary aloud, in a theatrical tone, until someone says its name.
- It transcribes the whole session (in memory, never recorded to disk).
- Start a sentence with its name to ask a rules question: it answers by voice through GPT-Live, after a web search of the rules when needed.
- `/boardy` again ends the session: the bot leaves and posts a summary of the session in the channel chat, written with the previous summaries as context.

The prompts and messages are in French.

## Requirements

- Node.js 22+, on Linux. On ARM64 with GCC ≥ 14, build `@discordjs/opus` with `CFLAGS="-Wno-error=implicit-function-declaration" npm install`.
- An OpenAI API key with access to `gpt-transcribe`, `gpt-live-1`, `gpt-4o-mini-tts` and `gpt-6.2-sol`. Typical cost: a few dollars per 5-hour session, mostly rules searches.

## Discord application

In the [Developer Portal](https://discord.com/developers/applications):

1. **New Application**. The bot's server display name is the wake word.
2. **Bot**: *Reset Token* and copy it to `DISCORD_TOKEN`. *Public Bot* off. No privileged intent.
3. **Installation**: *Guild Install* only, *Discord Provided Link*, scopes `bot` and `applications.commands`, permissions *View Channels*, *Connect*, *Speak*, *Send Messages*, *Attach Files*, *Read Message History*.
4. Open the install link and add the bot to your server. To restrict who can use `/boardy`: *Server Settings → Integrations*.

## Install

```bash
git clone https://github.com/baptistefetet/boardy.git
cd boardy
npm install
cp .env.example .env    # fill in DISCORD_TOKEN and OPENAI_API_KEY
npm start
```

## Tips

- On the phone in the voice channel, keep echo cancellation on, so the bot does not hear itself.
- Lower noise suppression if distant voices get lost.

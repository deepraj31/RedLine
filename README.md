# REDLINE — Audio Library

An audio-library website built with Express and vanilla JavaScript. Local development uses SQLite; the hosted app uses Turso for records and Cloudflare R2 for audio files.

## What it does

- Creates accounts and signs users in with secure, HTTP-only session cookies.
- Restricts audio uploads to signed-in users.
- Lets each signed-in uploader open a profile dashboard, update their own track details (including upload date and replacement file), or delete their own tracks.
- Accepts audio files reported by the browser as `audio/*`, including common MP3, WAV, OGG/Opus, M4A/AAC, FLAC, AIFF, WMA, ALAC, AMR, MIDI, and 3GP variants up to 30 MB.
- Streams uploaded audio in the browser and provides direct file downloads.
- Stores track title, artist, category, description, original filename, file size, uploader, upload date, listen count, and download count.
- Starts with an empty catalog—there are no generated demo tracks.

## Requirements

- Node.js 24 or newer for local development
- npm

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

On the first start, the app creates:

- `redline.sqlite` — local users, sessions, and song metadata database
- `uploads/` — private stored audio files

Both are ignored by Git, so uploaded content and local account data are not committed.

## Deploy to Vercel

Vercel serves `public/` and the native catch-all function in `api/[...path].js`. It does not run `scripts/local.cjs`.

Set these Production environment variables in Vercel, without quotes:

```text
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
```

For browser-to-R2 uploads, configure the R2 bucket CORS policy to allow your Vercel domain and `http://localhost:3000` for `GET`, `HEAD`, and `PUT` requests with the `Content-Type` header.

## API summary

- `POST /api/signup` and `POST /api/login`
- `POST /api/logout`, `GET /api/me`
- `GET /api/songs`, `POST /api/songs`
- `POST /api/songs/:id/listen`
- `GET /api/songs/:id/stream`
- `GET /api/songs/:id/download`

Each stream and download endpoint updates its corresponding song metric.

# REDLINE — Audio Library

An audio-library website built with Express, vanilla JavaScript, and SQLite.

## What it does

- Creates accounts and signs users in with secure, HTTP-only session cookies.
- Restricts audio uploads to signed-in users.
- Lets each signed-in uploader open a profile dashboard, update their own track details (including upload date and replacement file), or delete their own tracks.
- Accepts audio files reported by the browser as `audio/*`, including common MP3, WAV, OGG/Opus, M4A/AAC, FLAC, AIFF, WMA, ALAC, AMR, MIDI, and 3GP variants up to 30 MB.
- Streams uploaded audio in the browser and provides direct file downloads.
- Stores track title, artist, category, description, original filename, file size, uploader, upload date, listen count, and download count in SQLite.
- Starts with an empty catalog—there are no generated demo tracks.

## Requirements

- Node.js 24 or newer (the app uses Node's built-in SQLite support)
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

## API summary

- `POST /api/signup` and `POST /api/login`
- `POST /api/logout`, `GET /api/me`
- `GET /api/songs`, `POST /api/songs`
- `POST /api/songs/:id/listen`
- `GET /api/songs/:id/stream`
- `GET /api/songs/:id/download`

Each stream and download endpoint updates its corresponding song metric.

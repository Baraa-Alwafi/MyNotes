# MyNotes

MyNotes is a personal-use productivity app for keeping tasks, notes, and calendar events together. It is built as a desktop app with Electron, React, and TypeScript.

## Features

- Organize tasks by due date, category, priority, and completion status.
- Create and edit notes.
- View tasks, recent note activity, and calendar events in a monthly calendar.
- Import calendar events from an `.ics` file.
- Subscribe to an HTTP(S) or webcal calendar feed and refresh it when the desktop app opens.
- Keep tasks, notes, and calendar data saved locally on your device.

## Personal use and privacy

This project is intended for personal use, not as a multi-user or hosted service. MyNotes does not require an account. App data is stored locally in the app's browser storage. When you subscribe to a calendar feed, MyNotes requests that feed to retrieve events; the saved feed link is also kept locally on your device. Treat calendar feed links as private and do not publish them.

## Requirements

- Node.js
- Yarn

## Get started

Install dependencies:

```bash
yarn
```

Run the desktop app in development:

```bash
yarn dev
```

## Build

Build the app for your platform:

```bash
# Windows
yarn build:win

# macOS
yarn build:mac

# Linux
yarn build:linux
```

Run linting and type checks:

```bash
yarn lint
yarn typecheck
```

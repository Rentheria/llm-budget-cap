# Contributing

## Development Setup

1. Install dependencies:

```bash
npm install
```

2. Start Redis on port **6399** for local testing:

```bash
docker run --rm -p 6399:6379 redis:7-alpine
```

The test suite uses `REDIS_URL` (default: `redis://127.0.0.1:6399`).

## Running Tests

```bash
npm test
```

**Important:** Tests run with a **single worker** (`singleFork: true` in vitest.config.ts). The atomicity tests require a real Redis instance and cannot run in parallel.

## Code Quality

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript check
npm run format      # Format code
npm run format:check # Check formatting
```

## Building

```bash
npm run build       # tsup → ESM + CJS + types
```

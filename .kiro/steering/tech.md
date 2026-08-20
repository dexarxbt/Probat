# Technical Direction

- TypeScript and Node.js with strict compiler settings.
- Fastify provides a local HTTP API.
- Zod validates external input and persisted records.
- File-backed JSON storage keeps setup deterministic and payment-free.
- Kane CLI is invoked as a child process without shell interpolation.
- Scripted Kane commands always use `--agent`; automation relies on the terminal `run_end` event and process exit code.
- Persistent browser tests are committed as `*_test.md` files.
- Raw `.evidence` packs and credentials are never committed.
- No application database or paid API is required.

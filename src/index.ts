import { startServer } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT ?? '3000'}`);
  process.exit(1);
}

try {
  await startServer({ port, host });
} catch (err) {
  console.error(err);
  process.exit(1);
}

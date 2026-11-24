import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { openDatabase, seedDatabaseIfEmpty } from './server/db.ts';
import { createRealtimeHub } from './server/realtime.ts';
import { createApp } from './server/app.ts';
import { runAutomatedQASuite } from './server/qa-runner.ts';

async function bootstrap() {
  const PORT = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  const db = openDatabase();
  seedDatabaseIfEmpty(db, false);

  const server = http.createServer();
  const realtime = createRealtimeHub(server, db);
  const apiApp = createApp(db, realtime, {
    runQaHandler: () => runAutomatedQASuite(),
  });

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    apiApp.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    apiApp.use(express.static(distDir));
    apiApp.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.on('request', apiApp);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Restaurant 360° running on http://0.0.0.0:${PORT} (${isProd ? 'production' : 'development'})`);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});

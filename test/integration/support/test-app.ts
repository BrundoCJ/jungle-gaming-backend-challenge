import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { APP_CONFIG, loadConfig } from '../../../src/platform/config/app-config';
import { configureHttpApp } from '../../../src/platform/http/configure-http-app';
import type { TestDatabase } from './test-database';

export interface TestApp {
  app: NestExpressApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/** Boots the real application (all modules) against an isolated test database. */
export async function startTestApp(
  db: TestDatabase,
  env: Record<string, string> = {},
): Promise<TestApp> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: db.url,
    ...env,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureHttpApp(app);
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;

  return { app, baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

/** Minimal JSON client for the app under test. */
export function apiClient(baseUrl: string) {
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as T,
      headers: response.headers,
    };
  }
  return {
    get: <T = Record<string, unknown>>(path: string) => call<T>('GET', path),
    post: <T = Record<string, unknown>>(
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => call<T>('POST', path, body, headers),
  };
}

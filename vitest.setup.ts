// Test-time environment defaults. Real .env.local is intentionally NOT loaded
// so unit tests stay deterministic. Integration suites that need a live DDB
// rely on these defaults pointing at docker-compose's DynamoDB Local.

if (!process.env.NODE_ENV) {
  Object.assign(process.env, { NODE_ENV: "test" });
}
process.env.BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET ?? "test-secret-1234567890-abcdefghijklmnop";
process.env.AWS_REGION = process.env.AWS_REGION ?? "ap-northeast-2";
process.env.DYNAMODB_TABLE_NAME = process.env.DYNAMODB_TABLE_NAME ?? "app-main-test";
process.env.DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "local";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "local";
process.env.NEXT_PUBLIC_BETTER_AUTH_URL =
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_NAME =
  process.env.NEXT_PUBLIC_APP_NAME ?? "Next.js Tailwind Starter (test)";

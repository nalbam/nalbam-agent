# Changelog

All notable changes to this template are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Google OAuth on `/login` + `/signup` via Better Auth `socialProviders.google`, gated server-side on `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` and client-side on `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED`. Button lives at `src/app/(auth)/google-button.tsx` and uses the bundled `public/images/google.png` asset.
- Email/password auth toggle (`AUTH_EMAIL_ENABLED` server / `NEXT_PUBLIC_AUTH_EMAIL_ENABLED` UI), defaults to enabled. Auth pages render correctly for any combination of the two methods, including a fallback when both are disabled.
- DynamoDB single-table Better Auth adapter (`src/lib/auth/dynamodb-adapter.ts`)
- Upstash Redis (prod) / Valkey (dev) `secondaryStorage` adapter with auto fallback
- zod-validated env (`src/lib/env.ts`) with lazy server resolution
- Auth demo flows: `/login`, `/signup`, `/dashboard`, with cookie-based middleware guard
- App Router essentials: `error.tsx`, `not-found.tsx`, `loading.tsx`, `/api/health`
- SEO/PWA: `sitemap.ts`, `robots.ts`, `manifest.ts`, `opengraph-image.tsx`
- shadcn/ui primitives: `input`, `label`, `card`, `alert`, `sonner`
- Pretendard variable font via `next/font/local` with postinstall copy script
- `docker-compose.yml` (DynamoDB Local + Valkey + admin UI) and `pnpm db:init` provisioning script
- Vitest unit + integration test harness (`vitest.setup.ts`, `vitest.config.ts`)
- Husky + lint-staged + commitlint with conventional commits
- GitHub Actions CI (DynamoDB Local + Valkey service containers) and Dependabot
- Amplify deploy assets: `amplify.yml`, IAM policy + env mapping in `docs/amplify-deploy.md`
- `LICENSE` (MIT), `SECURITY.md`, `CODEOWNERS`, `.nvmrc`, `.editorconfig`, `.vscode/`

### Changed
- Next.js 16 (App Router) — Amplify Hosting fix rolled out 2026-02-11 makes 16.1+ work on App Router, see `docs/amplify-deploy.md`
- `tsconfig.json` strict family hardened: `noUncheckedIndexedAccess`, `noImplicitOverride`, `target: ES2022`
- `next.config.ts` ships baseline security headers (HSTS, XCTO, Referrer-Policy, Permissions-Policy, X-Frame-Options)
- Design tokens in `globals.css` are now the single source of truth; layout/page no longer use raw slate colors

### Removed
- Unused `public/file.svg` and `public/globe.svg`

### Upgraded — major dev tooling
- TypeScript 5 → **6.0** (target/module defaults are now ES2023/ESNext upstream; we keep them pinned in `tsconfig.json` so behavior is unchanged)
- Vitest 2 → **4.1** (requires Vite 6, now an explicit `devDependency`)
- Sonner 1 → **2.0** (no API call sites changed)
- lint-staged 15 → **16**
- `@commitlint/{cli,config-conventional}` 19 → **20**
- dotenv 16 → **17**
- React 19.2.4 → **19.2.6** (patch)
- `@types/node` 20 → **22** (matched to runtime)

### Held back
- **ESLint 9 → 10** — blocked until `eslint-plugin-react` adds ESLint 10 support (currently transitively required by `eslint-config-next`, peers cap at `^9.7`). ESLint 9.x EOL is **2026-08-06**; revisit before then.

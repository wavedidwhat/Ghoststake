# GhostStake — Frontend

Next.js 16 (App Router, Turbopack) frontend for GhostStake, an on-chain staking
product on **Arbitrum**.

Backend lives in [`../ghoststake-backend`](../ghoststake-backend).

## Running

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

## Typography

`shadcn/typeset` styles rendered markdown. Wrap a markdown surface and
everything inside it is styled with no classes on the content itself:

```tsx
<div className="typeset typeset-docs max-w-[37em]">
  {content}
</div>
```

The stylesheet is [`src/app/typeset.css`](src/app/typeset.css); the
`.typeset-docs` preset is defined in [`src/app/globals.css`](src/app/globals.css)
and wired to the Geist variables already loaded in the root layout.

Add `not-typeset` (or `data-not-typeset`) to any embedded component that should
opt out.

## Docker

```bash
docker compose up --build      # http://localhost:3000
```

`docker-compose.yml` publishes **no host ports** — on the VPS, Traefik routes to
the container over the shared proxy network. `docker-compose.override.yml` adds
the local port binding and is auto-loaded only for a bare `docker compose up`,
never for a deploy that passes `-f` explicitly.

The image uses Next's `output: "standalone"` on `node:22-alpine`, running as a
non-root user (~216MB).

> Note: the build installs with `pnpm --config.node-linker=hoisted`. pnpm's
> default symlinked `node_modules` breaks standalone output tracing — the
> container starts and then dies on a missing transitive dependency.

## Remote deploys

Handled by Remote Dev Kit; config is in `.env.remote`. Deploys to
`ghoststake.dev.wavedidwhat.com` behind Traefik with TLS.

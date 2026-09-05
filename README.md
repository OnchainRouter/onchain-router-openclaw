# Onchain Router for OpenClaw

Use Onchain Router as a native OpenClaw model provider while keeping payment authority in the
human-owned local Buyer Runtime. The extension discovers the models allowed by local policy and
connects OpenClaw to the authenticated OpenAI-compatible proxy on `127.0.0.1`.

## Release status

Version `0.2.0` is the stable public release. The source is public and installable directly from the
versioned GitHub release. Installation, build, and fake-loopback tests do not unlock a wallet, make
a paid request, deploy a service, or spend USDC. Funded OpenClaw acceptance remains an explicit
operator test because it spends from the operator's Buyer Runtime wallet.

ClawHub publication is a separate registry-review step. The pinned GitHub installation below works
without waiting for that listing.

## What it does

- registers the official OpenClaw provider and unified live model-catalog surfaces;
- returns only policy-filtered chat models from the local proxy;
- registers read-only model, pricing, and voice discovery tools;
- registers bounded image generation, MP3 speech, and MP3 transcription tools that require a
  caller-supplied stable idempotency key before a paid request can start;
- provides an authenticated `/onchain-router` command for status, redacted diagnostics, discovery,
  and same-key recovery guidance;
- attaches a deterministic Buyer Runtime idempotency key to every host retry of one transport
  turn, without hashing prompt or completion content;
- reuses an already healthy proxy or starts the exact installed
  `@onchainrouter/proxy@0.2.0` package as an OpenClaw service;
- stops only the proxy child it started;
- keeps registration lazy and free of file, network, process, wallet, and payment side effects.

It does not create, import, read, unlock, fund, or back up a wallet. It does not implement x402,
connect directly to production, add a payment network, download a package at runtime, retry a paid
request, or select an automatic fallback. The only secret it reads is the owner-only non-wallet
proxy bearer.

## Requirements

- Node.js `>=24.15.0 <25`;
- OpenClaw `2026.8.1`;
- macOS or Linux;
- an Onchain Router Buyer Runtime profile created by a human;
- the exact `@onchainrouter/proxy@0.2.0` dependency installed with this extension.

## Install

Review the [security model](./SECURITY.md), then install the immutable `v0.2.0` release with
OpenClaw's native plugin manager:

```bash
openclaw plugins install git:github.com/OnchainRouter/onchain-router-openclaw@v0.2.0 --force
openclaw plugins enable onchain-router --accept-capabilities
openclaw plugins inspect onchain-router --runtime --json
```

`--force` acknowledges that GitHub is an external source; it does not bypass OpenClaw's install
policy or capability consent. The tag is pinned so a later repository update cannot silently
replace the reviewed release. Use `openclaw plugins update onchain-router` only after reviewing a
new Onchain Router release.

## Build from source

```bash
corepack enable
pnpm install --ignore-scripts
pnpm check
pnpm qualification:clean-install
```

The lifecycle qualification builds and packs this repository, installs the archive through
OpenClaw's managed plugin installer in a temporary state directory, inspects the loaded runtime,
disables and re-enables it, repeats the install as an update, performs an uninstall dry run, and
then uninstalls it. It removes only that temporary state and makes no paid request.

## Setup

Create and unlock the Buyer Runtime from a human terminal before asking OpenClaw to use a paid
model:

```bash
onchain-router setup
onchain-router unlock
```

The GitHub installation above uses OpenClaw's managed plugin installer. Review and accept its
declared local-file/process capabilities, then enable the `onchain-router` plugin. The default
local boundary is:

```text
proxy origin:      http://127.0.0.1:8402
profile directory: ~/.onchain-router
token file:        ~/.onchain-router/proxy-token
managed proxy:     true
```

Choose an `onchain-router/<model-id>` entry returned by the live picker. The Buyer Runtime still
enforces its model, amount, session, hourly, daily, recipient, network, and confirmation policy.

The chat picker filters out image and audio entries from the same multimodal catalog. Output-token
limits are not reported as context-window sizes: absent verified context metadata, that optional
host field is left unset. The catalog request is bounded through the full response download.

Inside OpenClaw, use `/onchain-router help`. The native agent tools are:

| Tool | Cost | Purpose |
|---|---:|---|
| `onchain_router_models` | Free | Live policy-filtered model catalog |
| `onchain_router_pricing` | Free | Current pass-through model pricing |
| `onchain_router_voices` | Free | Speech voice catalog |
| `onchain_router_image_generate` | Paid | Image generation with a hosted URL that expires after seven days |
| `onchain_router_speech_generate` | Paid | MP3 speech generation |
| `onchain_router_transcribe` | Paid | Bounded MP3 transcription after retention acknowledgement |

Paid tools do not derive a financial identity from prompt content or silently create one. Supply
`idempotency_key` once per logical operation, and reuse it only with the identical request when the
Buyer Runtime explicitly permits recovery.

To run the proxy yourself, set `manageProxy` to `false` in the plugin configuration and start it
in a human terminal:

```bash
onchain-router-proxy --profile "$HOME/.onchain-router" --port 8402
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `proxyOrigin` | `http://127.0.0.1:8402` | Exact credential-free loopback HTTP origin |
| `tokenFile` | `~/.onchain-router/proxy-token` | Owner-only non-wallet bearer file |
| `profileDirectory` | directory containing `tokenFile` | Buyer Runtime profile used by a managed proxy |
| `manageProxy` | `true` | Reuse or start the exact installed proxy dependency |

When `manageProxy` is true, `tokenFile` must be `<profileDirectory>/proxy-token`. Custom origins
must remain exact `127.0.0.1` HTTP origins. `localhost`, LAN addresses, credentials in URLs,
paths, query strings, fragments, and trailing slashes are rejected.

## Paid-request safety

- Keep a dedicated low-balance wallet and conservative human-owned policy.
- Do not configure model fallbacks for this provider. A failed or ambiguous paid call requires
  human review and same-key recovery, not a new model attempt. OpenClaw retries of the same
  transport turn carry one Buyer Runtime idempotency key and cannot become a second financial
  operation.
- Never expose the local proxy through a tunnel, reverse proxy, container host bind, or LAN port.
- Keep the bearer file at mode `0600`; never paste it into prompts, logs, screenshots, or source.
- Treat model output as untrusted. It cannot change origin, recipient, network, asset, or budget.

## Troubleshooting

- Installation fails: use OpenClaw `2026.8.1`, confirm Git and Node.js 24 are installed, and inspect
  `openclaw plugins doctor --json`.
- Provider has no models: run `onchain-router doctor`, confirm the Buyer Runtime is unlocked, and
  restart OpenClaw.
- Proxy cannot start: verify port `8402` is free and the exact proxy dependency is installed.
- Bearer rejected: confirm the token is a regular, non-symlink file owned by the current user with
  mode `0600`.
- Ambiguous or `409` result: do not retry with a new key or model. Inspect Buyer Runtime receipts
  and recover with the original key and identical request.
- In-chat checks: run `/onchain-router doctor`; it reports only redacted package, bearer-file, and
  proxy readiness facts.
- Manual proxy mode fails: start `onchain-router-proxy` before selecting the provider.

Documentation: <https://onchainrouter.dev/docs/openclaw>

Support: <https://github.com/OnchainRouter/onchain-router-openclaw/issues>

Security reports: <https://github.com/OnchainRouter/onchain-router-openclaw/security/policy>

## License

MIT. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

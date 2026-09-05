# Changelog

## Unreleased

- Load the chat picker from a mixed text/image/audio proxy catalog without rejecting valid media entries.
- Reject duplicate chat IDs and malformed endpoint lists.
- Keep the catalog timeout active until the response body finishes downloading.
- Stop misreporting the model's output-token budget as its context window.
- Preserve stable turn idempotency and no-store behavior; no wallet or payment implementation changes.

## 0.2.0 - 2026-09-04

- Updated the managed Onchain Router buyer proxy dependency to stable npm release `0.2.0`.
- Moved documentation and provider metadata to `https://onchainrouter.dev`.
- Promoted the GitHub distribution from the bounded alpha channel to the stable release channel.
- Added a pinned, host-native GitHub install path and post-install setup guidance.
- Added distribution metadata validation so release copy cannot drift back to an unpublished
  source-candidate claim.
- Versioned the small built runtime required by OpenClaw's Git installer and marked the host peer
  optional so npm does not install a second OpenClaw runtime inside the plugin.
- Added an official-host regression test that installs the exact current Git commit before release.
- Pinned patched `esbuild` `0.28.1` across the development toolchain.

## 0.1.0 - public-alpha candidate

- Added the native OpenClaw text provider and live policy-filtered catalog.
- Added deterministic per-turn idempotency across host transport retries.
- Added read-only model, pricing, and voice tools.
- Added bounded image, speech, and transcription tools over Buyer Runtime.
- Added authenticated status, doctor, discovery, and recovery commands.
- Added fixed-version proxy supervision with cancellation-safe shutdown and no automatic restart.
- Added clean install, update, disable/enable, inspection, and uninstall qualification.
- Kept wallet keys, x402 signing, policy, settlement, receipts, and recovery out of the adapter.

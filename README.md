# fctv

a stremio addon for live sports events, sorted by league. serie a matches go under serie a, premier league under premier league, and so on.

this project does not host any video. it reads the public catalog of the fctv77 app and resolves streams at playback time.

## usage

1. start the addon and open the main page (`/`) in your browser.
2. pick a language. this only changes team and league names, not the videos.
3. optionally, enter your easyproxy url and password.
4. click "install in stremio" or copy the manifest url and paste it into stremio's addon search.

language and proxy settings are encoded in the manifest url (`/c/<config>/manifest.json`). the proxy password is therefore part of the url: do not share it.

## running

```bash
cp .env.example .env
npm install
npm start
```

default port is 7070. requires node 18 or higher.

## video and proxy

the cdn requires a specific referer header and does not respond well to stremio's direct requests, so streams cannot be handed straight to the player. there are two ways to handle this:

- **internal proxy** (default). the addon fetches playlists and segments and pipes them to stremio. video passes through your server, so it uses your bandwidth and cpu. links are hmac-signed, expire, and reject private ip addresses.
- **easyproxy** (https://github.com/realbestia1/EasyProxy). video goes through your easyproxy and does not load the addon at all. configure it from the main page, or server-side with `EASYPROXY_URL`.

if you set `EASYPROXY_REQUIRED=true`, the internal proxy is disabled and streams are only served with an easyproxy — either the server-level one or the one the user enters on the page.

## deploying

set at least these variables:

```
NODE_ENV=production
PUBLIC_BASE_URL=https://addon.example.com
HLS_SECRET=<openssl rand -hex 32>
ACCESS_KEY=<16-128 chars [A-Za-z0-9_-]>
TRUST_PROXY=1
```

- `PUBLIC_BASE_URL` is required in production and is the public origin with no trailing path.
- `HLS_SECRET` signs proxy links. keep it stable across restarts, or in-flight streams will break.
- `ACCESS_KEY` puts everything under `/<key>/`, so the manifest becomes `https://addon.example.com/<key>/manifest.json`. it deters scanners, not anyone who has the link.
- `TRUST_PROXY` is needed behind a reverse proxy, otherwise rate limiting sees a single ip.
- run the addon behind https.

## variables

| variable | description |
| --- | --- |
| `PORT`, `HOST` | port (7070) and bind address |
| `PUBLIC_BASE_URL` | public origin of the addon |
| `ACCESS_KEY` | secret prefix for all routes |
| `HLS_SECRET`, `HLS_TTL_MS` | signing key and ttl for internal proxy links |
| `EASYPROXY_URL`, `EASYPROXY_PASSWORD` | easyproxy used for all users |
| `EASYPROXY_REQUIRED` | easyproxy only, internal proxy disabled |
| `ADMIN_TOKEN` | enables `/debug/*` (header `Authorization: Bearer <token>`) |
| `RATE_LIMIT_API_MAX`, `RATE_LIMIT_PROXY_MAX` | requests per minute per ip |
| `PROXY_MAX_CONCURRENCY` | concurrent requests for the internal proxy |
| `FCTV77_DIGIT`, `FCTV77_CONTINENT`, `FCTV77_COUNTRY` | parameters sent to `stream/detail` (seth, eu, it) |
| `FCTV77_PLAYER_REFERER` | override the referer expected by the cdn |

the full list with example values is in `.env.example`.

## diagnostics

- `/health` returns `ok` only.
- `/debug/catalog`, `/debug/stream/...` and `/debug/health` are available only with `ADMIN_TOKEN`.

## what can break

the addon depends on an unofficial service. domains are re-fetched every five minutes from firebase, but these are not auto-updated:

- the `digit`, `continent` and `country` parameters for `stream/detail`;
- the referer expected by the cdn;
- the aes key used to sign stream urls.

if any of these change, streams will return 401 or 403. some cdns may not work from certain countries or datacenter ip ranges.

## notes

the addon does not host or generate any content. streams come from third parties: use it at your own risk, and check the relevant terms of service before making it public.

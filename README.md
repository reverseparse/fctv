# fctv

addon stremio per eventi sportivi live, ordinati per lega. le partite di serie a stanno nella categoria serie a, quelle della premier league nella premier league, e così via.

questo progetto non ospita nessun video. legge il catalogo pubblico dell'app fctv77 e risolve i flussi al momento della riproduzione.

## come si usa

1. avvia l'addon e apri la pagina principale (`/`) nel browser.
2. scegli la lingua. cambia solo i nomi di squadre e leghe, non i video.
3. se vuoi, inserisci il tuo easyproxy (url e password).
4. premi "installa in stremio" oppure copia il manifest e incollalo nella ricerca addon di stremio.

lingua e proxy finiscono dentro l'url del manifest (`/c/<config>/manifest.json`). la password del proxy è quindi nell'url: non condividerlo.

## avvio

```bash
cp .env.example .env
npm install
npm start
```

la porta predefinita è 7070. serve node 18 o superiore.

## video e proxy

il cdn richiede un referer e risponde in modo anomalo alle richieste di stremio, quindi i flussi non si possono dare direttamente al player. ci sono due modi:

- proxy interno (predefinito). l'addon scarica playlist e segmenti e li rigira a stremio. il video passa tutto dal tuo server, quindi consuma banda e cpu. i link sono firmati con hmac, scadono e rifiutano indirizzi privati.
- easyproxy (https://github.com/realbestia1/EasyProxy). il video passa dal tuo easyproxy e non pesa sull'addon. si imposta dalla pagina principale, oppure sul server con `EASYPROXY_URL`.

se imposti `EASYPROXY_REQUIRED=true` il proxy interno viene spento e gli stream escono solo con un easyproxy: o quello del server, o quello inserito dall'utente nella pagina.

## deploy su internet

imposta almeno queste variabili:

```
NODE_ENV=production
PUBLIC_BASE_URL=https://addon.example.com
HLS_SECRET=<openssl rand -hex 32>
ACCESS_KEY=<16-128 caratteri [A-Za-z0-9_-]>
TRUST_PROXY=1
```

- `PUBLIC_BASE_URL` è obbligatoria in produzione ed è l'origine pubblica senza percorso.
- `HLS_SECRET` firma i link del proxy. tienila uguale tra i riavvii, altrimenti gli stream aperti smettono di funzionare.
- `ACCESS_KEY` mette tutto sotto `/<chiave>/`, quindi il manifest diventa `https://addon.example.com/<chiave>/manifest.json`. protegge dagli scanner, non da chi ha il link.
- `TRUST_PROXY` serve dietro un reverse proxy, altrimenti il rate limit vede un solo ip.
- metti l'addon dietro https.

## variabili

| variabile | cosa fa |
| --- | --- |
| `PORT`, `HOST` | porta (7070) e indirizzo di ascolto |
| `PUBLIC_BASE_URL` | origine pubblica dell'addon |
| `ACCESS_KEY` | prefisso segreto per tutte le rotte |
| `HLS_SECRET`, `HLS_TTL_MS` | firma e durata dei link del proxy interno |
| `EASYPROXY_URL`, `EASYPROXY_PASSWORD` | easyproxy usato da tutti gli utenti |
| `EASYPROXY_REQUIRED` | solo easyproxy, proxy interno spento |
| `ADMIN_TOKEN` | abilita `/debug/*` (header `Authorization: Bearer <token>`) |
| `RATE_LIMIT_API_MAX`, `RATE_LIMIT_PROXY_MAX` | richieste al minuto per ip |
| `PROXY_MAX_CONCURRENCY` | richieste contemporanee del proxy interno |
| `FCTV77_DIGIT`, `FCTV77_CONTINENT`, `FCTV77_COUNTRY` | parametri mandati a `stream/detail` (seth, eu, it) |
| `FCTV77_PLAYER_REFERER` | forza il referer accettato dal cdn |

l'elenco completo, con i valori di esempio, è in `.env.example`.

## diagnostica

- `/health` risponde solo `ok`.
- `/debug/catalog`, `/debug/stream/...` e `/debug/health` esistono solo con `ADMIN_TOKEN`.

## cosa può rompersi

l'addon dipende da un servizio non ufficiale. i domini si rileggono ogni cinque minuti da firebase, ma questi punti non si aggiornano da soli:

- i parametri `digit`, `continent` e `country` di `stream/detail`;
- il referer accettato dal cdn;
- la chiave aes del token negli url degli stream.

se cambiano, gli stream rispondono 401 o 403. alcuni cdn possono non funzionare da certi paesi o da ip di datacenter.

## note

l'addon non ospita né genera contenuti. i flussi arrivano da terze parti: l'uso è a tuo carico, e vale la pena controllare i termini del servizio prima di metterlo pubblico.

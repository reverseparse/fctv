# FCTV77 Stremio addon v0.9.10

Addon Stremio per il catalogo live FCTV77, con discovery dei domini tramite Firebase Firestore e risoluzione degli stream tramite `/api/stream/detail`.

## Cosa cambia in v0.9.4

La versione precedente si fermava alla risposta di `/api/common/bs`. L'APK mostra che questa chiamata **non** restituisce direttamente le partite: restituisce `PBBodySignatureResp`, da cui il repository ricava la versione per il codice `100`. Solo dopo viene invocato l'endpoint `/sfver{params}{version}/api/match/live`.

Il flusso implementato ora replica `MatchRepository.getLiveGame()`:

1. GET `/api/common/bs?code=100&sportType=<n>&stream=true&cachePriority=false`.
2. Legge `PBResponse.data` (field 10) e la mappa `PBBodySignatureResp.kvMap`; seleziona la voce con chiave `100` e usa il valore come `version`.
3. Calcola `MD5("language=<language>&sportType=<sport>&stream=true")`; applica l'helper dell'APK che concatena il codice `100` all'hash MD5 per ottenere `params` (`100<md5>`).
4. GET `/sfver{params}{version}/api/match/live?language=<language>&sportType=<sport>&stream=true`.
5. Legge `PBResponse.data` (field 10), quindi `PBMatchLiveResp.match` (field 1) e `.stream` (field 2), unendo le voci tramite `matchId`.

L'APK enum `PBLanguage` assegna `8` a `L_IT`, usato come valore predefinito. Il catalogo prova prima `sportType=0` (vista aggregata); se non trova partite con stream, interroga in sequenza i 16 sport presenti nell'app. Le richieste sequenziali e la pausa configurabile riducono il rischio di HTTP 429.

## Discovery automatico dei domini

Il progetto legge il documento Firestore `foth_APP_KVS/params_production` del progetto Firebase `rbapp-672ea` e usa i campi `DATA_API`, `DATA_API_EU`, `LIVE_API` e `LIVE_API_EU`. I valori remoti validi hanno precedenza sugli URL fallback in `.env`. Il refresh viene eseguito all'avvio e ogni cinque minuti.

## Avvio

```bash
cp .env.example .env
npm install
npm start
```

Configura Stremio con `http://<host>:7000/manifest.json`.

## Diagnostica

- `/health`: stato del server e domini selezionati.
- `/debug/catalog`: esegue il flusso firma + match/live per la vista aggregata e per ogni sport; restituisce stato HTTP, byte, versione e conteggi protobuf.

## Variabili principali

- `FCTV77_LIVE_CODE=100`
- `FCTV77_LANGUAGE=8` (`L_IT`)
- `FCTV77_REQUEST_DELAY_MS=900`
- `FCTV77_CATALOG_TIMEOUT_MS=15000`
- `FCTV77_CATALOG_CACHE_MS=30000`

La verifica effettuata qui è statica sull'APK e sui protobuf diagnostici precedenti. L'ambiente di build non ha accesso DNS/rete verso i server FCTV77, quindi il nuovo endpoint live non è stato collaudato contro il servizio remoto in questa sessione. Il log di `/debug/catalog` consentirà di verificare la risposta reale dopo il deploy.


## v0.9.4 parser hardening

Protobuf scalar readers now check the wire type before decoding. This prevents a varint field from being passed to `TextDecoder.decode()`, which caused the runtime error `The list argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.`


## v0.9.4 diagnostics

Adds candidate protobuf field counts, wire-type distributions, and nested samples for fields 1 and 2 of the live response. This identifies the actual stream message layout without logging complete stream URLs or large binary payloads.


## Diagnostica protobuf v0.9.4

La diagnostica `/debug/catalog` include ora i valori numerici dei campi wire-type 0 nei campioni e mette in evidenza i candidati 2, 5 e 9 di ogni stream, oltre al campo 50 (matchId). Serve a identificare i tag corretti di streamId e siteType senza supposizioni. La versione esposta da manifest, health e debug è allineata a 0.9.4.


## v0.9.4: recupero degli stream reali

La risposta `/api/match/live` contiene riferimenti stream con `sportType` (field 2), `streamStatus` (field 5) e `matchId` (field 50), ma non valorizza `streamId` (field 1) né `siteType` (field 9). L'APK definisce inoltre `MATCH_DETAIL_CODE=102` e usa `/sfver{params}{version}/api/match/detail`; la risposta `PBMatchDetailResp` espone `match` (field 1) e `stream` (field 2).

La v0.9.4 usa quindi i riferimenti live per richiedere il dettaglio della singola partita e cercare i `PBDataStream` completi, senza inventare uno streamId. `/api/stream/detail` viene invocato con GET e query parameters, come dichiarato dall'interfaccia Retrofit dell'APK. `/debug/catalog` prova due dettagli campione e mostra gli stream ottenuti.


## v0.9.5: gestione del rate limit

I test reali della v0.9.4 hanno confermato che `/api/match/detail` restituisce gli stream completi (streamId, siteType e nome). La v0.9.5 mantiene questa decodifica e rende meno aggressivo il recupero: due richieste di dettaglio contemporanee, intervallo predefinito di 900 ms per worker e fino a due retry aggiuntivi in caso di HTTP 429, con attesa crescente. Questo riduce la probabilità di blocchi temporanei osservati durante le richieste live.


## v0.9.8: CORS, cache e resolver diagnostico

- CORS viene applicato globalmente, incluse le risposte di manifest, catalogo, stream e debug; le richieste preflight `OPTIONS` ricevono `204`.
- Il recupero dei dettagli usa fino a 6 worker (configurabili) e una pausa predefinita di 100 ms invece di 2 worker con 900 ms.
- Le risposte di dettaglio vengono memorizzate per 5 minuti; il catalogo per 2 minuti. Le richieste simultanee al catalogo condividono la stessa operazione in corso.
- Il decoder prova anche strutture protobuf annidate per i nomi delle squadre e dell'evento. `/debug/catalog` espone campioni decodificati per verificare i campi effettivamente restituiti.
- `/debug/stream/<type>/<id>.json` interroga il primo stream dell'evento e restituisce la struttura dei campi protobuf e se è stato trovato un URL HTTP(S), senza esporre l'URL completo.

La risoluzione dell'URL è resa più tollerante, ma la riproduzione non può essere dichiarata verificata senza confrontare la risposta reale di `/api/stream/detail` e il tipo di URL restituito. Se l'URL richiede header particolari, cookie o un formato non supportato dal player, servirà un proxy o una gestione specifica.


## v0.9.10: metadati evento e decodifica URL stream

- I nomi di squadre e campionati sono mappe Protobuf `map<int32,string>`: la chiave della lingua è un varint nel campo 1 della voce e il testo è nel campo 2. Il decoder ora legge correttamente la chiave numerica e preferisce `PBLanguage.L_IT` (`8`).
- Il titolo Stremio è `casa - trasferta`, non il nome del campionato. La descrizione contiene il campionato e, quando entrambi i campi sono presenti, il punteggio. Un risultato `0-0` viene conservato; i campi assenti non vengono convertiti in zero.
- La risposta di `/api/stream/detail` ha `PBResponse.data` (field 10), al cui interno `PBStreamResp.stream` è il field 2. Il messaggio stream contiene l'URL nel field 4. Il diagnostico `payload fields: 2:2` era quindi compatibile con una risposta valida: il valore del field 4 è offuscato, non un URL HTTP in chiaro.
- Il field URL viene decodificato con ROT47; nel campione verificato il risultato inizia con `GRu8LFS8`, prefisso residuo rimosso prima dell'URL HTTP.
- La richiesta di dettaglio invia `withOriginal=true`, come la chiamata osservata nell'APK. La diagnostica segnala soltanto la presenza dell'header `rb-session`, senza registrarne o mostrarne il valore.

### Autenticazione HLS: risultato del reverse engineering e limite attuale

Le analisi dell'APK hanno individuato questi elementi del percorso player: la risposta di dettaglio fornisce `rb-session`; `PlayerManager` può sostituirlo con un `FixedRbSession` non scaduto, con validità di 18.000.000 ms (5 ore); il player costruisce gli header HLS a partire da `basicConfig.rbHeaders`, dallo User-Agent generato dall'app e dagli eventuali `Referer`/`Origin` ricavati dalla configurazione iframe. L'app applica inoltre header specifici ricevuti dal canale e dagli oggetti di iniezione HLS.

Questo addon non replica il meccanismo proprietario di sessione/iniezione dell'app e non dichiara quindi risolta la riproduzione dei segmenti. Il fatto che playlist o segmenti `.ts` rispondano `401 Authentication Required` indica che il solo URL decodificato non basta: Stremio deve poter usare un metodo di accesso autorizzato dal provider, con gli header/sessione previsti. La versione 0.9.10 corregge la decodifica e la restituzione delle sorgenti, ma non aggira né emula tale controllo di accesso.


## v0.9.11 — HTTPS per gli URL degli stream

Gli URL di riproduzione estratti dal campo Protobuf `stream.url` vengono normalizzati a `https://`: vale sia per l'URL decodificato ROT47 sia per gli URL individuati nella scansione ricorsiva del payload. La conversione riguarda esclusivamente gli URL degli stream restituiti a Stremio, non gli endpoint API usati per interrogare il servizio.

**Nota:** la sostituzione dello schema non rende automaticamente disponibile HTTPS sul server remoto. Il dominio di streaming deve avere TLS attivo e valido; se accetta soltanto HTTP, la richiesta HTTPS fallirà. Inoltre questa modifica risolve il blocco di mixed content solo sul piano dello schema URL: non risolve da sola eventuali risposte `401 Authentication Required` per playlist o segmenti HLS.


## v0.9.12 — diagnostica metadati partita

Questa versione estende i campi descrittivi della partita usando i campi Protobuf
già identificati: gruppo (40), turno (41) e luogo (79), quando sono presenti come
stringhe o messaggi testuali. Catalogo e meta espongono gli stessi dettagli.

La diagnostica `/debug/catalog` include `matchNameStructures` per i primi match:
mostra la struttura annidata dei campi 10, 19, 20, 21, 40, 41 e 79, inclusi
gli elementi delle mappe Protobuf. Serve a verificare perché i nomi di casa e
trasferta non risultano valorizzati nell'ambiente reale, senza inventare nomi
o attribuire significati non verificati ai campi.

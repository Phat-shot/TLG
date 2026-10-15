# TLG — The LAN Game: **Kerker**

Asymmetrisches Browser-Spiel für die LAN: **einer baut den Kerker, die anderen
holen das Artefakt — dann wird getauscht.** 2 bis 16 Spieler, Matches von 8 bis
20 Minuten, nur ein Browser am PC. Nutzerverwaltung kommt komplett von
[Craftworks](https://github.com/Phat-shot/craftworks); TLG hat keine eigene
Datenbank.

## Spielprinzip

- **Helden** (Top-Down, WASD + Maus) starten am Eingang, müssen das **Artefakt**
  am entferntesten Punkt holen und zum **Ausgang** tragen — der liegt bewusst
  nahe am Eingang: rein, holen, denselben Weg zurück. Der Träger ist langsamer.
  Das Team sieht nur, was ein lebender Held sieht (Sichtradius + Sichtlinie),
  und hat einen gemeinsamen Lebensvorrat (2 pro Held); danach ist ein Tod endgültig.
- **Der Kerker** sieht alles und setzt in Echtzeit Karten gegen **Mana**
  (regeneriert, +25 pro Kill): Stachelfalle und Fallgrube (für Helden
  unsichtbar, bis sie auslösen oder ein Schurke sie aufdeckt), Mauer (60 HP,
  darf den Kerker **nie versiegeln** — der Server prüft Eingang→Ausgang,
  Eingang→Artefakt und jeden Helden→Ausgang), Krabbler, Brecher, Nebel
  (Sicht auf 2,5 Kacheln). Nichts darf näher als 4 Kacheln (Monster: 6) an einem
  lebenden Helden gesetzt werden.
- **Klassen**: Krieger (Schildstoß: Dash + Rammstoß, haut Mauern weg),
  Schütze (Salve), Heiler (Heilkreis), Schurke (Spürsinn: deckt Fallen auf,
  3 s unsichtbar).
- **Sieg**: Helden, wenn das Artefakt den Ausgang erreicht. Kerker, wenn die
  Zeit abläuft oder alle Helden ohne Leben tot sind.
- **Serie mit festen Teams**: Der Host legt die Spieler pro Team fest (2er-Teams
  ab 4 Spielern, 3er ab 6 usw. — es müssen immer mindestens 2 Teams entstehen;
  7 Spieler bei 2er-Teams ergeben 3, 2, 2). Teams werden automatisch verteilt,
  der Host kann verschieben oder neu mischen. **Runden = Teams**: jedes Team ist
  genau einmal Kerker, die übrigen Teams fliehen gemeinsam, pro Runde eine neue
  Karte. 6 Spieler in 2er-Teams heißt 3 Runden, je 2 Kerkermeister gegen 4 Helden.
- **Punkte**: Kerker-Sieg 3 fürs Kerker-Team. Helden-Sieg 2 für jedes Heldenteam,
  +1 fürs Team des Artefakt-Trägers. Nach der letzten Runde steht das Siegerteam.
  Verlässt ein ganzes Team die Serie, entfällt seine Kerker-Runde.

Alle Zahlen stehen in `packages/shared/src/constants.js`.

## Architektur

```
packages/shared/   Konstanten, Kartengenerator (Seed-deterministisch), BFS/A*, Sichtlinie — Server UND Client
server/            Express + Socket.io, ein Worker-Thread pro Match (server/src/match/worker.js)
  src/match/engine.js   reine Engine: step(), placeCard(), snapshotFor() — ohne Timer, ohne Sockets
  src/lobby.js          Lobbys im Speicher, Teams, Serie (Runden, Punkte)
  src/auth.js           Craftworks-Anbindung (Token-Prüfung + Auth-Proxy)
client/            Vite + TypeScript, Canvas-Renderer, kein Framework
```

**Server ist autoritativ**, Clients zeigen nur an. `snapshotFor()` ist die
einzige Stelle, die Zustand herausgibt, und filtert pro Rolle: Helden bekommen
nie versteckte Fallen, nie Monster außer Sicht, nie Kerker-Mana, nie
Platzierungs-Ereignisse. Pro Tick (20 Hz) werden genau zwei Snapshots
gerechnet — Helden-Teamsicht und Kerker-Sicht.

### Craftworks-Anbindung (keine Änderung an Craftworks nötig)

- Der Browser spricht nur mit TLG. `/api/auth/*` (login, guest, refresh,
  logout, config, register, magic-link) wird 1:1 an `CRAFTWORKS_URL` weitergereicht —
  deshalb braucht Craftworks keine CORS-Freigabe für TLG.
- Ein Access-Token gilt, wenn Craftworks' `GET /api/users/me` ihn annimmt
  (60 s gecacht). Beim Socket-Handshake genauso. Kein geteiltes JWT-Secret.
- Gast-Login (Craftworks `/api/auth/guest`) ist der Normalweg auf der LAN; dafür
  muss in Craftworks `guest_login_enabled` an sein.

## Starten

```bash
npm ci
npm test                     # Shared + Engine + Lobby + Auth + End-to-End über echte Sockets
npm run build                # Client nach client/dist
CRAFTWORKS_URL=https://dev.srz.one npm start     # http://localhost:3000
```

Entwicklung mit Hot-Reload: `CRAFTWORKS_URL=… npm run dev:server` und
`npm run dev:client` (Vite auf :5173, proxied `/api` und `/socket.io` auf :3000).

Browser-Rauchtest (zwei Chromium-Kontexte, echter Client gegen echten Server
gegen nachgebauten Craftworks, Screenshots beider Sichten):

```bash
node scripts/check-client.mjs ./tmp-shots
```

Docker: `docker compose up -d` mit `CRAFTWORKS_URL` in der Umgebung oder
`.env`. CI baut `ghcr.io/phat-shot/tlg:test` (Branch `test`) und `:latest`
(Branch `main`).

## Was noch fehlt (bewusst)

- Keine Persistenz: Lobbys, Teams und Serienstand leben im Speicher, ein
  Server-Neustart heißt "alle neu rein". Leaderboard in Craftworks wäre der
  nächste Schritt (`/api/users/leaderboard/:game_type`).
- Kein Ton, keine Sprites — Formen und Farben, damit es auf jedem LAN-Rechner
  ohne Grafikkarte flüssig bleibt.
- Balance ist ein Startwert aus Konstanten, kein Ergebnis von Spieltests.

# Discord Voice Hub Bot 🎙️

Bot tworzy tymczasowe kanały głosowe ("Join to Create") oraz prowadzi ranking
najdłuższych rozmów (top 5 ogólnie i top 5 z bieżącego miesiąca) na wybranym
kanale tekstowym.

Bot działa **po ID kanałów**, nie po nazwach — możesz dowolnie zmieniać nazwy
kanałów, przenosić je między kategoriami, zmieniać kolejność, a wszystko
nadal będzie działać.

## Jak to działa

1. Administrator uruchamia `/setup-voice-hub` na serwerze.
2. Bot tworzy:
   - 🔊 kanał głosowy **"hub"** (np. "➕ Utwórz kanał"),
   - 📊 kanał tekstowy z rankingiem.
3. Gdy ktoś dołączy do kanału hub, bot natychmiast tworzy dla niego nowy,
   osobny kanał głosowy (w tej samej kategorii co hub) i przenosi go tam.
4. Gdy z takiego tymczasowego kanału wyjdzie ostatnia osoba, kanał jest
   automatycznie usuwany, a czas trwania rozmowy trafia do statystyk.
5. Ranking (top 5 ogólnie + top 5 w tym miesiącu) jest automatycznie
   aktualizowany (edytowany, nie spamowany) na kanale tekstowym.

## Wymagania

- **Node.js 22.5 lub nowszy** (sprawdź komendą `node -v`). Jeśli masz starszego, pobierz aktualną wersję LTS z https://nodejs.org.
- Baza **PostgreSQL** (np. darmowy projekt na Supabase) i jej adres w `DATABASE_URL`.
- Aplikacja Discord Bot założona na https://discord.com/developers/applications

## Konfiguracja krok po kroku

### 1. Zainstaluj zależności

```bash
npm install
```

### 2. Utwórz bota na Discord Developer Portal

1. Wejdź na https://discord.com/developers/applications -> **New Application**.
2. W zakładce **Bot**:
   - kliknij **Reset Token** i skopiuj token (to Twój `DISCORD_TOKEN`),
   - włącz intent **SERVER MEMBERS INTENT** (wymagany przez panel ról - bez niego bot nie może nadawać ról)
     oraz upewnij się, że **PRESENCE INTENT** nie jest wymagany (nie używamy go).
3. W zakładce **General Information** skopiuj **Application ID** (to `CLIENT_ID`).
4. W zakładce **OAuth2 -> URL Generator**:
   - zaznacz scope `bot` oraz `applications.commands`,
   - w uprawnieniach zaznacz co najmniej: `Manage Channels`, `Move Members`,
     `View Channels`, `Connect`, `Send Messages`, `Embed Links`,
   - wygenerowanym linkiem zaproś bota na swój serwer.

### 3. Skonfiguruj plik `.env`

Skopiuj `.env.example` do `.env` i uzupełnij:

```bash
cp .env.example .env
```

```
DISCORD_TOKEN=twój_token
CLIENT_ID=twój_client_id
GUILD_ID_DEV=   # opcjonalnie ID Twojego serwera testowego - komendy pojawią się natychmiast
```

### 4. Zarejestruj komendy slash

```bash
npm run deploy
```

### 5. Uruchom bota

```bash
npm start
```

## Komendy

| Komenda | Opis | Uprawnienia |
|---|---|---|
| `/setup-voice-hub [kategoria] [nazwa_hub] [nazwa_rankingu]` | Tworzy kanał hub + kanał rankingu | Zarządzanie serwerem |
| `/ranking` | Pokazuje aktualny ranking na żądanie | Wszyscy |
| `/status` | Pokazuje, jakie kanały są aktualnie skonfigurowane | Zarządzanie serwerem |
| `/setup-propozycje [kategoria] [nazwa_listy] [nazwa_tworzenia]` | Tworzy DWA kanały: listę propozycji + kanał z przyciskiem do zgłaszania | Zarządzanie serwerem |
| `/rola-panel utworz` | Tworzy nowy panel do samodzielnego wybierania ról | Zarządzanie rolami |
| `/rola-panel dodaj` | Dodaje rolę (+ emoji, opcjonalnie etykietę) do panelu | Zarządzanie rolami |
| `/rola-panel usun` | Usuwa pojedynczą rolę z panelu | Zarządzanie rolami |
| `/rola-panel usun-panel` | Usuwa cały panel razem z wiadomością | Zarządzanie rolami |
| `/rola-panel lista` | Pokazuje wszystkie panele ról na serwerze (z ID) | Zarządzanie rolami |
| `/setup-poziomy [kategoria] [nazwa_kanalu]` | Tworzy kanał ogłaszający kamienie milowe poziomów | Zarządzanie serwerem |
| `/poziom [uzytkownik]` | Pokazuje Twój (lub czyjś) aktualny poziom i XP | Wszyscy |
| `/eksport-poziomow` | Wysyła plik CSV z XP i poziomami wszystkich (kopia zapasowa) | Administrator |
| `/migracja podglad` / `zastosuj` | Jednorazowy reset poziomów z pliku `data/migracja.csv` (z podglądem i potwierdzeniem) | Administrator |
| `/portfel [uzytkownik]` | Pokazuje saldo monet, zarobione łącznie i (dla Ciebie) ostatnie operacje | Wszyscy |
| `/nagroda` | Dzienna skrzynia z monetami (reset o północy, czas polski) | Wszyscy |
| `/cclear kanal ilosc:<liczba/all> [uzytkownik]` | Usuwa wiadomości z bieżącego kanału | Zarządzanie wiadomościami |
| `/cclear uzytkownik uzytkownik:<user> okres:<...>` | Usuwa wiadomości danego użytkownika ze WSZYSTKICH kanałów, z ostatnich X godzin | Zarządzanie wiadomościami |
| `/rola-poziom ustaw poziom:<n> rola:<rola>` | Przypisuje rolę do poziomu (0 = od dołączenia) | Zarządzanie rolami |
| `/rola-poziom usun poziom:<n>` | Usuwa przypisanie roli dla danego poziomu | Zarządzanie rolami |
| `/rola-poziom lista` | Pokazuje całą drabinkę ról za poziomy | Zarządzanie rolami |
| `/rola-poziom sync` | Nadaje role WSZYSTKIM obecnym członkom serwera (jednorazowo) | Zarządzanie rolami |

### Jak działa drabinka ról za poziomy

To osobny system od panelu ról (`/rola-panel`) — tu role są nadawane **automatycznie**,
bez klikania czegokolwiek, w miarę jak ktoś zdobywa XP (albo od razu po dołączeniu,
jeśli ustawisz rolę na poziomie **0**).

```
/rola-poziom ustaw poziom:0 rola:@Nowicjusz
/rola-poziom ustaw poziom:5 rola:@Bywalec
/rola-poziom ustaw poziom:10 rola:@Gaduła
```

Zasada działania: **jedna osoba = jedna rola z drabinki na raz.** Gdy ktoś
awansuje na wyższy próg, automatycznie **traci poprzednią** rolę z drabinki
i dostaje nową — role się nie stakują. Role spoza drabinki (np. Moderator,
własne kolorowe rangi) są całkowicie nietknięte.

Nie trzeba ustawiać roli na każdym poziomie z osobna — jeśli masz role na
poziomach 0, 5, 10, a ktoś jest na poziomie 7, dostaje rolę z poziomu 5
(najbliższy próg **poniżej** aktualnego poziomu).

**Dla osób, które już były na serwerze zanim skonfigurowałeś drabinkę:**
nowi członkowie dostają rolę automatycznie przy dołączeniu, ale ci, którzy
byli na serwerze wcześniej, nie dostaną nic wstecznie — do tego służy:
```
/rola-poziom sync
```
Ta komenda przechodzi przez WSZYSTKICH obecnych członków serwera i nadaje
każdemu odpowiednią rolę (traktując brak zapisanego XP jako poziom 0).
Wystarczy uruchomić raz, po skonfigurowaniu całej drabinki - potem nowe
osoby i awanse obsługują się same.

**Wymagania:** te same co przy `/rola-panel` — rola bota musi być **wyżej**
niż role z drabinki (Ustawienia serwera -> Role), a **SERVER MEMBERS INTENT**
musi być włączony (patrz sekcja wyżej).

### Jak działa system EXP

Użytkownicy dostają XP za aktywność — **na czacie** i **na kanałach głosowych**
— ale nie za każdą wiadomość/sekundę, tylko z limitem co ok. **1 minutę**
(konfigurowalne przez `XP_COOLDOWN_MINUTES` w `.env`):

- **Czat:** pierwsza wiadomość po minucie ciszy daje losowe 5-10 XP.
  Spamowanie nie daje nic dodatkowego - trzeba poczekać na kolejne okno.
- **Głos:** co minutę bot sprawdza, kto aktualnie siedzi na kanale głosowym
  (poza kanałem AFK) i każdej takiej osobie daje losowe 5-10 XP.

Poziomy rosną według rosnącej krzywej trudności (każdy kolejny poziom wymaga
więcej XP niż poprzedni - podobnie jak w popularnych botach typu MEE6).
Możesz to przestroić zmieniając stałe w `utils/leveling.js` (funkcja
`xpNeededForLevel`) albo wartości XP w `.env`.

**Kanał poziomów** (`/setup-poziomy`) nie ogłasza KAŻDEGO poziomu — tylko
kamienie milowe: **5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 400,
500, 600, 700, 800, 900**, a powyżej 900 co kolejne 100 (1000, 1100, 1200...).
Listę kamieni milowych można zmienić w `utils/leveling.js` (stała `EXPLICIT_MILESTONES`).

Komenda `/poziom` (bonus) pozwala każdemu sprawdzić swój aktualny postęp,
mimo że nie każdy poziom jest ogłaszany publicznie.

### Jak działa ekonomia (etap 1)

Każdy użytkownik ma na serwerze **portfel z monetami**. Nazwę i emoji waluty zmieniasz w jednym
miejscu: `utils/economy.js` (obiekt `CURRENCY`).

**Skąd się biorą monety:** na razie tylko z `/nagroda` (dzienna skrzynia, 7 rzadkości; szanse i zakresy
w `DAILY_TIERS` w `utils/economy.js`). Kolejne źródła (kasyno, projekty) dojdą w następnych etapach.
**XP** nadal pochodzi wyłącznie z czatu i głosowego i nie ma z monetami nic wspólnego.

**Animacja skrzyni:** `/nagroda` pokazuje publiczną animację (jedna wiadomość edytowana klatka po klatce, z komentarzem Boba).
Nagroda jest zapisywana w bazie PRZED animacją, więc nawet przerwana animacja nie gubi monet.
Tempo klatek zmienisz w `.env`: `CHEST_FRAME_DELAY_MS` (domyślnie 1300).

**Bezpieczeństwo salda:** wszystkie zmiany idą przez funkcje w `db.js` (`addCoins`, `spendCoins`,
`claimDailyCoins`), które działają atomowo, więc szybkie podwójne kliknięcie nie wyda tych samych monet
ani nie da podwójnej nagrody. Saldo nie może zejść poniżej zera (ograniczenie w bazie).

**Dziennik:** każda zmiana salda (nagrody, a w przyszłości zakupy i wygrane) zapisuje się w tabeli
`economy_transactions`.

Poziomy i drabinka ról na razie działają jak dotąd, równolegle do monet.

### Jednorazowy reset poziomów (migracja)

Wszystko jest jawne i da się je sprawdzić ręcznie:

1. `/eksport-poziomow` zapisuje aktualny stan do pliku (to jest też Twoja kopia zapasowa).
2. `node scripts/generuj-migracje.js scripts/poziomy-eksport.csv` tworzy `data/migracja.csv`.
   Zasady są na górze skryptu: najwyższy poziom spada do `MAX_NEW_LEVEL` (20), reszta proporcjonalnie niżej,
   a odznakę dostają osoby, które miały co najmniej `BADGE_MIN_OLD_LEVEL` (30) poziom.
3. Plik `data/migracja.csv` możesz otworzyć w Excelu i poprawić ręcznie, bot użyje dokładnie tego, co w nim jest.
4. `/migracja podglad` pokazuje podsumowanie (niczego nie zmienia).
5. `/migracja zastosuj rola:@Byłem tu` pyta o potwierdzenie przyciskiem i dopiero wtedy zmienia dane.
   Wszystkie zmiany w bazie dzieją się w jednej transakcji (albo wszystko, albo nic), a ponowne uruchomienie
   jest zablokowane, żeby nie skasować postępów zdobytych po migracji (chyba że użyjesz opcji `wymus`).

### Jak działa /cclear

Dwa tryby, jedna komenda:

**`/cclear kanal`** — czyści bieżący kanał:
```
/cclear kanal ilosc:50
/cclear kanal ilosc:all
/cclear kanal ilosc:20 uzytkownik:@Jan
```
`ilosc` przyjmuje liczbę (np. `50`) albo `all` (wszystko, do limitu Discorda).
Jeśli podasz `uzytkownik`, usunięte zostaną tylko jego wiadomości (bot
przewertuje więcej wiadomości niż `ilosc`, żeby znaleźć tyle pasujących).

**`/cclear uzytkownik`** — czyści wiadomości danej osoby na **całym serwerze**,
niezależnie od kanału, z wybranego okresu:
```
/cclear uzytkownik uzytkownik:@Jan okres:30 minut
/cclear uzytkownik uzytkownik:@Jan okres:24 godziny (dzień)
```
Dostępne okresy: 30 minut, 1h, 3h, 6h, 12h, 24h (dzień).

> **Ograniczenie Discorda (nie da się obejść):** masowe usuwanie (`bulkDelete`)
> działa tylko na wiadomościach młodszych niż **14 dni**. Starsze trzeba by
> kasować pojedynczo, co jest bardzo wolne - dlatego `/cclear uzytkownik`
> celowo oferuje tylko krótkie okresy (do 24h), a `/cclear kanal ilosc:all`
> może nie usunąć kompletnie wszystkiego, jeśli kanał ma bardzo starą historię.

### Jak działa panel ról

Panel ról pozwala użytkownikom samodzielnie nadawać/zdejmować sobie role —
klikając **emotkę (reakcję)** albo **przycisk**, w zależności od tego, co
wybierzesz przy tworzeniu panelu. Możesz mieć dowolnie wiele paneli, każdy
z osobnym trybem.

**Krok 1 — stwórz panel:**
```
/rola-panel utworz kanal:#role tryb:Przyciski (buttony) tytul:Wybierz swoje role
```
Bot odpowie z **numerem panelu** (np. `#1`) — będzie Ci potrzebny do kolejnych komend.

**Krok 2 — dodaj role do panelu:**
```
/rola-panel dodaj panel:1 rola:@Gracz emoji:🎮 etykieta:Gracz
/rola-panel dodaj panel:1 rola:@Artysta emoji:🎨 etykieta:Artysta
```
(pole `etykieta` ma znaczenie tylko w trybie przycisków — w trybie emotek jest ignorowane)

Wiadomość panelu aktualizuje się automatycznie po każdej zmianie — w trybie
emotek bot sam dodaje/usuwa odpowiednie reakcje, w trybie przycisków
przebudowuje rząd przycisków.

**Ważne uprawnienia:**
- Rola bota musi być **wyżej** niż role, które ma nadawać (Ustawienia serwera
  -> Role -> przeciągnij rolę bota na górę listy, ponad role z panelu)
- Bot musi mieć uprawnienie **Zarządzaj rolami**
- W Discord Developer Portal, w zakładce **Bot**, musisz włączyć
  **SERVER MEMBERS INTENT** (to osobny przełącznik, wymagany żeby bot mógł
  nadawać role) — bez tego panel ról nie zadziała, mimo że reszta bota
  będzie działać normalnie.

### Jak działa system propozycji

Po `/setup-propozycje` bot tworzy **dwa kanały tekstowe** w tej samej,
domyślnej kategorii (którą możesz potem dowolnie zmienić, tak jak wszystkie
inne kanały tego bota):

- **📝 kanał "utwórz propozycję"** — tam stoi tylko stały przycisk "Dodaj propozycję"
- **📋 kanał "lista propozycji"** — tam automatycznie lądują opublikowane propozycje z głosowaniem

Na obu kanałach nikt (żadna ranga) nie może zwyczajnie pisać ani dodawać
własnych reakcji — tylko bot. Kliknięcie przycisku otwiera formularz z polami:

- **Tytuł**
- **Opis propozycji**
- **Zdjęcie z dysku** (opcjonalnie) — prawdziwy upload pliku z komputera/telefonu, bez potrzeby linku
- **Link do zdjęcia** (opcjonalnie) — alternatywa, jeśli ktoś woli wkleić link zamiast wgrywać plik

Jeśli użytkownik wgra plik, ma on pierwszeństwo nad linkiem. Po zatwierdzeniu
bot publikuje ładny embed na kanale listy i automatycznie dodaje reakcje
✅ i ❌ — reszta serwera głosuje klikając te gotowe reakcje (mimo blokady
dodawania *nowych* reakcji, kliknięcie już istniejącej wciąż działa dla
każdego — tak działają uprawnienia Discorda).

> **Uwaga:** upload plików w modalach to nowa funkcja Discorda (komponent
> File Upload), dlatego bot wymaga discord.js w wersji **14.25.1 lub nowszej**
> — `npm install` pobierze odpowiednią wersję automatycznie.

## Dowolna edycja kanałów po utworzeniu

Po uruchomieniu `/setup-voice-hub` możesz spokojnie:

- zmienić nazwę kanału hub i/lub kanału rankingu,
- przenieść je do dowolnej innej kategorii,
- zmienić ich kolejność na liście kanałów,

— bot zapamiętuje je po **ID**, a nie po nazwie, więc dalej będą działać
poprawnie. Jeśli chcesz zmienić, KTÓRE kanały pełnią te role (np. usunąłeś je
przypadkiem), po prostu uruchom `/setup-voice-hub` ponownie — utworzy nową parę
kanałów i podmieni konfigurację.

## Dane

Dane są przechowywane w bazie **PostgreSQL** (np. Supabase) pod adresem z zmiennej `DATABASE_URL`
w pliku `.env`. Tabele tworzą się automatycznie przy starcie bota (`initDb` w `db.js`),
a nowe kolumny dodawane są bezpiecznie (`IF NOT EXISTS`), więc aktualizacja nie kasuje danych.

## Wieloserwerowość

Bot obsługuje wiele serwerów jednocześnie — każda konfiguracja (`guild_config`)
oraz statystyki (`sessions`) są przechowywane osobno dla każdego `guild_id`,
więc możesz dodać bota do wielu serwerów bez żadnych konfliktów.

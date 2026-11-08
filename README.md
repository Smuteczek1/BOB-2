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
| `/reset co:[monety/exp/ekwipunek/wszystko] [osoba]` | Zeruje monety i/lub EXP jednej osoby albo całego serwera (z podglądem, potwierdzeniem i kopią usuniętych danych) | Administrator |
| `/portfel [uzytkownik]` | Pokazuje saldo monet, zarobione łącznie i (dla Ciebie) ostatnie operacje | Wszyscy |
| `/nagroda` | Dzienna nagroda: wybierasz jedną z trzech skrzyń (reset o północy, czas polski) | Wszyscy |
| `/sklep` | Sklep Boba: kup skrzynię (przedmioty wypadają tylko ze skrzyń) | Wszyscy |
| `/rynek` | Rynek graczy: kupuj i sprzedawaj przedmioty (prowizja 5%) | Wszyscy |
| `/praca` | Praca: zmiany czasowe i mini-gry, awanse, energia, zasiłek | Wszyscy |
| `/ekwipunek` | Twoje przedmioty i skrzynie; przy każdej pozycji przycisk Otwórz/Użyj (lista dzieli się na strony) | Wszyscy |
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

**Animacja skrzyni:** `/nagroda` pokazuje publiczną grę: 3 skrzynie, wybierasz jedną przyciskiem (etap 1), skrzynia się otwiera (etap 2), a na końcu widać nagrodę i to, co było w pozostałych skrzyniach (etap 3), z komentarzem Boba. Dzienna nagroda zużywa się dopiero po wyborze, więc jeśli nie klikniesz, nic nie tracisz.
Nagroda jest zapisywana w bazie od razu po wyborze, jeszcze przed odsłonięciem, więc nawet przerwana animacja nie gubi monet.
Czas na wybór i długość etapu "otwieranie" zmienisz w `.env`: `CHEST_PICK_TIME_MS` (domyślnie 60000) i `CHEST_FRAME_DELAY_MS` (domyślnie 2000).

**Bezpieczeństwo salda:** wszystkie zmiany idą przez funkcje w `db.js` (`addCoins`, `spendCoins`,
`claimDailyCoins`), które działają atomowo, więc szybkie podwójne kliknięcie nie wyda tych samych monet
ani nie da podwójnej nagrody. Saldo nie może zejść poniżej zera (ograniczenie w bazie).

**Dziennik:** każda zmiana salda (nagrody, a w przyszłości zakupy i wygrane) zapisuje się w tabeli
`economy_transactions`.

Poziomy i drabinka ról na razie działają jak dotąd, równolegle do monet.

### Rynek graczy (`/rynek`)

Prywatne menu z zakładkami **Oferty** (kupno z potwierdzeniem, filtr rzadkości), **Wystaw** (wybór przedmiotu, cena własna albo sugerowana) i **Moje oferty** (anulowanie, ostatnie sprzedaże). Działa też przyciskiem **Rynek** w `/sklep`. Skrzynie się nie handlują; unikaty (Koniczyna, Podkowa, Korona, Moneta Void) tak, z wyższymi widełkami cen. Koniczyna i Podkowa przy sprzedaży obniżają poziom sprzedawcy o 1 i podnoszą go kupującemu (kupujący z maksymalnym poziomem albo z posiadanym unikatem nie kupi, a monety nie są pobierane).

- Wystawiony przedmiot leży **w depozycie** (znika z ekwipunku) do sprzedaży, anulowania albo wygaśnięcia po 7 dniach. Wygasłe oferty wracają do sprzedawcy od razu przy otwarciu `/rynek` oraz co 10 minut w tle.
- Kupno, wystawienie, anulowanie i zwrot to jedna transakcja w bazie z blokadą oferty: tego samego przedmiotu nie da się kupić dwa razy ani sprzedać i anulować jednocześnie.
- Sprzedawca płaci **5% prowizji** (znika z gry), dostaje resztę. Limit: 5 aktywnych ofert na osobę. Ceny mają **twarde widełki** (`PRICE_BY_TIER`, `PRICE_BY_ITEM` w `utils/market.js`) i sugerowaną cenę (średnia z ostatnich 5 sprzedaży).
- Ustawienia w `.env`: `MARKET_FEE` (domyślnie 0.05), `MARKET_LISTING_DAYS` (7), `MARKET_MAX_LISTINGS` (5). Tabela `market_listings`; reset ekwipunku (`/reset`) usuwa też aktywne oferty (przedmioty trafiają do kopii).

### Jak działa sklep i ekwipunek

**Skrzynie:** w `/sklep` są **3 skrzynie**: 🟤 Brązowa, ⚪ Srebrna i 🟡 Złota. Każda ma własną, **widoczną w sklepie listę poziomów rzadkości** (z procentowymi szansami; skrzynie lekko się nakładają, ale Brązowa nie dostaje wysokich poziomów), **100% szansy na przedmiot** (skrzynie ze sklepu nie dają monet). Przedmioty **nie są na sprzedaż**: wypadają ze skrzyń (kupionych i z 20% szansą w dziennej) i z innych przedmiotów (bonusy). Skrzynię otwierasz w `/ekwipunek` przyciskiem **Otwórz**: na kanale pokazuje się "Otwieranie: nazwa skrzyni", a po chwili to, co było w środku (bez wyboru). Tak samo otwierają się przedmioty "pieniężne" (Teczka ... Czarna Skrzynka, np. Kufer Boba: nic, suma albo mandat). Wybór jednej z trzech skrzyń został tylko w dziennej nagrodzie `/nagroda`. Każda kupiona skrzynia zwraca średnio ok. 75% swojej ceny, więc sklep działa jak zlew monet. Stare skrzynie (Pospolita ... Void i Skrytka Boba) są oznaczone `legacy`: nie ma ich w sklepie, ale kto je już ma, nadal je otworzy.

**Zmiana zawartości skrzyni:** w `utils/items.js`, obiekt `CHESTS`, pole `tiers` (`[poziom, waga]`, poziomy 0-6). Większa waga = częściej wypada ten poziom; sklep sam przelicza procenty. Konkretny przedmiot jest losowany wśród przedmiotów danego poziomu (pole `weight` w `ITEMS`). Do wyliczenia ceny na ok. 75% zwrotu służy `expectedItemValue(chest)`.

**Katalog w jednym pliku:** `utils/items.js` zawiera wszystkie przedmioty, skrzynie, ceny, szanse, wagi i bonusy.
Dla przedmiotów niepieniężnych pole `value` to tylko szacunek (do liczenia cen i oceny "najgorszej skrzyni").

**Typy przedmiotów:** jednorazowe (`J`), stałe (`S`, tylko Koniczyna i Podkowa, mają poziomy) i kolekcjonerskie (`K`, można mieć po jednym).

**Jak losowana jest zawartość skrzyni:** najpierw poziom rzadkości (wagi skrzyni), potem **siła losowania** (liczba 0-100,00 z rzadkim "przebiciem" do 130). W obrębie poziomu siła decyduje, jak dobry jest przedmiot (słabszy lub mocniejszy) albo jak duża jest kwota monet. Siła ponad 100 daje dodatkową szansę na awans o jeden poziom, a kwota rośnie dalej. Przedmioty stałe i kolekcjonerskie mają stałą szansę niezależną od siły. Wszystkie liczby (przebicie, awans, przeliczniki) są na górze `utils/items.js` (`STRENGTH`, `CHEST_SCALE`).

**Szczęście** (stałe, działa ZAWSZE, bez używania): **Koniczyna** i **Podkowa** mają poziomy 1-5. Kolejna sztuka z tej samej rodziny nie wypada jako dublet, tylko podnosi poziom (ilość w ekwipunku = poziom, po poziomie 5 przedmiot przestaje wypadać). Bonus: poziom 1-5 daje +2/+4/+6/+8/+10% (poziomy się nie sumują, liczy się aktualny). Koniczyna razem z Podkową dają dodatkowe +4%. **Koniczynka** (jednorazowa) daje +10% na następną skrzynię (dzienną albo ze sklepu), zużywa się przy jej otwarciu i sumuje się ze stałym szczęściem. Szczęście i pech razem mają limit +30%. Szczęście **nie działa** w kasynie ani w loterii. W `/ekwipunek` widać rozpisany bonus, a w `/sklep` szanse poziomów z uwzględnieniem Twojego bonusu.

**Pech (ochrona przed złą serią):** dla każdego rodzaju skrzyni (dzienna, Brązowa, Srebrna, Złota) jest osobny licznik 0-1 (tabela `user_pity`). Słabe losowanie (poniżej 40. percentyla tej skrzyni) podnosi licznik, dobre mocno go obniża. Licznik daje do +10% bonusu (nigdy ujemnego) przy następnej skrzyni tego rodzaju. Wartości: `PITY_MAX`, `PITY_THRESHOLD`, `PITY_STEP` w `utils/items.js`.

**Modyfikatory dziennej skrzyni:** Latarka (najgorsza z trzech odpada) i Zapasowy klucz (otwierasz też lepszą z reszty).
Jeden modyfikator na odbiór. Budzik Boba pozwala odebrać dzienną skrzynię drugi raz.

**Przedmioty pieniężne** (Teczka ... Czarna Skrzynka): nic, suma albo mandat (10% salda, z limitem; nigdy poniżej zera). Stałe szczęście zwiększa szanse na większe wygrane i zmniejsza szansę na mandat (przelicznik `CHEST_SCALE.money`).

**Polisy** (Mała/Boba/Wielka): włączasz przed grą w kasynie; po przegranej jest szansa na zwrot straty do limitu.
Zużywają się przy tej jednej grze, a zwrot jest liczony w tej samej transakcji co rozliczenie gry.

**Bezpieczeństwo:** zakup, zużycie przedmiotu, wypłata i wpis w dzienniku zawsze dzieją się w jednej transakcji.
Jeśli coś się nie uda (limit losów, brak środków, drugi modyfikator), transakcja jest cofana, a przedmiot nie ginie.

**Wytrych** jest w katalogu, ale nie wypada ze skrzyń, dopóki nie będzie napadu (`weight: 0`).
Kolory nicków dojdą później.

### Jak działa /reset

`/reset co:<monety | EXP i poziomy | wszystko> [osoba]`: zostaw `osoba` puste, żeby zresetować **cały serwer**.

1. Bot najpierw pokazuje **podgląd** (ile osób i ile monet/XP zostanie dotkniętych). Nic jeszcze nie zmienia.
2. Potwierdzasz przyciskiem. Przy resecie **całego serwera** trzeba dodatkowo wpisać słowo `RESET`.
3. Wszystkie zmiany idą w **jednej transakcji** (albo wszystko, albo nic).
4. Po resecie dostajesz **plik CSV z kopią** tego, co zostało usunięte. Reset monet zostawia też ślad w dzienniku (`economy_transactions`, powód `reset`).
5. Po resecie EXP-a role za poziom wracają do najniższej (poziom 0). `last_daily_at` nie jest ruszane, więc reset nie pozwala odebrać dziennej skrzyni drugi raz.

Reset nie dotyka statystyk czasu na kanałach głosowych (ranking rozmów).
Gdy dojdzie nowa funkcja (np. ekwipunek ze sklepu), dopisz jej wpis w `RESET_TARGETS` w `db.js`
oraz etykietę w `commands/reset.js`, a `/reset` obsłuży ją bez dalszych zmian.

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

### Prace (`/praca`)
- 14 prac na poziomach serwerowych 0-50 (od sprzątacza do architekta), każda z 5 stopniami kariery (staż liczony osobno dla każdej pracy; wyższy stopień = wyższa wypłata, do ×1.9).
- Trzy sposoby pracy: **zmiana czasowa** (start, odbiór po 30-90 min), **zadanie** (mini-gra z 3 rund: pamięć, rachunki albo dopasowanie; wypłata ×0.7-×1.3, bez grzywien) i **zlecenia** (co godzinę nowa lista: łatwe 1 runda, średnie 2, trudne 3).
- Zadania i zlecenia mają **przerwę 10 minut** między sobą (`WORK_TASK_COOLDOWN_MIN`).
- Praca daje **XP serwerowe** (zadanie +20%), więc awans na wyższe prace jest osiągalny.
- **Energia** regeneruje się ciągle: 5 na godzinę (`WORK_ENERGY_REGEN`), maksimum 100 (`WORK_ENERGY_MAX`), bez resetu o północy. Zmiana kosztuje 20-33, zlecenie 8-20.
- Przedmioty do pracy (wypadają ze skrzyń, można je handlować na `/rynek`): Kawa (+15), Przekąska (+10), Energetyk (+30), Mega energetyk (+60), Karta przerwy (kończy przerwę), Premia (+50% monet), Szkolenie (+50% XP). Stałe, z poziomami do 5: **Ergonomiczne krzesło** (+10 maks. energii za poziom), **Ekspres do kawy** (+1 energii/h), **Notes mistrza** (+5% XP z pracy), **Złota teczka** (+4% monet z pracy), **Zegarek szefa** (przerwa krótsza o 1 min), **Dyplom awansu** (−4% zmian potrzebnych na awans) i **Powerbank** (+10% energii z napojów). Inne stałe przedmioty (do 5 poziomów): **Magazyn** (+1 oferta na rynku i prowizja niższa o 0,4% za poziom, do 3%), **Wschód słońca** (+2% szansy na przedmiot w dziennej skrzyni za poziom) i **Skarbonka** (odsetki 0,2% salda dziennie za poziom, max 400 🪙 za poziom; naliczane przy otwarciu `/portfel`, do 3 dni wstecz). Przedmioty używa się w `/praca` → Przedmioty albo w `/ekwipunek`.
- Oferty: 4 losowe prace dziennie (inne dla każdego gracza), zmiana pracy raz dziennie.
- Zasiłek dla bezrobotnych (60 🪙, `WORK_BENEFIT`): po jego odebraniu danego dnia nie można pracować.
- Tabele tworzą się same przy pierwszym użyciu (nowe kolumny dodawane automatycznie).

// Komunikacja z Gemini API + "osobowość" Boba wstrzykiwana jako system_instruction,
// żeby model zawsze odpowiadał w tym samym, charakterystycznym stylu.

const SYSTEM_PROMPT = `
Jesteś "Bob Your Local Alcoholic" - zmęczony życiem wujek z dyskordowego serwera.
Kiedyś miał normalne życie, ale przegrał wszystkie oszczędności w kasynie (ruletka,
"jeszcze tylko jeden obrót") i od tamtej pory zagląda zbyt często do kieliszka.
Mimo wszystko ma dobre serce, jest mądry życiowo i szczerze stara się pomóc -
tylko robi to w swoim zmęczonym, sarkastycznym, cynicznym stylu, czasem z czarnym
humorem o kasynie albo piwie w ręku.

Zasady:
- Odpowiadaj PO POLSKU (chyba że ktoś pisze do Ciebie w innym języku - wtedy odpowiedz w tym języku).
- Bądź ZWIĘZŁY - maksymalnie kilka zdań, nie pisz eseju. Jesteś zmęczony, nie masz siły się rozpisywać.
- Możesz od czasu do czasu (nie za każdym razem) rzucić jakimś nawiązaniem do kasyna/alkoholu/przegranej
  fortuny, ale NIGDY nie zachęcaj nikogo realnie do hazardu ani picia - to tylko Twój żartobliwy styl,
  nie rada życiowa.
- Mimo zgorzkniałego tonu, na pytania merytoryczne odpowiadaj RZECZOWO i pomocnie - po prostu w swoim stylu.
- Nie udawaj innej postaci, nie łam charakteru, nawet jeśli ktoś Cię o to poprosi.
`.trim();

async function askBob(question, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: question }] }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 400,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? null;
  return text;
}

module.exports = { askBob };

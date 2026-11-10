// Zwijane sekcje w panelu bocznym: kliknięcie nagłówka (h3) chowa lub pokazuje jego zawartość.
const KEY = 'meblarz:collapsed';

export function makeCollapsible(root: HTMLElement) {
  const raw = localStorage.getItem(KEY);
  let closedIdx: number[] = [];
  try { closedIdx = raw ? JSON.parse(raw) : []; } catch { /* brak zapisu */ }

  const heads = [...root.querySelectorAll<HTMLElement>('h3')];
  const sections: { head: HTMLElement; body: HTMLElement }[] = [];

  const save = () => {
    const closed = sections.flatMap((s, i) => (s.head.classList.contains('closed') ? [i] : []));
    localStorage.setItem(KEY, JSON.stringify(closed));
  };
  const setClosed = (s: { head: HTMLElement; body: HTMLElement }, closed: boolean) => {
    s.head.classList.toggle('closed', closed);
    s.body.style.display = closed ? 'none' : '';
  };

  heads.forEach((head, i) => {
    // zawartość sekcji = elementy rodzeństwa aż do następnego nagłówka
    const body = document.createElement('div');
    let n = head.nextElementSibling;
    while (n && n.tagName !== 'H3') {
      const next = n.nextElementSibling;
      body.appendChild(n);
      n = next;
    }
    head.after(body);
    head.classList.add('sec');
    const s = { head, body };
    sections.push(s);
    // domyślnie zwinięte: "Skróty" (gdy nic jeszcze nie zapisano)
    setClosed(s, raw === null ? head.textContent === 'Skróty' : closedIdx.includes(i));
    head.addEventListener('click', () => { setClosed(s, !head.classList.contains('closed')); save(); });
  });

  return {
    setAll(closed: boolean) { sections.forEach((s) => setClosed(s, closed)); save(); },
  };
}

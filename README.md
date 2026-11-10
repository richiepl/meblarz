# Meblarz

## Instalacja na Fedorze (jednorazowo)
    sudo dnf install -y gcc gcc-c++ make openssl-devel pkgconf-pkg-config nodejs npm curl
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # wybierz 1 (domyślna)
    source ~/.cargo/env
    rustup target add wasm32-unknown-unknown
    cargo install wasm-pack      # trwa kilka minut

## Uruchomienie
    ./run.sh
Potem otwórz adres z terminala (zwykle http://localhost:5173).
Po zmianie kodu w `core/` uruchom `./run.sh` ponownie.

## Strony
- `/` – edytor mebli (zapis do biblioteki: przycisk "Do biblioteki")
- `/apartment.html` – mieszkanie: rzut, ściany, wstawianie mebli z biblioteki

## AutoCAD
- **DXF (tekstowy)**: import w module mieszkania jako podkład (linie, polilinie, łuki, okręgi, bloki INSERT), z możliwością zrobienia ścian z wybranych warstw; eksport planu mieszkania i rzutów mebla do DXF (R12, mm).
- **DWG** nie jest obsługiwane bezpośrednio (format zamknięty). Zapisz jako DXF w AutoCAD albo otwórz w LibreCAD (`sudo dnf install librecad`) i zapisz jako DXF.

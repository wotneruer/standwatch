# StandWatch

Канонічний source repository StandWatch.

## Межі каталогів

- Цей `repo` містить лише source, tests, scripts і документацію.
- Робочий застосунок запускається з `../runtime/current/standwatch.exe`.
- Runtime data, токени, backup, cache і transactions не копіюються в Git.
- Готові portable artifacts мають потрапляти в `../dist`.
- Старі збірки зберігаються в `../archive` до окремо погодженого очищення.

## Поточний стан

Repository створено з перевіреної робочої копії 2026-09-24 перед структурним
рефакторингом. Спочатку потрібно відтворити test/build/package pipeline, потім
закрити критичні rename/rollback/latest-batch дефекти й лише після цього
розділяти монолітний `stand-panel.work.mjs`.

Детальний аудит і план:
[`docs/2026-09-24-standwatch-full-review-and-refactor-plan.md`](docs/2026-09-24-standwatch-full-review-and-refactor-plan.md).

Контрольний runtime manifest:
[`docs/runtime-baseline-2026-09-24.md`](docs/runtime-baseline-2026-09-24.md).


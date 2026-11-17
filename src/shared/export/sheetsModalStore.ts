// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/exportToSheets.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type SheetsModalState =
  | { isOpen: false; rowCount: 0 }
  | { isOpen: true; rowCount: number };

const listeners = new Set<() => void>();
let state: SheetsModalState = { isOpen: false, rowCount: 0 };

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getSheetsModalState(): SheetsModalState {
  return state;
}

export function subscribeSheetsModal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openSheetsModal(rowCount: number): void {
  state = { isOpen: true, rowCount };
  emit();
}

export function closeSheetsModal(): void {
  state = { isOpen: false, rowCount: 0 };
  emit();
}

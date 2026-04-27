export function normalizeSearchTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\p{P}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Only this allowlist may leave the provider response or enter a metadata snapshot. */
export const metadataFields = [
  "id", "portalId", "name", "description", "parentFolderId", "folderName", "fileType", "extension",
  "author", "size", "source", "sourceId", "createdDate", "modifiedDate", "createdById", "createdByName",
  "createdByEmail", "modifiedById", "modifiedByName", "fileCreatedDate", "fileModifiedDate",
] as const;
export type MetadataField = typeof metadataFields[number];
export type FileMetadata = Partial<Record<MetadataField, string | number | null>> & { id: number; name: string };
const numericFields = new Set<MetadataField>(["id", "portalId", "parentFolderId", "size"]);
const dateFields = new Set<MetadataField>(["createdDate", "modifiedDate", "fileCreatedDate", "fileModifiedDate"]);

export function parseFileMetadata(value: unknown, expectedId: number): FileMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid file metadata response.");
  const input = value as Record<string, unknown>;
  if (input.id !== expectedId || !Number.isSafeInteger(expectedId) || expectedId < 1 ||
    typeof input.name !== "string" || !input.name) throw new Error("Invalid file metadata identity.");
  const result: Record<string, string | number | null> = {};
  for (const field of metadataFields) {
    const entry = input[field];
    if (entry === undefined) continue; // Missing is different from an explicit null.
    if (entry === null) { result[field] = null; continue; }
    if (numericFields.has(field)) {
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)
        throw new Error("Invalid numeric metadata field.");
    } else if (typeof entry !== "string" || entry.length > 100_000 ||
      (dateFields.has(field) && !Number.isFinite(Date.parse(entry)))) {
      throw new Error("Invalid text or date metadata field.");
    }
    result[field] = entry as string | number;
  }
  return result as FileMetadata;
}

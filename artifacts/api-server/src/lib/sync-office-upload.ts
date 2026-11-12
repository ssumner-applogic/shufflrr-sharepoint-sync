import type { UploadedFile } from "./sync-transfer";

interface StoredFile {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  parentId?: string;
  cTag?: string;
}

/** Only Open XML Office formats subject to SharePoint document-property processing. */
const officePackage = /\.(?:docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|ppsx|ppsm|potx|potm)$/i;

export async function confirmOfficeUpload<T extends StoredFile>(
  expected: { name: string; parentId: string; existingId?: string },
  completed: UploadedFile,
  readItem: (id: string) => Promise<T>,
): Promise<T | undefined> {
  if (!officePackage.test(expected.name) || completed.name !== expected.name ||
    (expected.existingId && completed.id !== expected.existingId)) return undefined;
  const stored = await readItem(completed.id);
  if (stored.id !== completed.id || stored.name !== expected.name || stored.isFolder ||
    stored.parentId !== expected.parentId || stored.size !== completed.size ||
    (completed.cTag && completed.cTag !== stored.cTag)) return undefined;
  // This confirms Graph's commit and canonical item, not byte-for-byte document equality.
  return stored;
}

export function uploadSizeNote(sourceBytes: number, storedBytes: number): string {
  const sizes = `Source bytes transferred: ${sourceBytes.toLocaleString("en-US")}. SharePoint stored bytes: ${storedBytes.toLocaleString("en-US")}.`;
  return sourceBytes === storedBytes ? sizes :
    `${sizes} SharePoint processed this Office document's properties; its stored size differs. This is not a byte-identical copy.`;
}

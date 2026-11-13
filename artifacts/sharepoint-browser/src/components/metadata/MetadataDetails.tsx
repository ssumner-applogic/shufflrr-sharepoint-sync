import type { FileMetadataRecord, SourceMetadata } from "@workspace/api-client-react";

type Field = { key: keyof SourceMetadata; label: string; kind?: "date" | "bytes" };
const groups: { title: string; fields: Field[] }[] = [
  { title: "Common", fields: [
    { key: "name", label: "Name" }, { key: "description", label: "Description" },
    { key: "id", label: "Shufflrr file ID" }, { key: "portalId", label: "Portal ID" },
    { key: "parentFolderId", label: "Parent folder ID" }, { key: "folderName", label: "Folder" },
    { key: "fileType", label: "File type" }, { key: "extension", label: "Extension" },
    { key: "author", label: "Author" }, { key: "size", label: "Size", kind: "bytes" },
    { key: "source", label: "Source" }, { key: "sourceId", label: "Source ID" },
  ] },
  { title: "Activity in Shufflrr", fields: [
    { key: "createdDate", label: "Created", kind: "date" },
    { key: "createdById", label: "Created by ID" }, { key: "createdByName", label: "Created by" },
    { key: "createdByEmail", label: "Created by email" },
    { key: "modifiedDate", label: "Modified", kind: "date" },
    { key: "modifiedById", label: "Modified by ID" }, { key: "modifiedByName", label: "Modified by" },
  ] },
  { title: "Original file dates", fields: [
    { key: "fileCreatedDate", label: "File created", kind: "date" },
    { key: "fileModifiedDate", label: "File modified", kind: "date" },
  ] },
];

function valueText(value: unknown, kind?: Field["kind"]): string {
  if (value === undefined) return "Not reported";
  if (value === null || value === "") return "Not provided";
  if (kind === "bytes" && typeof value === "number") return `${value.toLocaleString()} bytes`;
  if (kind === "date") {
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  return String(value);
}

export function MetadataDetails({ record }: { record: FileMetadataRecord }) {
  return (
    <div className="space-y-4" data-testid="panel-file-metadata">
      <div className="text-xs text-muted-foreground">
        <span className={record.stale ? "font-medium text-amber-700" : "font-medium text-primary"}>
          {record.stale ? "Stale snapshot" : "Current snapshot"}
        </span>
        {!record.mapped && <span> · No current sync mapping</span>}
        <p className="mt-1">Read-only Shufflrr source values. SharePoint native fields are not changed.</p>
      </div>
      {record.stale && <p className="text-xs text-amber-800">These values may be out of date. Review Metadata activity in Sync Agent for the latest refresh results.</p>}
      {!record.mapped && <p className="text-xs text-muted-foreground">This snapshot belongs to an earlier sync association.</p>}
      {record.lastError && <p className="text-xs text-destructive" role="alert">{record.lastError}</p>}
      {record.fields === null
        ? <p className="text-sm text-muted-foreground">No source metadata has been captured yet.</p>
        : groups.map(group => (
          <section key={group.title}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.title}</h3>
            <dl className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
              {group.fields.map(field => (
                <div key={field.key} className="contents">
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words">{valueText(record.fields?.[field.key], field.kind)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">App refresh and SharePoint association</h3>
        <dl className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          {([
            ["Observed", valueText(record.observedAt, "date")],
            ["Last attempt", valueText(record.lastAttemptAt, "date")],
            ["Source file ID", String(record.sourceFileId)],
            ["Drive ID", record.driveId], ["Item ID", record.itemId],
          ] as const).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

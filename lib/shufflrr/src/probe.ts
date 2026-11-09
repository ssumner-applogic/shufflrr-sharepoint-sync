import { randomUUID } from "node:crypto";
import { ShufflrrError, type Entry } from "./index";

export interface ProbeStep {
  name: string;
  status: "passed" | "failed" | "skipped";
  message: string;
}
export interface ProbeReport {
  ok: boolean;
  checkedAt: string;
  scope: string;
  cleanupOk: boolean;
  steps: ProbeStep[];
  advice: string[];
}
export interface ProbeClient {
  roots(): Promise<Entry[]>;
  contents(id: number): Promise<Entry[]>;
  createFolder(parentId: number, name: string): Promise<Entry>;
  rename(id: number, name: string, folder: boolean): Promise<void>;
  upload(folderId: number, name: string, contents: Blob): Promise<void>;
  download(id: number): Promise<Response>;
  remove(id: number, folder: boolean): Promise<void>;
}

export function probePdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 5\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return pdf + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

export async function probeAccess(
  client: ProbeClient,
  rootFolderId: number,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<ProbeReport> {
  const root = (await client.roots()).find(entry => entry.id === rootFolderId);
  if (!root) throw new ShufflrrError("permission", "Choose an accessible root folder.");
  const names = [
    "Read folder", "Create folder", "Read test folder", "Update folder",
    "Create file", "Read file", "Update file", "Delete file", "Delete folder",
  ];
  const report: ProbeReport = {
    ok: false, checkedAt: new Date().toISOString(), scope: root.name, cleanupOk: true,
    steps: names.map(name => ({ name, status: "skipped", message: "Waiting for previous checks." })),
    advice: ["Checks apply only to this selected folder and newly created test items, not every folder in the portal."],
  };
  const probeName = `shufflrr-access-probe-${randomUUID()}`;
  const updatedFolderName = probeName + "-updated";
  const fileName = probeName + ".pdf";
  const updatedFileName = probeName + "-updated.pdf";
  let created: Entry | undefined;
  let uploaded: Entry | undefined;
  let folderDeleted = false;
  let createAttempted = false;
  let ambiguousCreate = false;
  let index = 0;
  const passed = (message: string) => {
    Object.assign(report.steps[index++], { status: "passed", message });
  };
  const findFolder = async () => (await client.contents(rootFolderId)).find(entry =>
    entry.isFolder && (entry.name === probeName || entry.name === updatedFolderName));
  const requireFile = async (name: string, polls = 1): Promise<Entry> => {
    for (let attempt = 0; attempt < polls; attempt++) {
      const item = (await client.contents(created!.id)).find(entry => !entry.isFolder && entry.name === name);
      if (item) return item;
      if (attempt < polls - 1) await wait(1000);
    }
    throw new ShufflrrError("http", "The temporary file did not appear in the active folder listing before the verification timeout.");
  };
  try {
    await client.contents(rootFolderId);
    passed("Folder contents are readable.");
    createAttempted = true;
    created = await client.createFolder(rootFolderId, probeName);
    passed("Created an isolated temporary folder.");
    await client.contents(created.id);
    passed("Temporary folder contents are readable.");
    await client.rename(created.id, updatedFolderName, true);
    const renamedFolder = await findFolder();
    if (renamedFolder?.id !== created.id || renamedFolder.name !== updatedFolderName)
      throw new ShufflrrError("http", "Folder rename could not be verified.");
    passed("Renamed the temporary folder and verified its new name.");
    await client.upload(created.id, fileName, new Blob([probePdf()], { type: "application/pdf" }));
    uploaded = await requireFile(fileName, 30);
    passed("Uploaded a temporary PDF and verified its presence.");
    const download = await client.download(uploaded.id);
    const bytes = Buffer.from(await download.arrayBuffer());
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new ShufflrrError("schema", "The file download did not return the expected temporary PDF.");
    passed("Downloaded and verified the temporary PDF.");
    await client.rename(uploaded.id, updatedFileName, false);
    const renamed = await requireFile(updatedFileName);
    if (renamed.id !== uploaded.id) throw new ShufflrrError("schema", "File rename returned a different file.");
    passed("Renamed the temporary file and verified its new name.");
    await client.remove(uploaded.id, false);
    if ((await client.contents(created.id)).some(entry => entry.id === uploaded!.id && !entry.isFolder))
      throw new ShufflrrError("http", "File deletion could not be verified.");
    passed("Temporary file was deleted from active listings.");
    // Never recursively delete a folder if unexpected content has appeared in it.
    if ((await client.contents(created.id)).length)
      throw new ShufflrrError("permission", "Unexpected content appeared in the test folder; automatic folder deletion was stopped.");
    await client.remove(created.id, true);
    if (await findFolder()) throw new ShufflrrError("http", "Folder deletion could not be verified.");
    folderDeleted = true;
    passed("Temporary folder was deleted from active listings.");
  } catch (error) {
    ambiguousCreate = createAttempted && !created &&
      (!(error instanceof ShufflrrError) || !["permission", "authentication"].includes(error.code));
    Object.assign(report.steps[Math.min(index, report.steps.length - 1)], {
      status: "failed",
      message: error instanceof ShufflrrError ? error.message : "The temporary access check failed.",
    });
    report.advice.push("A denied operation requires a Shufflrr administrator to grant the service account the necessary folder and group rights. This app does not grant itself permissions.");
  } finally {
    if (createAttempted && !folderDeleted) {
      try {
        // Recover ambiguous creates by the cryptographically unique name only.
        const remaining = await findFolder();
        if (remaining) {
          if (created && remaining.id !== created.id) throw new Error("Unexpected probe folder identity");
          const children = await client.contents(remaining.id);
          if (children.some(entry => entry.isFolder || ![fileName, updatedFileName].includes(entry.name)))
            throw new Error("Unexpected content in probe folder");
          for (const child of children) await client.remove(child.id, false);
          if ((await client.contents(remaining.id)).length) throw new Error("File cleanup not confirmed");
          await client.remove(remaining.id, true);
          if (await findFolder()) throw new Error("Folder cleanup not confirmed");
        } else if (ambiguousCreate) {
          // A timed-out write might commit later; one empty listing cannot prove cleanup.
          throw new Error("The outcome of folder creation is unknown");
        }
      } catch {
        report.cleanupOk = false;
        report.advice.push(`Temporary test-item cleanup could not be confirmed. An administrator should inspect the folder named ${probeName} (or its -updated name). Do not delete unrelated content.`);
      }
    }
  }
  report.ok = report.cleanupOk && report.steps.every(step => step.status === "passed");
  return report;
}

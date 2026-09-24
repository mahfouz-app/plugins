// PDF export for Mahfouz (mahfouz/pdf): adds "PDF" to the Export dialog.
// Rendering is Slidev's (`slidev export`), reached through the Slidev
// plugin's API — this plugin declares it as a dependency, so it's installed
// and loaded even when the vault has Present off.

/** The save dialog's suggested file name for a note title. */
export function pdfFileName(title) {
  return `${(title || "Untitled").replace(/[\\/:*?"<>|]/g, "-")}.pdf`;
}

export async function activate(host) {
  const slidev = await host.use("mahfouz/slidev");
  host.registerExportFormat({
    id: "pdf",
    label: "PDF",
    async export({ note, content }, progress) {
      // A note's `orientation` attribute sets the page shape (the editor
      // toolbar's toggle and the Pages preview use the same one).
      const orientation = note.attributes.orientation === "portrait" ? "portrait" : "landscape";
      const path = await slidev.exportPdf(note, { orientation, content }, progress);
      return { path, suggestedName: pdfFileName(note.title), filter: { name: "PDF", extensions: ["pdf"] } };
    },
  });
}

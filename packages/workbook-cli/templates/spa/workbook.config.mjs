// What the build pipeline learns about your workbook. Slug becomes the
// output filename; type controls how the artifact behaves at runtime
// (document, notebook, or spa). See `workbook explain` for any rule.
export default {
  name: "%%NAME%%",
  slug: "%%SLUG%%",
  entry: "index.html",
  type: "spa",
  // Identity surfaces on (1) the workbooks.sh splash page when
  // shared via `workbook publish`, and (2) a small "about" chip
  // inside the running workbook so recipients see who made it
  // even when the file is opened standalone. Uncomment + fill in.
  // author: "Your name",
  // description: "One-sentence description of what this workbook does.",
};

// What the build pipeline learns about your workbook. Slug becomes the
// output filename; type controls how the artifact behaves at runtime
// (document, notebook, or spa). See `workbook explain` for any rule.
export default {
  name: "%%NAME%%",
  slug: "%%SLUG%%",
  entry: "index.html",
  type: "spa",
};

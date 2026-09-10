/* Fails fast if the toolchain is running on an unsupported Node. */
const major = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(major) && major < 18) {
  console.error(
    `Binary File Designer needs Node >= 18 (found ${process.versions.node}).`,
  );
  process.exit(1);
}

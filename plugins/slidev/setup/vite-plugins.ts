// Slidev loads this from the project root (this plugin's directory) with
// the run's resolved options. The plugins themselves are in ../harden.js
// and ../vault-files.js, which the tests import.
import { hardenPlugin } from "../harden.js";
import { vaultFilesPlugin } from "../vault-files.js";

export default (options: { entry: string; userRoot: string }) => [hardenPlugin(), vaultFilesPlugin(options)];

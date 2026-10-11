// Slidev loads this from the project root (this plugin's directory). The
// plugin itself is in ../harden.js, which the tests import.
import { hardenPlugin } from "../harden.js";

export default () => [hardenPlugin()];
